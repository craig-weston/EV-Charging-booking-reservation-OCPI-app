// The demo's story: trucks back around 5–6pm, straight into the evening peak. Plugging in on
// arrival charges at the dearest time of day; the plan moves it overnight, saving around 45% on an
// Agile-shaped day (cheap overnight, dear 4–7pm). Same depot and trucks as src/app/demo.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vehicle } from "../shared/model";
import type { DepotPlanView } from "../server/depot";
import { harness } from "./helpers";

test("demo depot: arrivals into the evening peak save around 45% against plugging in on arrival", async () => {
  const h = await harness("2026-11-06T12:00:00Z");
  const vehicles = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  const v = (name: string) => vehicles.find((x) => x.name === name)!.id;
  const ch = (n: number) => ({ id: `bay-${n}`, name: `Bay ${n}`, station_id: `YARD-CP0${n}`, evse_id: 1, max_kw: 150 });
  // Agile's shape, ex VAT: cheap overnight, dear 4–7pm.
  const tariff = { kind: "tou", standard: 0.21, rates: [
    { price: 0.15, start: "00:00", end: "06:00" }, { price: 0.24, start: "06:00", end: "10:00" },
    { price: 0.36, start: "16:00", end: "19:00" }, { price: 0.25, start: "19:00", end: "23:59" },
  ] };
  const put = await h.api("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { depots: [{ id: "demo-yard", name: "Northampton yard", import_limit_kw: 400, site_load_kw: 60, goal: "balanced", tariff, chargers: [1, 2, 3, 4, 5].map(ch) }] } });
  assert.equal(put.status, 200, JSON.stringify(put.error));
  const stays = [
    { vehicle: "Rigid 03", charger: "bay-4", arrive: "2026-11-06T15:45:00Z", depart: "2026-11-07T07:00:00Z", soc: [72, 100] },
    { vehicle: "Tractor 01", charger: "bay-1", arrive: "2026-11-06T17:05:00Z", depart: "2026-11-07T05:15:00Z", soc: [21, 90] },
    { vehicle: "Reefer 04", charger: "bay-2", arrive: "2026-11-06T17:30:00Z", depart: "2026-11-07T04:30:00Z", soc: [34, 95] },
    { vehicle: "Tanker 05", charger: "bay-3", arrive: "2026-11-06T17:50:00Z", depart: "2026-11-07T06:00:00Z", soc: [17, 85] },
    { vehicle: "Tractor 02", charger: "bay-1", arrive: "2026-11-07T05:30:00Z", depart: "2026-11-07T09:00:00Z", soc: [44, 90] },
  ];
  for (const s of stays) {
    const r = await h.api("POST", `/api/fleets/${h.fleetId}/depot-visits`, { depot_id: "demo-yard", vehicle_id: v(s.vehicle), charger_id: s.charger, arrive_at: s.arrive, depart_at: s.depart, soc_start: s.soc[0], soc_target: s.soc[1] });
    assert.equal(r.status, 201, JSON.stringify(r.error));
  }
  const plan = (await h.api<DepotPlanView>("GET", `/api/fleets/${h.fleetId}/depots/demo-yard/plan`)).data;
  assert.ok(plan.visits.every((x) => x.outcome === "ready"), "every truck ready");
  const saving = 1 - plan.cost / plan.baseline.cost;
  assert.ok(saving > 0.4 && saving < 0.55, `saving ${(saving * 100).toFixed(1)}%`);
});
