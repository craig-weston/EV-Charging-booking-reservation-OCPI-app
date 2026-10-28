// Webhooks to a fleet's own systems: signed deliveries on booking changes, owners only, safe URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingRow, FleetWebhook, NetworkSnapshot, Vehicle } from "../shared/model";
import { suggestSlots } from "../shared/booking/slots";
import { MAX_FAILURES, deliver, hmacHex, signature } from "../server/webhooks";
import { harness, type Harness } from "./helpers";

type Got = { type: string; sig: string; body: string; json: { type: string; fleet_id: string; data: { booking?: { id: string; status: string; plate: string }; event?: { kind: string } } } };

async function setup(status = 200) {
  const h = await harness();
  const got: Got[] = [];
  let answer = status;
  const inner = h.ctx.transport.bind(h.ctx);
  h.ctx.transport = async (req) => {
    if (new URL(req.url).hostname === "tms.example.com") {
      const body = await req.text();
      got.push({ type: req.headers.get("Depotcharge-Event")!, sig: req.headers.get("Depotcharge-Signature")!, body, json: JSON.parse(body) });
      return new Response("ok", { status: answer });
    }
    return inner(req);
  };
  assert.equal((await h.api("POST", "/api/admin/simulator/connect")).status, 201);
  return { h, got, setAnswer: (s: number) => { answer = s; } };
}

async function book(h: Harness): Promise<BookingRow> {
  const net = (await h.api<NetworkSnapshot>("GET", "/api/network")).data;
  const bl = net.booking_locations.find((b) => b.id === "VHL-LUT-CCS")!.data;
  const [vehicle] = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  const slot = suggestSlots(bl, new Date("2026-10-21T13:00:00Z"), 60, h.clock.now, { count: 1 })[0];
  const r = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings`, {
    vehicle_id: vehicle.id, cpo_country_code: bl.country_code, cpo_party_id: bl.party_id, booking_location_id: bl.id,
    start_at: slot.start.toISOString(), end_at: slot.end.toISOString(),
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  await h.ctx.flush();
  return r.data;
}

const verify = async (secret: string, g: Got) => {
  const [t, v1] = g.sig.split(",").map((p) => p.split("=")[1]);
  return v1 === (await hmacHex(secret, `${t}.${g.body}`));
};

test("signature: t=<seconds>,v1=<HMAC-SHA256 of t.body>", async () => {
  const s = await signature("whsec_test", '{"a":1}', new Date("2026-10-28T12:00:00Z"));
  assert.equal(s, `t=1793188800,v1=${await hmacHex("whsec_test", '1793188800.{"a":1}')}`);
});

test("owners add a webhook; the secret is shown once; booking changes arrive signed", async () => {
  const { h, got } = await setup();
  const r = await h.api<FleetWebhook & { secret: string }>("POST", `/api/fleets/${h.fleetId}/webhooks`, { url: "https://tms.example.com/hooks/dc", description: "Dispatch" });
  assert.equal(r.status, 201, r.error?.message);
  const secret = r.data.secret;
  assert.match(secret, /^whsec_/);
  const list = await h.api<FleetWebhook[]>("GET", `/api/fleets/${h.fleetId}/webhooks`);
  assert.equal(list.data.length, 1);
  assert.equal("secret" in list.data[0], false, "secret never listed");
  assert.ok(list.data[0].secret_hint.startsWith("…"));
  assert.ok(h.store.data.audit.some((a) => a.action === "webhook.create"));

  const b = await book(h);
  const types = got.map((g) => g.type);
  assert.ok(types.includes("booking.requested"), types.join());
  assert.ok(types.includes("booking.confirmed"), types.join());
  for (const g of got) {
    assert.ok(await verify(secret, g), "signature verifies");
    assert.equal(g.json.fleet_id, h.fleetId);
    assert.equal(g.json.data.booking!.id, b.id);
  }
  const confirmed = got.find((g) => g.type === "booking.confirmed")!;
  assert.equal(confirmed.json.data.booking!.status, "RESERVED");

  // Cancel → booking.cancelled.
  await h.api("POST", `/api/fleets/${h.fleetId}/bookings/${b.id}/cancel`, { reason: "TRAFFIC" });
  await h.ctx.flush();
  assert.ok(got.some((g) => g.type === "booking.cancelled"));

  // Test delivery.
  const t = await h.api<{ ok: boolean; status: number }>("POST", `/api/fleets/${h.fleetId}/webhooks/${r.data.id}/test`);
  assert.deepEqual([t.data.ok, t.data.status], [true, 200]);
  assert.equal(got.at(-1)!.type, "webhook.test");
});

test("event filter: only the events asked for", async () => {
  const { h, got } = await setup();
  await h.api("POST", `/api/fleets/${h.fleetId}/webhooks`, { url: "https://tms.example.com/x", events: ["booking.cancelled"] });
  const b = await book(h);
  assert.equal(got.length, 0);
  await h.api("POST", `/api/fleets/${h.fleetId}/bookings/${b.id}/cancel`, { reason: "TRAFFIC" });
  await h.ctx.flush();
  assert.deepEqual(got.map((g) => g.type), ["booking.cancelled"]);
  assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/webhooks`, { url: "https://tms.example.com/y", events: ["everything"] })).status, 400);
});

test("failing endpoints are retried once, then switched off after repeated failures", async () => {
  const { h, got, setAnswer } = await setup(500);
  const r = await h.api<FleetWebhook>("POST", `/api/fleets/${h.fleetId}/webhooks`, { url: "https://tms.example.com/down" });
  const row = (await h.store.listWebhooks(h.fleetId))[0];
  const d = { id: "d1", type: "webhook.test" as const, created_at: "x", fleet_id: h.fleetId, data: {} };
  const once = await deliver(h.ctx, row, d);
  assert.deepEqual([once.ok, once.status, got.length], [false, 500, 2], "one retry");
  for (let i = 1; i < MAX_FAILURES; i++) await deliver(h.ctx, (await h.store.listWebhooks(h.fleetId))[0], d);
  const off = (await h.store.listWebhooks(h.fleetId))[0];
  assert.equal(off.active, false);
  assert.equal(off.failures, MAX_FAILURES);
  assert.equal(off.last_error, "HTTP 500");
  // Switching it back on resets the count.
  setAnswer(204);
  const on = await h.api<FleetWebhook>("PATCH", `/api/fleets/${h.fleetId}/webhooks/${r.data.id}`, { active: true });
  assert.deepEqual([on.data.active, on.data.failures], [true, 0]);
  assert.equal((await h.api("DELETE", `/api/fleets/${h.fleetId}/webhooks/${r.data.id}`)).status, 200);
  assert.equal((await h.store.listWebhooks(h.fleetId)).length, 0);
});

test("webhook addresses must be public https; owners only; at most five", async () => {
  const { h } = await setup();
  for (const url of ["http://tms.example.com/x", "https://10.0.0.5/x", "https://localhost/x", "https://user:pw@tms.example.com/x", "nonsense"]) {
    assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/webhooks`, { url })).status, 400, url);
  }
  for (let i = 0; i < 5; i++) assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/webhooks`, { url: `https://tms.example.com/${i}` })).status, 201);
  assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/webhooks`, { url: "https://tms.example.com/6" })).status, 409);
  h.store.data.members.find((m) => m.fleet_id === h.fleetId && m.user_id === h.userId)!.role = "planner";
  assert.equal((await h.api("GET", `/api/fleets/${h.fleetId}/webhooks`)).status, 403);
});
