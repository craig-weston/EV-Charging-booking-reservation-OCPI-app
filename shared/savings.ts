// Savings from charging electric trucks instead of running diesel ones, for fleets' sustainability
// reporting. Every figure is an estimate built from the charge records (energy and price) and a
// small set of stated assumptions the fleet can change.
//
// For each charge: distance enabled = kWh / kWh-per-km for that vehicle type; the same distance in a
// diesel equivalent burns litres = km x L/100km / 100. Then:
//   fuel cost saved = diesel litres x diesel price - what the charge cost (operator price + margin)
//   CO2e avoided    = diesel litres x diesel factor - kWh x grid factor
// Prices are ex VAT on both sides, as a VAT-registered fleet reclaims VAT on both.
import type { BookingRow, Vehicle } from "./model";
import type { VehicleType } from "./ocpi/types";
import { marginAt, type MarginChange, STATEMENT_TZ } from "./billing";
import { localDateKey } from "./util";

export interface SavingsAssumptions {
  /** Diesel price per litre, GBP ex VAT. */
  diesel_price: number;
  /** kg CO2e per litre of diesel (UK average biofuel blend, scope 1). */
  diesel_kgco2e_per_litre: number;
  /** kg CO2e per kWh of UK grid electricity. */
  grid_kgco2e_per_kwh: number;
  kwh_per_km: Partial<Record<VehicleType, number>>;
  litres_per_100km: Partial<Record<VehicleType, number>>;
}

/** Sources are listed in docs/savings.md and on the Savings page. */
export const DEFAULT_SAVINGS: SavingsAssumptions = {
  // RAC: diesel reached a record 199.18p a litre on 28 Sep 2026; less 20% VAT ≈ £1.66.
  diesel_price: 1.66,
  // DESNZ GHG conversion factors 2026: diesel (average biofuel blend) 2.58354 kg CO2e/litre.
  diesel_kgco2e_per_litre: 2.58354,
  // DESNZ GHG conversion factors 2026: UK electricity generation 0.13096 kg CO2e/kWh.
  grid_kgco2e_per_kwh: 0.13096,
  // Same energy-use defaults as the trip planner.
  kwh_per_km: { TRUCK_WITH_TRAILER: 1.3, SEMI_TRACTOR: 1.3, RIGID: 0.95, BUS: 1.1, VAN: 0.3 },
  // Diesel equivalents: articulated HGVs average about 7.9 mpg (≈ 36 L/100 km); others are typical figures.
  litres_per_100km: { TRUCK_WITH_TRAILER: 36, SEMI_TRACTOR: 36, RIGID: 26, BUS: 30, VAN: 10 },
};
const FALLBACK_TYPE: VehicleType = "RIGID";

export interface SavingsLine {
  kwh: number;
  km: number;
  diesel_litres: number;
  diesel_cost: number;
  electric_cost: number;
  cost_saved: number;
  co2_diesel_kg: number;
  co2_electric_kg: number;
  co2_saved_kg: number;
  charges: number;
}
export interface Savings {
  totals: SavingsLine;
  by_vehicle: (SavingsLine & { vehicle_id: string | null; plate: string; name: string | null })[];
  /** Calendar months (UK time), oldest first. */
  by_month: (SavingsLine & { month: string })[];
  /** Charges whose vehicle type had no assumption; the rigid figures were used. */
  defaulted: number;
}

const empty = (): SavingsLine => ({ kwh: 0, km: 0, diesel_litres: 0, diesel_cost: 0, electric_cost: 0, cost_saved: 0, co2_diesel_kg: 0, co2_electric_kg: 0, co2_saved_kg: 0, charges: 0 });

const KEYS = Object.keys(empty()) as (keyof SavingsLine)[];
function add(a: SavingsLine, b: SavingsLine) {
  for (const k of KEYS) a[k] += b[k];
}

export function cleanAssumptions(x: Partial<SavingsAssumptions> | null | undefined): SavingsAssumptions {
  const num = (v: unknown, d: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= max ? n : d;
  };
  const per = (src: Partial<Record<VehicleType, number>> | undefined, d: Partial<Record<VehicleType, number>>, max: number) => {
    const out: Partial<Record<VehicleType, number>> = {};
    for (const k of Object.keys(d) as VehicleType[]) out[k] = num(src?.[k], d[k]!, max);
    return out;
  };
  return {
    diesel_price: num(x?.diesel_price, DEFAULT_SAVINGS.diesel_price, 10),
    diesel_kgco2e_per_litre: num(x?.diesel_kgco2e_per_litre, DEFAULT_SAVINGS.diesel_kgco2e_per_litre, 10),
    grid_kgco2e_per_kwh: num(x?.grid_kgco2e_per_kwh, DEFAULT_SAVINGS.grid_kgco2e_per_kwh, 2),
    kwh_per_km: per(x?.kwh_per_km, DEFAULT_SAVINGS.kwh_per_km, 5),
    litres_per_100km: per(x?.litres_per_100km, DEFAULT_SAVINGS.litres_per_100km, 100),
  };
}

