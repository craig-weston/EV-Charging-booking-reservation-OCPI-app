// Smart charging for one booked public charge: spread the energy the truck needs over the booking
// so it's ready by the end, using the operator's time-of-use prices and grid carbon, and turn that
// into an OCPI ChargingProfile (watts, seconds from the start).
import type { ChargingProfile, Tariff } from "../ocpi/types";
import type { SmartMode } from "../model";
import { energyPriceAt } from "./price";
import { intensityAt, type CarbonSeries } from "./carbon";
import { buildSlots, planDepot } from "./optimise";

export const SESSION_EFFICIENCY = 0.93;

export interface SessionPlanInput {
  mode: SmartMode;
  capKw?: number | null;
  /** When charging can start (now, or the session start). */
  from: number;
  /** End of the booking. */
  to: number;
  /** kWh into the battery still wanted. */
  needBatteryKwh: number;
  /** Most the truck can take on this bay, kW. */
  maxKw: number;
  tariffs: Tariff[];
  carbon: CarbonSeries | null;
  tz?: string;
}

export interface SessionPlan {
  profile: ChargingProfile;
  readyAt: number | null;
  kwh: number;
  cost: number;
  kg: number;
  baselineCost: number;
  baselineKg: number;
  shortKwh: number;
}

export function planSession(i: SessionPlanInput): SessionPlan {
  const tz = i.tz ?? "Europe/London";
  const priceAt = (t: number) => energyPriceAt(i.tariffs, new Date(t), tz) ?? 0;
  const carbonAt = (t: number) => intensityAt(i.carbon, new Date(t));
  const maxKw = Math.max(1, i.mode === "cap" && i.capKw ? Math.min(i.maxKw, i.capKw) : i.maxKw);
  const slots = buildSlots(i.from, i.to, priceAt, carbonAt, maxKw);
  const need = Math.max(0, i.needBatteryKwh) / SESSION_EFFICIENCY;
  // "cap" just limits power; charge as soon as possible within it.
  const goal = i.mode === "greenest" ? "carbon" : "cost";
  const visit = { id: "s", chargerId: null, from: i.from, to: i.to, needKwh: need, maxKw };
  const p = planDepot(slots, [visit], [], goal);
  let kw = p.visits[0].kw;
  if (i.mode === "cap") {
    // As soon as possible at up to the cap.
    let left = need;
    kw = slots.map((s) => {
      const h = (s.end - s.start) / 3_600_000;
      const e = Math.min(left, maxKw * h);
      left -= e;
      return e / h;
    });
  }
  const periods: ChargingProfile["charging_profile_period"] = [];
  slots.forEach((s, j) => {
    const limit = Math.round(((kw[j] ?? 0) * 1000) / 100) * 100;
    const start_period = Math.round((s.start - i.from) / 1000);
    if (!periods.length || periods[periods.length - 1].limit !== limit) periods.push({ start_period, limit });
  });
  let cost = 0, kg = 0, kwh = 0, readyAt: number | null = null;
  slots.forEach((s, j) => {
    const e = (kw[j] ?? 0) * (s.end - s.start) / 3_600_000;
    if (e <= 1e-6) return;
    kwh += e; cost += e * s.price; kg += s.carbon != null ? (e * s.carbon) / 1000 : 0;
    readyAt = s.end;
  });
  return {
    profile: { start_date_time: new Date(i.from).toISOString(), duration: Math.round((i.to - i.from) / 1000), charging_rate_unit: "W", charging_profile_period: periods },
    readyAt, kwh, cost, kg,
    baselineCost: p.baseline.cost, baselineKg: p.baseline.kg,
    shortKwh: Math.max(0, need - kwh),
  };
}
