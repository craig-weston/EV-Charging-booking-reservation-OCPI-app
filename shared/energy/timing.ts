// Cheapest and greenest charging slots: score each candidate start by the energy price over the
// charge (time-of-use tariffs) and the grid carbon intensity over the same half-hours.
import type { Tariff } from "../ocpi/types";
import { averageEnergyPrice } from "./price";
import { averageIntensity, type CarbonSeries } from "./carbon";

export interface SlotEnergy {
  start: Date;
  end: Date;
  /** £/kWh before tax, averaged over the charge. */
  price: number | null;
  /** Energy cost for `kwh`, before tax. */
  cost: number | null;
  /** g CO2/kWh averaged over the charge. */
  intensity: number | null;
  /** kg CO2 for `kwh`. */
  kg: number | null;
}

export function slotEnergy(start: Date, end: Date, kwh: number | null, tariffs: Tariff[], carbon: CarbonSeries | null, tz = "Europe/London"): SlotEnergy {
  const price = averageEnergyPrice(tariffs, start, end, tz);
  const intensity = averageIntensity(carbon, start, end);
  return {
    start, end, price, intensity,
    cost: price != null && kwh != null ? Math.round(price * kwh * 100) / 100 : null,
    kg: intensity != null && kwh != null ? Math.round((intensity * kwh) / 100) / 10 : null,
  };
}

export interface SmartPicks {
  asked: SlotEnergy | null;
  /** Only set when it saves at least £1 against the asked-for slot. */
  cheapest: (SlotEnergy & { saves: number }) | null;
  /** Only set when it's at least 10% lower carbon than the asked-for slot. */
  greenest: (SlotEnergy & { lowerPct: number; kgLess: number }) | null;
}

export const MIN_SAVING = 1; // £
export const MIN_CARBON_CUT = 0.1; // 10%

/**
 * From feasible candidate slots, the cheapest and the greenest that beat the slot the planner asked
 * for by a meaningful margin. Ties go to the candidate closest to the asked-for time.
 */
export function smartPicks(
  candidates: { start: Date; end: Date }[], asked: Date | null, kwh: number | null,
  tariffs: Tariff[], carbon: CarbonSeries | null, tz = "Europe/London",
): SmartPicks {
  if (!candidates.length) return { asked: null, cheapest: null, greenest: null };
  const near = (d: Date) => Math.abs(d.getTime() - (asked ?? candidates[0].start).getTime());
  const scored = candidates.map((c) => slotEnergy(c.start, c.end, kwh, tariffs, carbon, tz));
  const askedSlot = asked ? scored.find((s) => s.start.getTime() === asked.getTime()) ?? null : null;
  const ref = askedSlot ?? scored.slice().sort((a, b) => near(a.start) - near(b.start))[0];

  let cheapest: SmartPicks["cheapest"] = null;
  if (ref.cost != null) {
    const best = scored.filter((s) => s.cost != null).sort((a, b) => a.cost! - b.cost! || near(a.start) - near(b.start))[0];
    const saves = Math.round((ref.cost - best.cost!) * 100) / 100;
    if (best && saves >= MIN_SAVING) cheapest = { ...best, saves };
  }
  let greenest: SmartPicks["greenest"] = null;
  if (ref.intensity != null) {
    const best = scored.filter((s) => s.intensity != null).sort((a, b) => a.intensity! - b.intensity! || near(a.start) - near(b.start))[0];
    const lowerPct = best ? (ref.intensity - best.intensity!) / ref.intensity : 0;
    if (best && lowerPct >= MIN_CARBON_CUT) greenest = { ...best, lowerPct, kgLess: Math.round(((ref.kg ?? 0) - (best.kg ?? 0)) * 10) / 10 };
  }
  return { asked: askedSlot, cheapest, greenest };
}