export function computeSavings(
  bookings: BookingRow[], vehicles: Vehicle[], a: SavingsAssumptions,
  opts: { from?: Date; to?: Date; margins?: MarginChange[] } = {},
): Savings {
  const totals = empty();
  const byVehicle = new Map<string, Savings["by_vehicle"][number]>();
  const byMonth = new Map<string, Savings["by_month"][number]>();
  let defaulted = 0;
  for (const b of bookings) {
    if (!b.cdr || !(b.cdr.total_energy > 0)) continue;
    const end = new Date(b.cdr.end_date_time);
    if (opts.from && end < opts.from) continue;
    if (opts.to && end >= opts.to) continue;
    const v = vehicles.find((x) => x.id === b.vehicle_id) ?? null;
    let type = v?.vehicle_type as VehicleType | undefined;
    if (!type || a.kwh_per_km[type] == null || a.litres_per_100km[type] == null) { type = FALLBACK_TYPE; defaulted++; }
    const kwh = b.cdr.total_energy;
    const km = kwh / a.kwh_per_km[type]!;
    const litres = km * a.litres_per_100km[type]! / 100;
    const electric = b.cdr.total_cost * (1 + marginAt(opts.margins, b.cdr.end_date_time) / 100);
    const line: SavingsLine = {
      kwh, km, diesel_litres: litres, diesel_cost: litres * a.diesel_price, electric_cost: electric,
      cost_saved: litres * a.diesel_price - electric,
      co2_diesel_kg: litres * a.diesel_kgco2e_per_litre, co2_electric_kg: kwh * a.grid_kgco2e_per_kwh,
      co2_saved_kg: litres * a.diesel_kgco2e_per_litre - kwh * a.grid_kgco2e_per_kwh,
      charges: 1,
    };
    add(totals, line);
    const vk = b.vehicle_id ?? b.plate;
    if (!byVehicle.has(vk)) byVehicle.set(vk, { ...empty(), vehicle_id: b.vehicle_id, plate: v?.plate ?? b.plate, name: v?.name ?? null });
    add(byVehicle.get(vk)!, line);
    const mk = localDateKey(end, STATEMENT_TZ).slice(0, 7);
    if (!byMonth.has(mk)) byMonth.set(mk, { ...empty(), month: mk });
    add(byMonth.get(mk)!, line);
  }
  return {
    totals,
    by_vehicle: [...byVehicle.values()].sort((x, y) => y.co2_saved_kg - x.co2_saved_kg),
    by_month: [...byMonth.values()].sort((x, y) => x.month.localeCompare(y.month)),
    defaulted,
  };
}

/** CSV for sustainability reporting: one row per vehicle, then the total, with the assumptions. */
export function savingsCsv(s: Savings, a: SavingsAssumptions, period: string): string {
  const r1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
  const r2 = (n: number) => n.toFixed(2);
  const esc = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const row = (label: string, l: SavingsLine) => [label, String(l.charges), r1(l.kwh), r1(l.km), r1(l.diesel_litres), r2(l.diesel_cost), r2(l.electric_cost), r2(l.cost_saved), r1(l.co2_diesel_kg), r1(l.co2_electric_kg), r1(l.co2_saved_kg)];
  const lines = [
    ["Vehicle", "Charges", "kWh", "Electric km (est.)", "Diesel avoided (L)", "Diesel cost (GBP ex VAT)", "Charging cost (GBP ex VAT)", "Fuel cost saved (GBP)", "Diesel CO2e (kg)", "Grid CO2e (kg)", "CO2e avoided (kg)"],
    ...s.by_vehicle.map((v) => row(v.name ? `${v.plate} (${v.name})` : v.plate, v)),
    row("Total", s.totals),
    [],
    ["Period", period],
    ["Diesel price (GBP/L ex VAT)", String(a.diesel_price)],
    ["Diesel factor (kg CO2e/L)", String(a.diesel_kgco2e_per_litre)],
    ["Grid factor (kg CO2e/kWh)", String(a.grid_kgco2e_per_kwh)],
    ...Object.keys(a.kwh_per_km).map((k) => [`${k} kWh/km, L/100km`, `${a.kwh_per_km[k as VehicleType]}, ${a.litres_per_100km[k as VehicleType]}`]),
  ];
  return lines.map((l) => l.map(esc).join(",")).join("\r\n") + "\r\n";
}
