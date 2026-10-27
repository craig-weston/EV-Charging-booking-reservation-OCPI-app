// Fleet API keys: a fleet's own systems (TMS, dispatch, autonomy platforms) book without a person signing in.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApiKey, AuditEntry, BookingRow, NetworkSnapshot, Vehicle } from "../shared/model";
import { suggestSlots } from "../shared/booking/slots";
import { dispatch } from "../server/dispatch";
import { harness, type Harness } from "./helpers";

type Created = ApiKey & { key: string };

/** Calls the API with an API key instead of the signed-in test user. */
function withKey(h: Harness, key: string, header: "bearer" | "x-api-key" = "bearer") {
  return async <T = unknown>(method: string, path: string, body?: unknown) => {
    const auth = header === "bearer" ? { Authorization: `Bearer ${key}` } : { "X-API-Key": key };
    const res = await dispatch(new Request(h.ctx.baseUrl + path, { method, headers: { "Content-Type": "application/json", ...auth }, body: body === undefined ? undefined : JSON.stringify(body) }), h.ctx);
    const json = (await res.json()) as { data: T; error?: { message: string; code?: string } };
    return { status: res.status, data: json.data, error: json.error };
  };
}

test("an owner creates a key, it is shown once and only its hash is stored", async () => {
  const h = await harness();
  const r = await h.api<Created>("POST", `/api/fleets/${h.fleetId}/api-keys`, { name: "Dispatch TMS", role: "planner", expires_in_days: 90 });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  assert.match(r.data.key, /^fck_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.data.key_hint, `…${r.data.key.slice(-4)}`);
  assert.equal(r.data.expires_at, "2027-01-19T07:00:00Z");
  const stored = h.store.data.apiKeys[0];
  assert.notEqual(stored.key_hash, r.data.key);
  assert.ok(!JSON.stringify(h.store.data).includes(r.data.key), "the key itself is never stored");
  const list = await h.api<ApiKey[]>("GET", `/api/fleets/${h.fleetId}/api-keys`);
  assert.equal(list.data.length, 1);
  assert.ok(!("key" in list.data[0]) && !("key_hash" in list.data[0]), "listing shows neither the key nor its hash");
  const audit = await h.api<AuditEntry[]>("GET", `/api/fleets/${h.fleetId}/audit`);
  assert.ok(audit.data.some((a) => a.action === "api_key.create" && a.target === "Dispatch TMS"));

  assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/api-keys`, { name: "" })).status, 400);
  assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/api-keys`, { name: "x", expires_in_days: 5000 })).status, 400);
});

test("a planner key books a slot end to end, and is recorded as the booker", async () => {
  const h = await harness();
  assert.equal((await h.api("POST", "/api/admin/simulator/connect")).status, 201);
  const { data: created } = await h.api<Created>("POST", `/api/fleets/${h.fleetId}/api-keys`, { name: "Autonomy platform", role: "planner" });
  const tms = withKey(h, created.key);

  const net = await tms<NetworkSnapshot>("GET", "/api/network");
  assert.equal(net.status, 200);
  const vehicles = await tms<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`);
  assert.equal(vehicles.status, 200);
  const v = vehicles.data.find((x) => x.plate === "PN74 EVH")!;
  const bl = net.data.booking_locations.find((b) => b.id === "VHL-LUT-CCS")!.data;
  const slot = suggestSlots(bl, new Date("2026-10-21T13:00:00Z"), 45, h.clock.now, { count: 1 })[0];
  const r = await tms<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings`, {
    vehicle_id: v.id, cpo_country_code: bl.country_code, cpo_party_id: bl.party_id, booking_location_id: bl.id,
    start_at: slot.start.toISOString(), end_at: slot.end.toISOString(),
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  assert.equal(r.data.created_by, null);
  assert.equal(r.data.created_by_key, created.id);
  const listed = await tms<{ bookings: BookingRow[] }>("GET", `/api/fleets/${h.fleetId}/bookings`);
  assert.ok(listed.data.bookings.some((b) => b.id === r.data.id));
  // The X-API-Key header works too.
  assert.equal((await withKey(h, created.key, "x-api-key")("GET", `/api/fleets/${h.fleetId}/vehicles`)).status, 200);
});

test("keys stay inside their fleet and their role, and stop working when revoked or expired", async () => {
  const h = await harness();
  const { data: viewer } = await h.api<Created>("POST", `/api/fleets/${h.fleetId}/api-keys`, { name: "Reporting", role: "viewer", expires_in_days: 1 });
  const ro = withKey(h, viewer.key);
  assert.equal((await ro("GET", `/api/fleets/${h.fleetId}/vehicles`)).status, 200);
  const write = await ro("POST", `/api/fleets/${h.fleetId}/drivers`, { name: "Sam" });
  assert.equal(write.status, 403);

  // Out of scope: team, settings, exports, admin, other fleets, managing keys.
  for (const [m, p] of [["GET", `/api/fleets/${h.fleetId}/team`], ["GET", `/api/fleets/${h.fleetId}/export`], ["GET", `/api/fleets/${h.fleetId}/audit`],
    ["PATCH", `/api/fleets/${h.fleetId}`], ["GET", "/api/admin/partners"], ["GET", "/api/me"], ["GET", `/api/fleets/${h.fleetId}/api-keys`],
    ["GET", "/api/fleets/some-other-fleet/vehicles"], ["POST", "/api/fleets"]] as const) {
    const r = await ro(m, p, m === "GET" ? undefined : {});
    assert.equal(r.status, 403, `${m} ${p} should be refused`);
    assert.equal(r.error?.code, "API_KEY_SCOPE");
  }

  // Unknown, malformed, expired and revoked keys are refused with the same answer.
  assert.equal((await withKey(h, `fck_${"A".repeat(43)}`)("GET", `/api/fleets/${h.fleetId}/vehicles`)).error?.code, "INVALID_API_KEY");
  assert.equal((await withKey(h, "nonsense", "x-api-key")("GET", `/api/fleets/${h.fleetId}/vehicles`)).status, 401);
  h.clock.now = new Date("2026-10-22T07:00:01Z");
  assert.equal((await ro("GET", `/api/fleets/${h.fleetId}/vehicles`)).status, 401, "expired");

  const { data: tms } = await h.api<Created>("POST", `/api/fleets/${h.fleetId}/api-keys`, { name: "TMS" });
  assert.equal((await withKey(h, tms.key)("GET", `/api/fleets/${h.fleetId}/vehicles`)).status, 200);
  assert.equal((await h.api("DELETE", `/api/fleets/${h.fleetId}/api-keys/${tms.id}`)).status, 200);
  assert.equal((await withKey(h, tms.key)("GET", `/api/fleets/${h.fleetId}/vehicles`)).status, 401, "revoked");
  const list = await h.api<ApiKey[]>("GET", `/api/fleets/${h.fleetId}/api-keys`);
  assert.ok(list.data.find((k) => k.id === tms.id)?.revoked_at);
});
