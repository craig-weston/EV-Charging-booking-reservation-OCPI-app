// Savings vs diesel: distance from energy, diesel equivalent, cost and CO2e, per truck and month.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingRow, Vehicle } from "../shared/model";
import { DEFAULT_SAVINGS, cleanAssumptions, computeSavings, savingsCsv } from "../shared/savings";

const v = (id: string, type: string, plate: string) => ({ id, vehicle_type: type, plate, name: `Truck ${id}` }) as unknown as Vehicle;
const charge = (id: string, vehicle: string | null, end: string, kwh: number, cost: number) =>
  ({ id, vehicle_id: vehicle, plate: "XX11 XXX", cdr: { id: `c-${id}`, total_energy: kwh, total_time: 1, total_cost: cost, currency: "GBP", start_date_time: end, end_date_time: end } }) as unknown as BookingRow;

test("one artic charge: 260 kWh is 200 km, 72 L of diesel avoided", () => {
  const s = computeSavings([charge("a", "t1", "2026-10-10T10:00:00Z", 260, 150)], [v("t1", "TRUCK_WITH_TRAILER", "PN74 EVH")], DEFAULT_SAVINGS);
  const t = s.totals;
  assert.equal(Math.round(t.km), 200);
  assert.equal(Math.round(t.diesel_litres * 10) / 10, 72);
  assert.equal(Math.round(t.diesel_cost * 100) / 100, Math.round(72 * 1.66 * 100) / 100);
  assert.equal(t.electric_cost, 150);
  assert.equal(Math.round(t.cost_saved * 100) / 100, Math.round((72 * 1.66 - 150) * 100) / 100);
  assert.equal(Math.round(t.co2_saved_kg * 10) / 10, Math.round((72 * 2.58354 - 260 * 0.13096) * 10) / 10);
  assert.equal(s.by_vehicle[0].plate, "PN74 EVH");
  assert.deepEqual(s.by_month.map((m) => m.month), ["2026-10"]);
});

test("margin, period filter, unknown types and empty records", () => {
  const margins = [{ from: "2026-01-01T00:00:00.000Z", margin_percent: 10 }];
  const bookings = [
    charge("a", "t1", "2026-09-30T22:30:00Z", 100, 100), // 23:30 BST: September
    charge("b", "t1", "2026-10-05T10:00:00Z", 100, 100),
    charge("c", "x", "2026-10-06T10:00:00Z", 95, 50), // unknown vehicle: rigid figures
    charge("d", "t1", "2026-10-07T10:00:00Z", 0, 0), // no energy: ignored
    { ...charge("e", "t1", "2026-10-08T10:00:00Z", 10, 10), cdr: null } as unknown as BookingRow,
  ];
  const s = computeSavings(bookings, [v("t1", "SEMI_TRACTOR", "AB12 CDE")], DEFAULT_SAVINGS, { from: new Date("2026-09-30T23:00:00Z"), margins });
  assert.equal(s.totals.charges, 2);
  assert.equal(s.defaulted, 1);
  assert.equal(Math.round(s.totals.electric_cost * 100) / 100, 165, "operator price + 10%");
  assert.equal(Math.round(s.by_vehicle.find((x) => x.vehicle_id === "x")!.km), 100, "95 kWh at 0.95 kWh/km");
  const all = computeSavings(bookings, [v("t1", "SEMI_TRACTOR", "AB12 CDE")], DEFAULT_SAVINGS);
  assert.deepEqual(all.by_month.map((m) => m.month), ["2026-09", "2026-10"]);
});

test("assumptions are validated; CSV has a row per truck, a total and the assumptions", () => {
  const a = cleanAssumptions({ diesel_price: -1, grid_kgco2e_per_kwh: 0.2, kwh_per_km: { RIGID: 99 } as never });
  assert.equal(a.diesel_price, DEFAULT_SAVINGS.diesel_price);
  assert.equal(a.grid_kgco2e_per_kwh, 0.2);
  assert.equal(a.kwh_per_km.RIGID, DEFAULT_SAVINGS.kwh_per_km.RIGID);
  const s = computeSavings([charge("a", "t1", "2026-10-10T10:00:00Z", 260, 150)], [v("t1", "TRUCK_WITH_TRAILER", "=CMD")], DEFAULT_SAVINGS);
  const csv = savingsCsv(s, DEFAULT_SAVINGS, "October 2026").split("\r\n");
  assert.match(csv[0], /^Vehicle,Charges,kWh/);
  assert.ok(csv[1].startsWith("'=CMD"), "formula neutralised");
  assert.ok(csv[2].startsWith("Total,1,260.0,200.0"));
  assert.ok(csv.some((l) => l.startsWith("Diesel factor (kg CO2e/L),2.58354")));
});
