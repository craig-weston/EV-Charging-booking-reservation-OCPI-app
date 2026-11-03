// Vehicle-to-grid pilot: give back at peak, recharge off-peak, never below the minimum charge,
// still full at departure, and behind the meter only offsets the site's own load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSlots, planDepot } from "../shared/energy/optimise";
import { DEFAULT_V2G, cleanV2g, v2gPass } from "../shared/energy/v2g";
import { chargingProfiles, type DepotPlanView } from "../server/depot";
import { cleanEnergy, type DepotVisit } from "../shared/energy/depot";

const H = 3_600_000;
const t0 = Date.parse("2026-10-29T16:00:00Z"); // GMT: 16:00 local, peak
const price = (t: number) => { const h = new Date(t).getUTCHours(); return h >= 16 && h < 19 ? 0.34 : h < 7 ? 0.13 : 0.24; };

function scenario(socStart: number, mode: "behind_meter" | "export" = "behind_meter", wear = 0.06) {
  const slots = buildSlots(t0, t0 + 15 * H, price, () => null, 340);
  const battery = 315, need = ((100 - socStart) / 100) * battery / 0.93;
  const plan = planDepot(slots, [{ id: "r", chargerId: "b4", from: t0, to: t0 + 15 * H, needKwh: need, maxKw: 150 }], [{ id: "b4", maxKw: 150 }], "cost");
  const cfg = { ...DEFAULT_V2G, enabled: true, vehicle_ids: ["x"], warranty_confirmed: true, mode, export_limit_kw: mode === "export" ? 100 : 0, wear_per_kwh: wear };
  const r = v2gPass(plan, slots, [{ index: 0, from: t0, to: t0 + 15 * H, batteryKwh: battery, socStart, maxChargeKw: 150, maxDischargeKw: 100 }], cfg, 60);
  return { slots, plan, r, battery, socStart };
}

test("gives back at the evening peak and recharges at night", () => {
  const { slots, plan, r } = scenario(72);
  assert.ok(r.dischargedKwh > 50, `gave back ${r.dischargedKwh}`);
  assert.ok(r.net > 0);
  plan.visits[0].kw.forEach((kw, j) => { if (kw < 0) assert.ok(price(slots[j].start) === 0.34, "only at the peak"); });
  // Behind the meter: never more than the 60 kW site load.
  plan.visits[0].kw.forEach((kw) => assert.ok(kw >= -60 - 1e-6, `gave back ${kw} kW`));
});

test("never below the minimum charge, and still full at departure", () => {
  const { slots, plan, r, battery, socStart } = scenario(72);
  let e = (socStart / 100) * battery;
  for (let j = 0; j < slots.length; j++) {
    const kw = plan.visits[0].kw[j], h = (slots[j].end - slots[j].start) / H;
    e += kw >= 0 ? kw * h * 0.93 : (kw * h) / 0.93;
    assert.ok(e >= 0.35 * battery - 0.5, `dropped to ${(e / battery) * 100}%`);
  }
  assert.ok(e >= battery - 1, `left with ${(e / battery) * 100}%`);
  assert.ok(r.minSocReached! >= 34.9);
});

test("export mode can give back faster than the site load allows; high wear stops it altogether", () => {
  const site = scenario(80, "behind_meter");
  const exp = scenario(80, "export");
  assert.ok(Math.min(...site.plan.visits[0].kw) >= -60 - 1e-6);
  assert.ok(Math.min(...exp.plan.visits[0].kw) < -60, "export goes beyond the 60 kW site load");
  const worn = scenario(80, "behind_meter", 0.5);
  assert.equal(worn.r.dischargedKwh, 0);
});

test("a low battery has nothing to spare", () => {
  const { r } = scenario(36);
  assert.ok(r.dischargedKwh < 5);
});

test("settings are cleaned; give-back goes out as an OCPP 2.1 setpoint on bidirectional chargers", () => {
  const c = cleanV2g({ enabled: true, min_soc: 5, mode: "weird" as never });
  assert.equal(c.min_soc, 10);
  assert.equal(c.mode, "behind_meter");
  const slots = buildSlots(t0, t0 + 2 * H, () => 0.2, () => null, 500);
  const depot = cleanEnergy({ depots: [{ id: "d", chargers: [{ id: "b4", name: "Bay 4", max_kw: 150, bidirectional: true }] }] }).depots[0];
  const view = { slots, visits: [{ visit: { charger_id: "b4" } as DepotVisit, plan: { kw: [-50, -50, 100, 0] } }] } as unknown as DepotPlanView;
  const p = chargingProfiles(depot, view)[0].request.chargingProfile as { chargingSchedule: { chargingSchedulePeriod: Record<string, unknown>[] }[] };
  const periods = p.chargingSchedule[0].chargingSchedulePeriod;
  assert.deepEqual(periods[0], { startPeriod: 0, limit: 0, operationMode: "CentralSetpoint", setpoint: -50000 });
  assert.equal(periods[1].operationMode, "ChargingOnly");
});
