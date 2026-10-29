// Depot smart charging: the optimiser, departure guarantees, site limits and the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSlots, planDepot, schedulePeriods, type PlanSlot } from "../shared/energy/optimise";
import { cleanEnergy, depotTariffAsOcpi, type DepotVisit } from "../shared/energy/depot";
import { energyPriceAt } from "../shared/energy/price";
import { chargingProfiles, type DepotPlanView } from "../server/depot";
import { harness } from "./helpers";

const H = 3_600_000;
const t0 = Date.parse("2026-10-29T18:00:00Z");
// Price: £0.30 until midnight, £0.10 midnight–06:00, £0.30 after.
const price = (t: number) => { const h = new Date(t).getUTCHours(); return h < 6 ? 0.1 : 0.3; };

test("charges in the cheap hours and still meets every departure", () => {
  const slots = buildSlots(t0, t0 + 13 * H, price, () => null, 400);
  const plan = planDepot(slots, [
    { id: "a", chargerId: "c1", from: t0, to: t0 + 12 * H, needKwh: 300, maxKw: 150 },
    { id: "b", chargerId: "c2", from: t0, to: t0 + 12 * H, needKwh: 300, maxKw: 150 },
  ], [{ id: "c1", maxKw: 150 }, { id: "c2", maxKw: 150 }], "cost");
  for (const v of plan.visits) {
    assert.equal(v.shortfallKwh, 0);
    assert.ok(Math.abs(v.deliveredKwh - 300) < 0.01);
  }
  // All 600 kWh fit in the six cheap hours (2 × 150 kW × 6 h = 1800 kWh capacity).
  assert.ok(Math.abs(plan.cost - 600 * 0.1) < 0.01, `cost ${plan.cost}`);
  assert.ok(plan.baseline.cost > plan.cost, "charging on arrival costs more");
  assert.ok(plan.peakKw <= 400 + 1e-6);
});

test("site limit binds: the planner spreads charging and departure still comes first", () => {
  // 200 kW headroom; two trucks need 900 kWh each before 06:00 → must use expensive hours too.
  const slots = buildSlots(t0, t0 + 12 * H, price, () => null, 200);
  const plan = planDepot(slots, [
    { id: "a", chargerId: null, from: t0, to: t0 + 12 * H, needKwh: 900, maxKw: 150 },
    { id: "b", chargerId: null, from: t0, to: t0 + 12 * H, needKwh: 900, maxKw: 150 },
  ], [], "cost");
  assert.equal(plan.visits[0].shortfallKwh + plan.visits[1].shortfallKwh, 0);
  for (const kw of plan.totalKw) assert.ok(kw <= 200 + 1e-6, `slot over the limit: ${kw}`);
});

test("impossible demands are flagged with the shortfall, not silently dropped", () => {
  const slots = buildSlots(t0, t0 + 2 * H, price, () => null, 1000);
  const plan = planDepot(slots, [{ id: "a", chargerId: null, from: t0, to: t0 + 2 * H, needKwh: 500, maxKw: 150 }], [], "cost");
  assert.ok(Math.abs(plan.visits[0].deliveredKwh - 300) < 0.01);
  assert.ok(Math.abs(plan.visits[0].shortfallKwh - 200) < 0.01);
});

test("a shared charger serves trucks one after another", () => {
  const slots = buildSlots(t0, t0 + 6 * H, () => 0.2, () => null, 1000);
  const plan = planDepot(slots, [
    { id: "a", chargerId: "c1", from: t0, to: t0 + 3 * H, needKwh: 300, maxKw: 150 },
    { id: "b", chargerId: "c1", from: t0 + 2 * H, to: t0 + 6 * H, needKwh: 300, maxKw: 150 },
  ], [{ id: "c1", maxKw: 150 }], "cost");
  plan.slots.forEach((_, j) => assert.ok(plan.visits[0].kw[j] + plan.visits[1].kw[j] <= 150 + 1e-6));
  assert.equal(plan.visits[0].shortfallKwh + plan.visits[1].shortfallKwh, 0);
});

test("the carbon goal prefers cleaner hours at equal price", () => {
  const carbon = (t: number) => (new Date(t).getUTCHours() >= 2 && new Date(t).getUTCHours() < 4 ? 50 : 200);
  const slots = buildSlots(t0, t0 + 12 * H, () => 0.2, carbon, 500);
  const plan = planDepot(slots, [{ id: "a", chargerId: null, from: t0, to: t0 + 12 * H, needKwh: 300, maxKw: 150 }], [], "carbon");
  const kwh = (from: number, to: number) => plan.slots.reduce((a, s, j) => a + (s.start >= from && s.end <= to ? plan.visits[0].kw[j] * (s.end - s.start) / H : 0), 0);
  assert.ok(Math.abs(kwh(Date.parse("2026-10-30T02:00:00Z"), Date.parse("2026-10-30T04:00:00Z")) - 300) < 0.01);
});

test("schedule periods merge equal limits and are in watts from the start", () => {
  const slots: PlanSlot[] = [0, 1, 2, 3].map((i) => ({ start: t0 + i * H / 2, end: t0 + (i + 1) * H / 2, price: 0.1, carbon: null, headroomKw: 100 }));
  assert.deepEqual(schedulePeriods(slots, [0, 0, 50, 50], t0), [{ startPeriod: 0, limit: 0 }, { startPeriod: 3600, limit: 50000 }]);
});

