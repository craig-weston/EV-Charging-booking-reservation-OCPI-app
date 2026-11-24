// Trip planning for one truck: where and when to charge between two places, timed with the
// drivers' breaks the driver has to take anyway. Pure functions; the map draws the result.
//
// With a real lorry route (OpenRouteService's HGV profile via /api/public/route, when the
// deployment has ORS_API_KEY) distances, times and the charging corridor follow the road. Without
// one they are estimates: straight-line distance × ROAD_FACTOR, at an average HGV speed.
import type { OpenSite } from "../../shared/opendata/sites";
import { canPlug, rateHere, specOf, suitsTrucks, tooSmall, type Place, type Tallies, type TruckLike } from "./logic";

export const ROAD_FACTOR = 1.3;
/** Average speed of a loaded HGV across a trip, km/h (motorway limit 56 mph, plus towns and junctions). */
export const AVG_KMH = 75;
/** Never plan to arrive anywhere below this share of the battery. */
export const RESERVE = 0.15;
/** Rapid charging slows down past this, so plans stop here. */
export const MAX_SOC = 0.8;
/** GB/EU drivers' hours: a 45-minute break after 4½ hours' driving. */
export const BREAK_AFTER_MIN = 270;
export const BREAK_MIN = 45;
/** How far off the line between the two places a charger may be. */
export const CORRIDOR_KM = 20;
const MIN_KW = 150;

/** A road route: [lat, lon] points, its length and its driving time. */
export interface RoadRoute { line: [number, number][]; km: number; minutes: number }
export interface TripRequest { from: Place; to: Place; depart: Date; socPct: number; route?: RoadRoute | null }
export interface TripStop {
  site: OpenSite;
  arrive: Date;
  leave: Date;
  socArrive: number;
  socLeave: number;
  minutes: number;
  kwh: number;
  /** Rate this truck gets here, kW. */
  kw: number;
  /** The stop doubles as the driver's 45-minute break. */
  isBreak: boolean;
  /** Distance driven to get here, km. */
  km: number;
}
export interface TripPlan {
  ok: boolean;
  /** Why there's no plan: "No charger this truck can use within range after Leicester". */
  problem?: string;
  stops: TripStop[];
  arrive: Date;
  socArrive: number;
  km: number;
  driveMin: number;
  /** Notes worth showing: "Needs an overnight rest: over 9 hours' driving". */
  notes: string[];
  /** Distances and times follow a real lorry route, not the straight-line estimate. */
  roads: boolean;
}

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Where a point sits against the line from a to b: how far along (0–1) and how far off it, km. */
export function alongLine(a: Place, b: Place, p: { lat: number; lon: number }): { t: number; offKm: number } {
  const lat0 = rad((a.lat + b.lat) / 2);
  const xy = (q: { lat: number; lon: number }) => [rad(q.lon) * Math.cos(lat0) * R, rad(q.lat) * R];
  const [ax, ay] = xy(a), [bx, by] = xy(b), [px, py] = xy(p);
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  const cx = ax + t * dx, cy = ay + t * dy;
  return { t, offKm: Math.hypot(px - cx, py - cy) };
}

/**
 * Where a point sits against a road route: km along it (scaled to the route's own length, since the
 * line is simplified) and km off it, at the nearest segment.
 */
export function alongRoute(route: RoadRoute, p: { lat: number; lon: number }): { atKm: number; offKm: number; t: number } {
  const pts = route.line;
  const lat0 = rad(pts[0][0]);
  const xy = (q: [number, number]) => [rad(q[1]) * Math.cos(lat0) * R, rad(q[0]) * R];
  const [px, py] = xy([p.lat, p.lon]);
  let walked = 0, bestOff = Infinity, bestAt = 0;
  let [ax, ay] = xy(pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const [bx, by] = xy(pts[i]);
    const dx = bx - ax, dy = by - ay, seg = Math.hypot(dx, dy);
    const t = seg > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (seg * seg))) : 0;
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (off < bestOff) { bestOff = off; bestAt = walked + t * seg; }
    walked += seg; ax = bx; ay = by;
  }
  const scale = walked > 0 ? route.km / walked : 1;
  return { atKm: bestAt * scale, offKm: bestOff, t: walked > 0 ? bestAt / walked : 0 };
}

/** The trip's length and average speed: the road route's when there is one, else the estimate. */
function measure(req: TripRequest): { total: number; kmh: number; roads: boolean; locate(s: OpenSite): { atKm: number; offKm: number; t: number } } {
  const r = req.route;
  if (r && r.line.length >= 2 && r.km > 0 && r.minutes > 0) {
    return { total: r.km, roads: true, kmh: Math.min(90, Math.max(40, r.km / (r.minutes / 60))), locate: (s) => alongRoute(r, s) };
  }
  const total = haversineKm(req.from, req.to) * ROAD_FACTOR;
  return { total, roads: false, kmh: AVG_KMH, locate: (s) => { const a = alongLine(req.from, req.to, s); return { atKm: a.t * total, offKm: a.offKm, t: a.t }; } };
}

interface Candidate { site: OpenSite; atKm: number; detourKm: number; kw: number; trucks: boolean }

/** Sites along the way this truck can plug into, fit and charge fast at, ordered by distance along the trip. */
export function corridor(req: TripRequest, sites: OpenSite[], tallies: Tallies, truck: TruckLike): Candidate[] {
  const m = measure(req);
  const out: Candidate[] = [];
  for (const s of sites) {
    if (s.max_kw < MIN_KW || !canPlug(s, truck) || tooSmall(s, truck).length) continue;
    const { t, atKm, offKm } = m.locate(s);
    if (t <= 0.02 || t >= 0.98 || offKm > CORRIDOR_KM) continue;
    out.push({ site: s, atKm, detourKm: 2 * offKm * ROAD_FACTOR, kw: rateHere(s, truck), trucks: suitsTrucks(s, tallies[s.id], truck) });
  }
  return out.sort((a, b) => a.atKm - b.atKm);
}

