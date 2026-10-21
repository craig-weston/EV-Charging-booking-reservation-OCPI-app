// Dashboard figures, computed from the bookings the app already holds (the last two weeks).
// Pure functions so they can be tested, and moved server-side when fleets get large.
import type { BookingRow, Vehicle } from "../../shared/model";
import { addLocalDays, localDateKey, startOfLocalDay } from "../../shared/util";
import { DEFAULT_TZ } from "./format";

const HOUR = 3_600_000;

/** Energy a booking delivered: the CDR when it has arrived, otherwise the session meter. */
export function bookingKwh(b: BookingRow): number {
  if (b.cdr) return b.cdr.total_energy;
  if (b.session && (b.session.status === "ACTIVE" || b.session.status === "COMPLETED")) return b.session.kwh;
  return 0;
}

export interface DayPoint {
  key: string; // YYYY-MM-DD in the fleet's time zone
  start: Date;
  kwh: number;
  cost: number;
  sessions: number;
}

export interface PeriodFigures {
  kwh: number;
  cost: number; // ex VAT, from charge records
  costedKwh: number; // energy covered by charge records (for the price per kWh)
  sessions: number;
  kept: number; // visits that turned up and charged
  noShows: number;
  operatorCancels: number;
  fleetCancels: number;
  declined: number; // rejected or failed requests
}

export interface Kpis {
  days: number;
  current: PeriodFigures;
  previous: PeriodFigures;
  /** 2 × days daily points, oldest first: the previous period, then the current one. */
  daily: DayPoint[];
  currency: string;
  chargingNow: number;
  liveKw: number;
}

const empty = (): PeriodFigures => ({ kwh: 0, cost: 0, costedKwh: 0, sessions: 0, kept: 0, noShows: 0, operatorCancels: 0, fleetCancels: 0, declined: 0 });

export function computeKpis(bookings: BookingRow[], now: Date, days = 7, tz = DEFAULT_TZ): Kpis {
  const today = startOfLocalDay(now, tz);
  const daily: DayPoint[] = [];
  for (let i = 2 * days - 1; i >= 0; i--) {
    const start = addLocalDays(today, -i, tz);
    daily.push({ key: localDateKey(new Date(start.getTime() + 12 * HOUR), tz), start, kwh: 0, cost: 0, sessions: 0 });
  }
  const byKey = new Map(daily.map((d) => [d.key, d]));
  const currentFrom = daily[days].start.getTime();
  const current = empty();
  const previous = empty();
  let currency = "GBP";
  let chargingNow = 0;
  let liveKw = 0;

  for (const b of bookings) {
    if (b.session?.status === "ACTIVE") {
      chargingNow++;
      liveKw += b.session.power_kw ?? 0;
    }
    const startMs = new Date(b.start_at).getTime();
    if (startMs > now.getTime()) continue; // future bookings aren't history yet
    const day = byKey.get(localDateKey(new Date(b.start_at), tz));
    if (!day) continue; // older than the window
    const period = startMs >= currentFrom ? current : previous;
    const kwh = bookingKwh(b);
    if (kwh > 0) {
      day.kwh += kwh;
      day.sessions++;
      period.kwh += kwh;
      period.sessions++;
    }
    if (b.cdr) {
      day.cost += b.cdr.total_cost;
      period.cost += b.cdr.total_cost;
      period.costedKwh += b.cdr.total_energy;
      currency = b.cdr.currency || currency;
    }
    switch (b.reservation_status) {
      case "FULFILLED": period.kept++; break;
      case "NO_SHOW": period.noShows++; break;
      case "REJECTED": case "FAILED": period.declined++; break;
      case "CANCELED":
        if (b.booking?.canceled?.who_canceled === "CPO") period.operatorCancels++;
        else period.fleetCancels++;
        break;
      default: break;
    }
  }
  const round = (p: PeriodFigures) => ({ ...p, kwh: Math.round(p.kwh * 10) / 10, cost: Math.round(p.cost * 100) / 100, costedKwh: Math.round(p.costedKwh * 10) / 10 });
  return { days, current: round(current), previous: round(previous), daily, currency, chargingNow, liveKw: Math.round(liveKw) };
}

/** Average price per kWh (ex VAT) over the energy that has a charge record. */
export function pricePerKwh(p: PeriodFigures): number | null {
  return p.costedKwh > 0 ? p.cost / p.costedKwh : null;
}

/** Share of visits that turned up (charged) rather than no-showed. */
export function keptRate(p: PeriodFigures): number | null {
  const n = p.kept + p.noShows;
  return n > 0 ? p.kept / n : null;
}

/** Relative change, or null when there's nothing to compare with. */
export function change(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / previous;
}

// ------------------------------------------------------------------ fleet overview

export type TruckState = "charging" | "due" | "booked" | "idle" | "inactive";

export interface Battery {
  soc: number; // %
  at: string; // when the reading was taken
  live: boolean; // from an active session
  startSoc: number | null;
  powerKw: number | null;
  /** Live sessions: the next milestone (80%, then 100%) and when it should be reached. */
  target?: 80 | 100;
  eta?: Date | null;
  /** Whether the target is reached before the booked slot ends. */
  inTime?: boolean;
}

