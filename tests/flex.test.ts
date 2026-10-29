// Grid flexibility: what a depot can commit, the signed aggregator API, delivery, settlement and
// credits on the monthly statement.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlexEvent } from "../shared/energy/flex";
import type { FleetStatement } from "../shared/model";
import { newEvent } from "../shared/energy/flex";
import { buildSlots } from "../shared/energy/optimise";
import { assessEvent, closeEndedEvents } from "../server/flex";
import type { PlanInputs } from "../server/depot";
import { signature } from "../server/webhooks";
import { harness, type Harness } from "./helpers";

const H = 3_600_000;
const t0 = Date.parse("2026-10-29T18:00:00Z");

function inputs(needKwh: number, headroom = 300): PlanInputs {
  const slots = buildSlots(t0, t0 + 12 * H, (t) => (new Date(t).getUTCHours() < 7 ? 0.13 : 0.24), () => null, headroom);
  return {
    depot: { id: "d", goal: "cost" } as PlanInputs["depot"], now: t0, slots, headroom,
    rows: [{ v: { id: "v1", charger_id: null, arrive_at: new Date(t0).toISOString(), depart_at: new Date(t0 + 12 * H).toISOString() } as PlanInputs["rows"][number]["v"], veh: null, battery: 600, maxKw: 150, need: needKwh }],
    chargers: [], carbonSource: null, priceSource: "tariff",
  };
}
const ev = (start: string, end: string, direction: "down" | "up" = "down", price = 600): FlexEvent =>
  newEvent({ id: "e1", fleet_id: "f", depot_id: "d", provider_event_id: null, programme: "DNO", direction, start_at: start, end_at: end, price_per_mwh: price, requested_kw: null, source: "simulated" }, new Date(t0));

test("turn-down with slack: the whole planned load in the window is committed and the truck is still full", () => {
  // 300 kWh, cheapest at 00:00–07:00 (7 h × 150 kW available): an hour can be given up easily.
  const r = assessEvent(inputs(300), [], ev("2026-10-30T00:00:00Z", "2026-10-30T01:00:00Z"));
  assert.ok(r.committed_kw >= 140, `committed ${r.committed_kw}`);
  assert.equal(r.cap_kw, 0);
  assert.equal(r.reason, null);
});

test("turn-down when tight: only part is committed, keeping the departure", () => {
  // 1700 kWh over 12 h at up to 150 kW (1800 max): only ~100 kWh of slack in total.
  const r = assessEvent(inputs(1700), [], ev("2026-10-30T00:00:00Z", "2026-10-30T02:00:00Z"));
  assert.ok(r.committed_kw > 0 && r.committed_kw <= 60, `committed ${r.committed_kw}`);
  assert.ok((r.cap_kw ?? 0) >= 90);
});

test("turn-down with nothing planned then is declined with a reason", () => {
  const r = assessEvent(inputs(100), [], ev("2026-10-29T19:00:00Z", "2026-10-29T20:00:00Z"));
  assert.equal(r.committed_kw, 0);
  assert.match(r.reason!, /Nothing is planned/);
});

test("turn-up pulls charging into a paid window", () => {
  // Normally all at night (0.13); paid £150/MWh at 20:00–21:00 makes 0.24 − 0.15 = 0.09 cheaper.
  const r = assessEvent(inputs(300), [], ev("2026-10-29T20:00:00Z", "2026-10-29T21:00:00Z", "up", 150));
  assert.ok(r.committed_kw >= 140, `extra ${r.committed_kw}`);
});

