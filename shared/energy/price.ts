// Time-of-use energy prices from OCPI Tariffs. OCPI applies the first TariffElement whose
// restrictions match, per price component type, so a cheaper night rate is an ENERGY element with
// start_time/end_time listed before the all-day ENERGY element.
import type { Tariff, TariffElement } from "../ocpi/types";
import { MINUTE } from "../util";

const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Local wall-clock parts of an instant: minutes since midnight, weekday and YYYY-MM-DD. */
export function localParts(d: Date, tz: string): { min: number; dow: string; date: string } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { min: Number(p.hour) * 60 + Number(p.minute), dow: DAYS[wd] ?? "MONDAY", date: `${p.year}-${p.month}-${p.day}` };
}

const hm = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Restrictions we can judge from the clock alone. Elements limited by kWh, power or duration are
 *  left to the operator's CDR; for planning we treat them as not applying. */
function elementApplies(el: TariffElement, when: Date, tz: string): boolean {
  const r = el.restrictions;
  if (!r) return true;
  if (r.booking || r.reservation) return false;
  if (r.min_kwh != null || r.max_kwh != null || r.min_power != null || r.max_power != null || r.min_current != null || r.max_current != null || r.min_duration != null || r.max_duration != null) return false;
  const p = localParts(when, tz);
  if (r.day_of_week?.length && !r.day_of_week.includes(p.dow)) return false;
  if (r.start_date && p.date < r.start_date) return false;
  if (r.end_date && p.date >= r.end_date) return false;
  const s = r.start_time ? hm(r.start_time) : null;
  const e = r.end_time ? hm(r.end_time) : null;
  if (s != null && e != null) return s <= e ? p.min >= s && p.min < e : p.min >= s || p.min < e; // across midnight
  if (s != null) return p.min >= s;
  if (e != null) return p.min < e;
  return true;
}

/** Energy price per kWh (before tax) at one instant, or null when no tariff prices energy. */
export function energyPriceAt(tariffs: Tariff[], when: Date, tz = "Europe/London"): number | null {
  for (const t of tariffs) {
    if (t.start_date_time && new Date(t.start_date_time) > when) continue;
    if (t.end_date_time && new Date(t.end_date_time) <= when) continue;
    for (const el of t.elements) {
      const c = el.price_components.find((p) => p.type === "ENERGY");
      if (c && elementApplies(el, when, tz)) return c.price;
    }
  }
  return null;
}

/** Time-weighted average energy price over [start, end), sampled every `stepMin` minutes. */
export function averageEnergyPrice(tariffs: Tariff[], start: Date, end: Date, tz = "Europe/London", stepMin = 15): number | null {
  if (!(end > start)) return energyPriceAt(tariffs, start, tz);
  let sum = 0, n = 0;
  for (let t = start.getTime(); t < end.getTime(); t += stepMin * MINUTE) {
    const p = energyPriceAt(tariffs, new Date(t + (stepMin * MINUTE) / 2), tz);
    if (p == null) return null;
    sum += p; n++;
  }
  return n ? sum / n : null;
}

/** The energy element with no clock restriction: the "standard" rate a time-of-use rate beats. */
export function standardEnergyPrice(tariffs: Tariff[]): number | null {
  for (const t of tariffs) {
    for (const el of t.elements) {
      const c = el.price_components.find((p) => p.type === "ENERGY");
      const r = el.restrictions;
      if (c && (!r || (!r.start_time && !r.end_time && !r.day_of_week?.length && !r.booking && !r.reservation))) return c.price;
    }
  }
  return null;
}

export interface TimedRate { price: number; start_time: string; end_time: string; days: string[] | null }

/** Clock-restricted energy rates, for showing "£0.45 from 22:00 to 06:00". */
export function timedRates(tariffs: Tariff[]): TimedRate[] {
  const out: TimedRate[] = [];
  for (const t of tariffs) {
    for (const el of t.elements) {
      const c = el.price_components.find((p) => p.type === "ENERGY");
      const r = el.restrictions;
      if (c && r && (r.start_time || r.end_time) && !r.booking && !r.reservation) {
        out.push({ price: c.price, start_time: r.start_time ?? "00:00", end_time: r.end_time ?? "00:00", days: r.day_of_week?.length ? r.day_of_week : null });
      }
    }
  }
  return out;
}

export const hasTimeOfUse = (tariffs: Tariff[]) => timedRates(tariffs).length > 0;
