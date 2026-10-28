// Plan the charging stops for a long trip: where the truck needs to charge, when it will get
// there, and a bookable slot at each stop, so the whole trip can be booked in one go.
//
// A planning estimate, not navigation: distance is the straight line × a road factor, speed and
// consumption are averages the planner can change, and stops line up with the driver's 45-minute
// break after at most 4 h 30 of driving (GB/EU drivers' hours).
import type { NetworkSnapshot, Vehicle } from "../../shared/model";
import type { BookingLocation, Location, VehicleType } from "../../shared/ocpi/types";
import { assess, type Assessment } from "../../shared/booking/compat";
import { durationLimits, suggestSlots, type Suggestion } from "../../shared/booking/slots";
import { haversineKm, upper } from "../../shared/util";
import { operatorFor, shortSiteName, siteKey } from "./network";

export interface Place { name: string; lat: number; lon: number }

export interface TripInput {
  net: NetworkSnapshot;
  vehicle: Vehicle;
  from: Place;
  to: Place;
  depart: Date;
  now: Date;
  /** Battery at departure, 0–1. */
  startSoc: number;
  /** Battery to arrive with at the destination, 0–1. */
  arriveSoc?: number;
  kwhPerKm?: number;
  speedKmh?: number;
  roadFactor?: number;
  chargeTo?: number;
}

export interface TripStop {
  siteKey: string;
  name: string;
  operator: string;
  location: Location;
  bl: BookingLocation;
  assessment: Assessment;
  slot: Suggestion;
  arriveAt: Date;
  /** Waiting before the slot starts, minutes. */
  waitMin: number;
  legKm: number;
  socArrive: number;
  socLeave: number;
}

export interface TripPlan {
  ok: boolean;
  /** Why the trip can't be planned, when !ok. */
  problem: string | null;
  stops: TripStop[];
  totalKm: number;
  arriveAt: Date;
  arriveSoc: number;
  drivingMin: number;
  assumptions: { kwhPerKm: number; speedKmh: number; roadFactor: number; batteryKwh: number; chargeTo: number; arriveSoc: number };
}

/** Rough average consumption by vehicle type, kWh per km (loaded, motorway). */
export const DEFAULT_KWH_PER_KM: Partial<Record<VehicleType, number>> = {
  TRUCK_WITH_TRAILER: 1.3, SEMI_TRACTOR: 1.3, RIGID: 0.95, BUS: 1.1, VAN: 0.3,
};
export const MAX_DRIVE_MIN = 270; // 4 h 30 of driving, then a 45-minute break
const BREAK_MIN = 45;
const RESERVE = 0.1; // never plan to arrive at a stop below 10%
const CORRIDOR_KM = 50; // how far off the straight line a stop may be (the detour is counted)

const MIN = 60_000;

function project(from: Place, to: Place, p: { lat: number; lon: number }): { t: number; offsetKm: number } {
  // Equirectangular projection around the route's middle latitude: good enough at GB scale.
  const lat0 = ((from.lat + to.lat) / 2) * Math.PI / 180;
  const xy = (q: { lat: number; lon: number }) => [q.lon * Math.cos(lat0) * 111.32, q.lat * 110.57];
  const [ax, ay] = xy(from), [bx, by] = xy(to), [px, py] = xy(p);
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  const cx = ax + Math.max(0, Math.min(1, t)) * dx, cy = ay + Math.max(0, Math.min(1, t)) * dy;
  return { t, offsetKm: Math.hypot(px - cx, py - cy) };
}

interface Candidate { key: string; location: Location; operator: string; name: string; posKm: number; detourKm: number; options: { bl: BookingLocation; a: Assessment }[] }

function candidates(i: TripInput, totalKm: number, roadFactor: number): Candidate[] {
  const byLoc = new Map<string, { location: Location; bls: BookingLocation[] }>();
  for (const o of i.net.booking_locations) {
    const loc = i.net.locations.find((l) => upper(l.country_code) === upper(o.country_code) && upper(l.party_id) === upper(o.party_id) && l.id === o.data.location_id)?.data;
    if (!loc) continue;
    const k = siteKey(o.country_code, o.party_id, o.data.location_id);
    const e = byLoc.get(k) ?? { location: loc, bls: [] };
    e.bls.push(o.data);
    byLoc.set(k, e);
  }
  const out: Candidate[] = [];
  for (const [key, { location, bls }] of byLoc) {
    const options = bls.map((bl) => ({ bl, a: assess(i.vehicle, bl, location) })).filter((x) => x.a.ok)
      .sort((x, y) => Number(y.a.zeroTouch) - Number(x.a.zeroTouch) || (y.a.usableKw ?? 0) - (x.a.usableKw ?? 0));
    if (!options.length) continue;
    const pr = project(i.from, i.to, { lat: Number(location.coordinates.latitude), lon: Number(location.coordinates.longitude) });
    if (pr.t <= 0.02 || pr.t >= 0.98 || pr.offsetKm > CORRIDOR_KM) continue;
    const operator = operatorFor(i.net, location.country_code, location.party_id, location);
    out.push({ key, location, operator, name: shortSiteName(location, operator), posKm: pr.t * totalKm, detourKm: 2 * pr.offsetKm * roadFactor, options });
  }
  return out.sort((a, b) => a.posKm - b.posKm);
}