test("settings are validated: bad control addresses and times are dropped", () => {
  const c = cleanEnergy({ depots: [{ name: "Yard", import_limit_kw: "400", tariff: { kind: "tou", standard: 0.2, rates: [{ price: 0.1, start: "25:00", end: "07:00" }, { price: 0.12, start: "00:30", end: "07:30" }] }, control: { kind: "citrineos", base_url: "http://insecure" }, chargers: [{ name: "Bay 1", max_kw: 150 }] }] });
  const d = c.depots[0];
  assert.equal(d.import_limit_kw, 400);
  assert.equal(d.tariff.rates.length, 1);
  assert.equal(d.control.kind, "simulated");
  assert.equal(d.chargers[0].station_id, "CS1");
  assert.equal(energyPriceAt(depotTariffAsOcpi(d.tariff), new Date("2026-10-30T03:00:00Z")), 0.12);
});

test("OCPP profiles: one per charger in use, TxDefaultProfile, ending at the horizon", () => {
  const slots = buildSlots(t0, t0 + 2 * H, () => 0.2, () => null, 1000);
  const depot = cleanEnergy({ depots: [{ id: "d", chargers: [{ id: "c1", name: "Bay 1", station_id: "CP01", evse_id: 1, max_kw: 150 }, { id: "c2", name: "Bay 2", max_kw: 150 }] }] }).depots[0];
  const view = { slots, visits: [{ visit: { charger_id: "c1" } as DepotVisit, plan: { kw: slots.map((_, j) => (j < 2 ? 100 : 0)) } }] } as unknown as DepotPlanView;
  const p = chargingProfiles(depot, view);
  assert.equal(p.length, 1);
  const cp = p[0].request.chargingProfile as { chargingProfilePurpose: string; chargingSchedule: { duration: number; chargingSchedulePeriod: { startPeriod: number; limit: number }[] }[] };
  assert.equal(cp.chargingProfilePurpose, "TxDefaultProfile");
  assert.equal(cp.chargingSchedule[0].duration, 7200);
  assert.deepEqual(cp.chargingSchedule[0].chargingSchedulePeriod, [{ startPeriod: 0, limit: 100000 }, { startPeriod: 3600, limit: 0 }]);
});

test("API: owners set up a depot, planners add visits, everyone sees the plan", async () => {
  const h = await harness("2026-10-29T15:00:00Z");
  const vehicles = (await h.api<{ id: string; name: string }[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  const put = await h.api("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { depots: [{ id: "yard", name: "Yard", postcode: "NN4 7AB", import_limit_kw: 300, site_load_kw: 50, tariff: { kind: "tou", standard: 0.25, rates: [{ price: 0.12, start: "00:30", end: "07:30" }] }, chargers: [{ id: "b1", name: "Bay 1", max_kw: 150 }, { id: "b2", name: "Bay 2", max_kw: 150 }] }] }, secrets: { yard: "token-123" } });
  assert.equal(put.status, 200);
  const got = await h.api<{ has_secret: Record<string, boolean> }>("GET", `/api/fleets/${h.fleetId}/energy`);
  assert.equal(got.data.has_secret.yard, true);
  assert.ok(!JSON.stringify(got.data).includes("token-123"));
  const t1 = vehicles.find((v) => v.name === "Tractor 02")!.id;
  const r3 = vehicles.find((v) => v.name === "Rigid 03")!.id;
  const a = await h.api<DepotVisit>("POST", `/api/fleets/${h.fleetId}/depot-visits`, { depot_id: "yard", vehicle_id: t1, charger_id: "b1", arrive_at: "2026-10-29T18:00:00Z", depart_at: "2026-10-30T05:00:00Z", soc_start: 20, soc_target: 90 });
  assert.equal(a.status, 201);
  const clash = await h.api("POST", `/api/fleets/${h.fleetId}/depot-visits`, { depot_id: "yard", vehicle_id: r3, charger_id: "b1", arrive_at: "2026-10-29T20:00:00Z", depart_at: "2026-10-30T02:00:00Z", soc_start: 20, soc_target: 90 });
  assert.equal(clash.status, 409);
  await h.api("POST", `/api/fleets/${h.fleetId}/depot-visits`, { depot_id: "yard", vehicle_id: r3, charger_id: "b2", arrive_at: "2026-10-29T19:00:00Z", depart_at: "2026-10-30T06:00:00Z", soc_start: 50, soc_target: 100 });
  const plan = await h.api<DepotPlanView & { dispatch: unknown }>("GET", `/api/fleets/${h.fleetId}/depots/yard/plan`);
  assert.equal(plan.status, 200);
  assert.equal(plan.data.visits.length, 2);
  for (const v of plan.data.visits) assert.equal(v.outcome, "ready");
  assert.ok(plan.data.cost < plan.data.baseline.cost);
  for (const kw of plan.data.total_kw) assert.ok(kw <= 250 + 1e-6);
  const sent = await h.api<{ ok: boolean; results: { charger_id: string }[] }>("POST", `/api/fleets/${h.fleetId}/depots/yard/dispatch`);
  assert.equal(sent.status, 200);
  assert.equal(sent.data.ok, true);
  assert.equal(sent.data.results.length, 2);
});