/**
 * Plan where and when to charge. Each stop is placed as far along as the battery and the driver's
 * hours allow, preferring faster sites and sites built for trucks, and is at least a full 45-minute
 * break, so charging happens in time the driver must stop anyway.
 */
export function planTrip(req: TripRequest, sites: OpenSite[], tallies: Tallies, truck: TruckLike): TripPlan {
  const sp = specOf(truck);
  const m = measure(req);
  const total = m.total, kmh = m.kmh;
  const bat = sp.battery_kwh, perKm = sp.kwhPerKm;
  const cands = corridor(req, sites, tallies, truck);
  const stops: TripStop[] = [];
  const notes: string[] = [];
  let pos = 0, soc = Math.max(0, Math.min(1, req.socPct / 100)), sinceBreak = 0, driveMin = 0;
  let clock = req.depart.getTime();
  const roads = m.roads;
  const fail = (problem: string): TripPlan => ({ ok: false, problem, stops, arrive: new Date(clock), socArrive: soc, km: pos, driveMin, notes, roads });

  for (let guard = 0; guard < 8; guard++) {
    const remaining = total - pos;
    const rangeKm = Math.max(0, (soc - RESERVE) * bat) / perKm;
    const hoursLeftKm = ((BREAK_AFTER_MIN - sinceBreak) / 60) * kmh;
    if (rangeKm >= remaining && remaining <= hoursLeftKm) {
      const min = (remaining / kmh) * 60;
      clock += min * 60_000; driveMin += min; soc -= (remaining * perKm) / bat;
      if (driveMin > 540) notes.push("Over 9 hours' driving: plan an overnight rest, or a second driver.");
      return { ok: true, stops, arrive: new Date(clock), socArrive: soc, km: total, driveMin, notes, roads };
    }
    const reach = Math.min(rangeKm, hoursLeftKm);
    const options = cands.filter((c) => c.atKm > pos + 10 && c.atKm + c.detourKm / 2 - pos <= reach && !stops.some((s) => s.site.id === c.site.id));
    if (!options.length) {
      const where = stops.length ? `after ${stops[stops.length - 1].site.name}` : `from ${req.from.name}`;
      return fail(rangeKm < hoursLeftKm ? `No charger this truck can use within range ${where}.` : `No charger this truck can use before the driver's break is due ${where}.`);
    }
    // Go as far as is comfortable, then prefer power and truck-friendly sites.
    const best = options.reduce((a, b) => (score(b, pos, reach) > score(a, pos, reach) ? b : a));
    const legKm = best.atKm - pos + best.detourKm / 2;
    const legMin = (legKm / kmh) * 60;
    clock += legMin * 60_000; driveMin += legMin; sinceBreak += legMin;
    soc -= (legKm * perKm) / bat;
    const arrive = new Date(clock), socArrive = soc;
    // Charge for what's still to come (plus reserve), up to MAX_SOC; at least a full break.
    const after = total - best.atKm + best.detourKm / 2;
    const target = Math.min(MAX_SOC, RESERVE + (after * perKm) / bat + 0.03);
    const needKwh = Math.max(0, (target - soc) * bat);
    const rate = best.kw * 0.85;
    const chargeMin = rate > 0 ? (needKwh / rate) * 60 : 0;
    const minutes = Math.ceil(Math.max(BREAK_MIN, chargeMin) / 5) * 5;
    const kwh = Math.min(needKwh, (rate * minutes) / 60, (MAX_SOC - soc) * bat);
    soc += kwh / bat;
    clock += minutes * 60_000;
    sinceBreak = 0;
    pos = best.atKm + best.detourKm / 2;
    stops.push({ site: best.site, arrive, leave: new Date(clock), socArrive, socLeave: soc, minutes, kwh: Math.round(kwh), kw: Math.round(best.kw), isBreak: true, km: Math.round(pos) });
  }
  return fail("The trip needs more charging stops than this planner makes. Try a nearer destination.");
}

function score(c: Candidate, pos: number, reach: number): number {
  const far = (c.atKm - pos) / reach; // 0..1, further is better
  const fast = Math.min(c.kw, 400) / 400;
  return far * 0.6 + fast * 0.3 + (c.trucks ? 0.15 : 0) - (c.detourKm > 10 ? 0.05 : 0);
}

export { parseTripText, type TripAsk } from "../../shared/trip-text";

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** A place for a name: a town or freight hub, else a charging site with that name or town. */
export function resolvePlace(name: string, places: Place[], sites: OpenSite[]): Place | null {
  const n = norm(name);
  if (!n) return null;
  const town = places.find((p) => norm(p.name) === n) ?? places.find((p) => norm(p.name).startsWith(n));
  if (town) return { name: town.name, lat: town.lat, lon: town.lon };
  const site = sites.find((s) => norm(s.city ?? "") === n) ?? sites.find((s) => norm(s.name).includes(n)) ?? sites.find((s) => norm(s.city ?? "").startsWith(n));
  return site ? { name: site.city && norm(site.city) === n ? site.city : site.name, lat: site.lat, lon: site.lon } : null;
}

/** Today's (or tomorrow's, if already past) departure at "HH:MM", in the browser's time zone. */
export function departAt(hhmm: string | undefined, now = new Date()): Date {
  if (!hhmm) return new Date(Math.ceil(now.getTime() / 900_000) * 900_000);
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now); d.setHours(h, m, 0, 0);
  if (d.getTime() < now.getTime() - 30 * 60_000) d.setDate(d.getDate() + 1);
  return d;
}