export interface TruckOverview {
  vehicle: Vehicle;
  state: TruckState;
  current: BookingRow | null; // charging now, or due on site now
  next: BookingRow | null; // next booking after the current one
  lastCharge: BookingRow | null;
  battery: Battery | null;
  problem: BookingRow | null; // a recent booking that went wrong
}

const isOpen = (b: BookingRow) => b.reservation_status === "RESERVED" || b.reservation_status === "PENDING";

/** Estimated time to the next milestone from the rise in state of charge since the session began. */
export function batteryEta(b: BookingRow): Pick<Battery, "target" | "eta" | "inTime"> {
  const s = b.session;
  if (!s || s.status !== "ACTIVE" || s.soc == null) return {};
  if (s.soc >= 99.5) return { target: 100, eta: null, inTime: true };
  const target: 80 | 100 = s.soc < 80 ? 80 : 100;
  const startSoc = s.soc_start ?? null;
  const hours = (new Date(s.last_updated).getTime() - new Date(s.start_date_time).getTime()) / HOUR;
  if (startSoc == null || hours < 0.05 || s.soc <= startSoc) return { target, eta: null };
  let rate = (s.soc - startSoc) / hours; // % per hour
  // Charging slows above 80%: if the rate was measured below it, expect roughly half the pace.
  if (target === 100 && startSoc < 80) rate *= 0.45;
  const eta = new Date(new Date(s.last_updated).getTime() + ((target - s.soc) / rate) * HOUR);
  return { target, eta, inTime: eta.getTime() <= new Date(b.end_at).getTime() };
}

export function fleetOverview(vehicles: Vehicle[], bookings: BookingRow[], now: Date): TruckOverview[] {
  const t = now.getTime();
  const out: TruckOverview[] = [];
  for (const v of vehicles) {
    const mine = bookings.filter((b) => b.vehicle_id === v.id).sort((a, b) => a.start_at.localeCompare(b.start_at));
    const charging = mine.find((b) => b.session?.status === "ACTIVE") ?? null;
    const due = charging ? null : mine.find((b) => isOpen(b) && new Date(b.start_at).getTime() - 30 * 60_000 <= t && new Date(b.end_at).getTime() > t) ?? null;
    const current = charging ?? due;
    const next = mine.find((b) => b !== current && isOpen(b) && new Date(b.start_at).getTime() > t) ?? null;
    const completed = mine
      .filter((b) => b.session?.status === "COMPLETED" || b.cdr)
      .sort((a, b) => (a.session?.end_date_time ?? a.cdr?.end_date_time ?? a.end_at).localeCompare(b.session?.end_date_time ?? b.cdr?.end_date_time ?? b.end_at));
    const lastCharge = completed[completed.length - 1] ?? null;

    let battery: Battery | null = null;
    if (charging?.session?.soc != null) {
      const s = charging.session;
      battery = { soc: s.soc!, at: s.last_updated, live: true, startSoc: s.soc_start ?? null, powerKw: s.power_kw ?? null, ...batteryEta(charging) };
    } else {
      const withSoc = [...completed].reverse().find((b) => b.session?.soc != null);
      if (withSoc?.session) {
        const s = withSoc.session;
        battery = { soc: s.soc!, at: s.end_date_time ?? s.last_updated, live: false, startSoc: s.soc_start ?? null, powerKw: null };
      }
    }

    const since = t - 36 * HOUR;
    const problem = [...mine].reverse().find((b) => new Date(b.updated_at).getTime() > since && (
      b.reservation_status === "NO_SHOW" || b.reservation_status === "REJECTED" || b.reservation_status === "FAILED"
      || (b.reservation_status === "CANCELED" && b.booking?.canceled?.who_canceled === "CPO"))) ?? null;

    const state: TruckState = !v.active ? "inactive" : charging ? "charging" : due ? "due" : next ? "booked" : "idle";
    out.push({ vehicle: v, state, current, next, lastCharge, battery, problem });
  }
  const order: Record<TruckState, number> = { charging: 0, due: 1, booked: 2, idle: 3, inactive: 4 };
  const when = (o: TruckOverview) => (o.current ?? o.next)?.start_at ?? "9999";
  return out.sort((a, b) => order[a.state] - order[b.state]
    || when(a).localeCompare(when(b))
    || a.vehicle.name.localeCompare(b.vehicle.name, "en-GB", { numeric: true }));
}

/** Battery band for the meter colour: the reading also always shows as a number and a word. */
export function batteryBand(soc: number): "low" | "mid" | "good" {
  return soc < 20 ? "low" : soc < 50 ? "mid" : "good";
}

/** Recent completed charges, newest first. */
export function recentCharges(bookings: BookingRow[], limit = 5): BookingRow[] {
  return bookings
    .filter((b) => b.cdr || b.session?.status === "COMPLETED")
    .sort((a, b) => (b.cdr?.end_date_time ?? b.session?.end_date_time ?? b.end_at).localeCompare(a.cdr?.end_date_time ?? a.session?.end_date_time ?? a.end_at))
    .slice(0, limit);
}
