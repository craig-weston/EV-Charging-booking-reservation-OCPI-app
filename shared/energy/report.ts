// "Smart timing" report for the Savings page: how clean and how cheap the half-hours a fleet
// actually charged in were, against the average of the same days, and what moving each charge by
// up to three hours could have saved.
import type { BookingRow } from "../model";
import type { Tariff } from "../ocpi/types";
import { averageEnergyPrice, standardEnergyPrice } from "./price";
import { HALF_HOUR, averageIntensity, type CarbonSeries } from "./carbon";
import { localParts } from "./price";

export interface TimingReport {
  charges: number;
  kwh: number;
  /** kWh-weighted g/kWh of the half-hours charged in. */
  intensity: number;
  /** kWh-weighted g/kWh of the whole days those charges were on. */
  dayIntensity: number;
  /** kg CO2 the timing avoided compared with charging at the day's average. Negative = dirtier. */
  kgByTiming: number;
  /** Extra kg that moving each charge by up to ±3 hours to its cleanest window could have avoided. */
  kgOpportunity: number;
  /** £ saved by time-of-use rates against each operator's all-day rate (negative = peak cost more). */
  touSaved: number;
  /** kWh charged on a time-of-use tariff. */
  touKwh: number;
  /** Share of kWh by local hour of day, 0..23, sums to 1. */
  byHour: number[];
  /** Any carbon here was modelled rather than measured. */
  modelled: boolean;
}

const SHIFT_MS = 3 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function timingReport(
  bookings: BookingRow[],
  seriesFor: (b: BookingRow) => CarbonSeries | null,
  tariffsFor: (b: BookingRow) => Tariff[],
  opts: { from?: Date; to?: Date; tz?: string } = {},
): TimingReport | null {
  const tz = opts.tz ?? "Europe/London";
  let kwh = 0, wI = 0, wDay = 0, opp = 0, touSaved = 0, touKwh = 0, charges = 0, modelled = false;
  const hours = new Array<number>(24).fill(0);
  for (const b of bookings) {
    const c = b.cdr;
    if (!c || !(c.total_energy > 0)) continue;
    const s = new Date(c.start_date_time), e = new Date(c.end_date_time);
    if (!(e > s)) continue;
    if (opts.from && e < opts.from) continue;
    if (opts.to && e >= opts.to) continue;
    const series = seriesFor(b);
    const i = averageIntensity(series, s, e);
    if (i == null || !series) continue;
    // The local day around the charge's midpoint.
    const mid = new Date((s.getTime() + e.getTime()) / 2);
    const p = localParts(mid, tz);
    const dayStart = new Date(mid.getTime() - p.min * 60_000);
    const day = averageIntensity(series, dayStart, new Date(dayStart.getTime() + DAY_MS)) ?? i;
    let best = i;
    const dur = e.getTime() - s.getTime();
    for (let off = -SHIFT_MS; off <= SHIFT_MS; off += HALF_HOUR) {
      const v = averageIntensity(series, new Date(s.getTime() + off), new Date(s.getTime() + off + dur));
      if (v != null && v < best) best = v;
    }
    if (series.source !== "neso") modelled = true;
    const k = c.total_energy;
    charges++; kwh += k; wI += i * k; wDay += day * k; opp += ((i - best) * k) / 1000;
    hours[localParts(mid, tz).min / 60 | 0] += k;
    const tariffs = tariffsFor(b);
    const std = standardEnergyPrice(tariffs);
    const avg = averageEnergyPrice(tariffs, s, e, tz);
    if (std != null && avg != null && Math.abs(avg - std) > 1e-9) { touSaved += (std - avg) * k; touKwh += k; }
  }
  if (!charges || !kwh) return null;
  const intensity = wI / kwh, dayIntensity = wDay / kwh;
  return {
    charges, kwh, intensity, dayIntensity,
    kgByTiming: ((dayIntensity - intensity) * kwh) / 1000,
    kgOpportunity: opp,
    touSaved: Math.round(touSaved * 100) / 100, touKwh,
    byHour: hours.map((h) => h / kwh),
    modelled,
  };
}