export function planTrip(i: TripInput): TripPlan {
  const batteryKwh = i.vehicle.battery_kwh ?? 540;
  const kwhPerKm = i.kwhPerKm ?? DEFAULT_KWH_PER_KM[i.vehicle.vehicle_type] ?? 1.2;
  const speedKmh = i.speedKmh ?? 70;
  const roadFactor = i.roadFactor ?? 1.2;
  const chargeTo = i.chargeTo ?? 0.8;
  const arriveSoc = i.arriveSoc ?? 0.15;
  const totalKm = haversineKm(i.from.lat, i.from.lon, i.to.lat, i.to.lon) * roadFactor;
  const assumptions = { kwhPerKm, speedKmh, roadFactor, batteryKwh, chargeTo, arriveSoc };
  const drive = (km: number) => (km / speedKmh) * 60;
  const cands = candidates(i, totalKm, roadFactor);

  const stops: TripStop[] = [];
  let pos = 0, soc = Math.min(1, Math.max(0, i.startSoc)), at = new Date(Math.max(i.depart.getTime(), i.now.getTime())), sinceBreak = 0, drivingMin = 0;
  const fail = (problem: string): TripPlan => ({ ok: false, problem, stops, totalKm, arriveAt: at, arriveSoc: soc, drivingMin, assumptions });

  for (let guard = 0; guard < 12; guard++) {
    const rest = totalKm - pos;
    const canFinish = (soc - arriveSoc) * batteryKwh >= rest * kwhPerKm && sinceBreak + drive(rest) <= MAX_DRIVE_MIN;
    if (canFinish) {
      at = new Date(at.getTime() + drive(rest) * MIN);
      drivingMin += drive(rest);
      return { ok: true, problem: null, stops, totalKm, arriveAt: at, arriveSoc: soc - (rest * kwhPerKm) / batteryKwh, drivingMin, assumptions };
    }
    // Furthest stop the battery and the driver's hours both reach, that has a slot.
    const reachable = cands.filter((c) => {
      const leg = c.posKm - pos + c.detourKm / 2;
      return c.posKm > pos + 15 && (soc - RESERVE) * batteryKwh >= leg * kwhPerKm && sinceBreak + drive(leg) <= MAX_DRIVE_MIN;
    }).reverse();
    let placed: TripStop | null = null;
    for (const c of reachable) {
      const leg = c.posKm - pos + c.detourKm / 2;
      const arriveAt = new Date(at.getTime() + drive(leg) * MIN);
      const socArrive = soc - (leg * kwhPerKm) / batteryKwh;
      for (const { bl, a } of c.options) {
        const kw = Math.max(50, a.usableKw ?? i.vehicle.max_charge_kw ?? 150);
        const chargeMin = ((Math.max(chargeTo, socArrive) - socArrive) * batteryKwh / (kw * 0.9)) * 60;
        const lim = durationLimits(bl);
        const want = Math.max(BREAK_MIN, Math.ceil(chargeMin / lim.step) * lim.step);
        const dur = Math.min(Math.max(want, lim.min), lim.max);
        const slot = suggestSlots(bl, arriveAt, dur, i.now, { count: 6, horizonMin: 120, spacingMin: 15 })
          .filter((s) => s.start.getTime() >= arriveAt.getTime())
          .sort((x, y) => x.start.getTime() - y.start.getTime())[0];
        if (!slot || slot.start.getTime() - arriveAt.getTime() > 90 * MIN) continue;
        const energy = Math.min((chargeTo - socArrive) * batteryKwh, kw * 0.9 * (dur / 60));
        placed = {
          siteKey: c.key, name: c.name, operator: c.operator, location: c.location, bl, assessment: a, slot, arriveAt,
          waitMin: Math.max(0, Math.round((slot.start.getTime() - arriveAt.getTime()) / MIN)), legKm: leg,
          socArrive, socLeave: Math.min(1, socArrive + Math.max(0, energy) / batteryKwh),
        };
        break;
      }
      if (placed) {
        pos = c.posKm + c.detourKm / 2;
        break;
      }
    }
    if (!placed) {
      const last = stops.at(-1)?.name ?? i.from.name;
      return fail(`No bookable stop the truck can reach after ${last}. Start with more charge, or add sites on this route.`);
    }
    stops.push(placed);
    drivingMin += drive(placed.legKm);
    soc = placed.socLeave;
    at = placed.slot.end;
    sinceBreak = 0;
  }
  return fail("The trip needs more stops than this planner handles.");
}