async function setupDepot(h: Harness, provider: "simulated" | "aggregator", flexOn = true) {
  const vehicles = (await h.api<{ id: string; name: string }[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  const put = await h.api("PUT", `/api/fleets/${h.fleetId}/energy`, {
    config: { depots: [{ id: "yard", name: "Yard", postcode: "NN4 7AB", import_limit_kw: 400, site_load_kw: 50, goal: "cost", tariff: { kind: "tou", standard: 0.24, rates: [{ price: 0.13, start: "00:30", end: "07:30" }] }, chargers: [{ id: "b1", name: "Bay 1", max_kw: 150 }], flex: { enabled: flexOn, programmes: ["DFS", "DNO"], auto_accept: true, min_price_mwh: 100 } }], flex_provider: provider === "aggregator" ? { kind: "aggregator", name: "Agg", report_url: "https://agg.example/reports" } : { kind: "simulated" } },
    secrets: provider === "aggregator" ? { flex: "flex-secret-123" } : undefined,
  });
  assert.equal(put.status, 200, JSON.stringify(put.error));
  const t = vehicles.find((v) => v.name === "Tractor 02")!.id;
  await h.api("POST", `/api/fleets/${h.fleetId}/depot-visits`, { depot_id: "yard", vehicle_id: t, charger_id: "b1", arrive_at: "2026-10-29T18:00:00Z", depart_at: "2026-10-30T07:00:00Z", soc_start: 30, soc_target: 80 });
}

async function signed(h: Harness, path: string, body: unknown, secret = "flex-secret-123") {
  const text = JSON.stringify(body);
  const { dispatch } = await import("../server/dispatch");
  const res = await dispatch(new Request(h.ctx.baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json", "Depotcharge-Signature": await signature(secret, text, h.clock.now) }, body: text }), h.ctx);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

test("aggregator API: signed events are assessed and committed; bad signatures are refused", async () => {
  const h = await harness("2026-10-29T15:00:00Z");
  await setupDepot(h, "aggregator");
  const offer = { event_id: "AGG-1", depot_id: "yard", programme: "DNO", direction: "down", start: "2026-10-30T01:00:00Z", end: "2026-10-30T02:00:00Z", price_per_mwh: 600 };
  const bad = await signed(h, `/api/flex/${h.fleetId}/events`, offer, "wrong");
  assert.equal(bad.status, 401);
  const ok = await signed(h, `/api/flex/${h.fleetId}/events`, offer);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.accepted, true);
  assert.ok((ok.data.committed_kw as number) >= 100);
  // Idempotent on the aggregator's id.
  const again = await signed(h, `/api/flex/${h.fleetId}/events`, offer);
  assert.equal(again.data.id, ok.data.id);
  // The plan avoids the window.
  const plan = await h.api<{ total_kw: number[]; slots: { start: number }[]; visits: { outcome: string }[] }>("GET", `/api/fleets/${h.fleetId}/depots/yard/plan`);
  plan.data.slots.forEach((s, j) => { if (s.start >= Date.parse(offer.start) && s.start < Date.parse(offer.end)) assert.ok(plan.data.total_kw[j] <= (300 - (ok.data.committed_kw as number)) + 1); });
  assert.equal(plan.data.visits[0].outcome, "ready");
  // Below the minimum price: declined.
  const cheap = await signed(h, `/api/flex/${h.fleetId}/events`, { ...offer, event_id: "AGG-2", price_per_mwh: 20 });
  assert.equal(cheap.data.accepted, false);
  assert.match(String(cheap.data.reason), /minimum/);
});

test("after the event: delivered with an estimated credit, then the aggregator settles; the statement shows it", async () => {
  const h = await harness("2026-10-29T15:00:00Z");
  await setupDepot(h, "aggregator");
  const ok = await signed(h, `/api/flex/${h.fleetId}/events`, { event_id: "AGG-9", depot_id: "yard", programme: "DFS", direction: "down", start: "2026-10-30T01:00:00Z", end: "2026-10-30T02:00:00Z", price_per_mwh: 1000 });
  assert.equal(ok.data.accepted, true);
  h.clock.now = new Date("2026-10-30T03:00:00Z");
  assert.equal(await closeEndedEvents(h.ctx, h.fleetId), 1);
  let e = (await h.store.getFlexEvent(String(ok.data.id)))!;
  assert.equal(e.status, "delivered");
  assert.equal(e.estimated, true);
  assert.ok((e.fleet_credit_gbp ?? 0) > 0);
  const st = await signed(h, `/api/flex/${h.fleetId}/events/AGG-9/settlement`, { payment_gbp: 150, delivered_kwh: 150 });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  e = (await h.store.getFlexEvent(String(ok.data.id)))!;
  assert.equal(e.status, "settled");
  assert.equal(e.fleet_credit_gbp, 120); // 80% default share
  const s = await h.api<FleetStatement>("GET", `/api/fleets/${h.fleetId}/statements/2026-10`);
  assert.equal(s.status, 200);
  assert.equal(s.data.credits.length, 1);
  assert.equal(s.data.totals.credits, 120);
  assert.equal(s.data.totals.due, Math.round((s.data.totals.gross - 120) * 100) / 100);
});

test("simulator and manual decisions: offered events wait for a planner; depots not taking part decline", async () => {
  const h = await harness("2026-10-29T15:00:00Z");
  await setupDepot(h, "simulated");
  const r = await h.api<FlexEvent>("POST", `/api/fleets/${h.fleetId}/flex/simulate`, { depot_id: "yard", kind: "dno", accept: false });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  assert.equal(r.data.status, "offered");
  const acc = await h.api<FlexEvent>("POST", `/api/fleets/${h.fleetId}/flex/${r.data.id}/accept`);
  assert.equal(acc.data.status, "accepted");
  assert.ok((acc.data.committed_kw ?? 0) > 0);
  const again = await h.api("POST", `/api/fleets/${h.fleetId}/flex/${r.data.id}/decline`);
  assert.equal(again.status, 409);
  const list = await h.api<FlexEvent[]>("GET", `/api/fleets/${h.fleetId}/flex/events`);
  assert.equal(list.data.length, 1);

  const h2 = await harness("2026-10-29T15:00:00Z");
  await setupDepot(h2, "simulated", false);
  const off = await h2.api("POST", `/api/fleets/${h2.fleetId}/flex/simulate`, { depot_id: "yard", kind: "dno" });
  assert.equal(off.status, 409);
});
