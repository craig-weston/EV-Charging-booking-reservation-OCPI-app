// Real lorry routes for the trip planner, from OpenRouteService's HGV profile (free key from
// openrouteservice.org). The route avoids roads the truck can't use: low bridges, weight and
// length limits, and (for dangerous goods) roads closed to hazardous loads. Vans use the car profile.
//
//   GET /api/public/route?from={place}&to={place}&h={m}&w={m}&l={m}&t={tonnes}&hz={0|1}&kind={hgv|bus|van}
//
// Places are the planner's named places (src/map/ukmap.ts CITIES); dimensions are rounded, so the
// same truck on the same run is one cached route. Routes are kept for a week (in this isolate and in
// the store), to stay well inside the free quota. Without ORS_API_KEY the answer is 503 and the
// planner falls back to its straight-line estimate, saying so. The in-browser demo on a real
// deployment asks that deployment's endpoint (MarketDeps.marketUrl), like prices and carbon.
import type { Ctx } from "./context";
import type { MarketDeps } from "./market";
import { CITIES } from "../src/map/ukmap";
import { getLive } from "./livekeys";

const ORS = "https://api.openrouteservice.org/v2/directions";
const KEEP_MS = 7 * 24 * 3_600_000;
const TIMEOUT_MS = 12_000;
export const ROUTE_ATTRIBUTION = "Route © openrouteservice.org by HeiGIT, map data © OpenStreetMap contributors";

export interface TruckSize {
  /** "hgv" (lorries), "bus", or "van" (car roads, no restrictions). */
  kind: "hgv" | "bus" | "van";
  /** Metres. */
  height?: number;
  width?: number;
  length?: number;
  /** Tonnes, gross. */
  weight?: number;
  hazmat?: boolean;
}

export interface TruckRoute {
  source: "openrouteservice";
  from: string;
  to: string;
  km: number;
  minutes: number;
  /** [lat, lon] along the route, simplified to a few hundred points. */
  line: [number, number][];
  size: TruckSize;
  attribution: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, step: number) => Math.round(v / step) * step;
const n = (v: string | null) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** The size as asked for, rounded and checked, so near-identical trucks share a cached route. */
export function cleanSize(q: URLSearchParams): TruckSize {
  const kind = q.get("kind") === "van" ? "van" : q.get("kind") === "bus" ? "bus" : "hgv";
  if (kind === "van") return { kind };
  const h = n(q.get("h")), w = n(q.get("w")), l = n(q.get("l")), t = n(q.get("t"));
  return {
    kind,
    ...(h != null ? { height: Number(clamp(round(h, 0.1), 2, 5.5).toFixed(1)) } : {}),
    ...(w != null ? { width: Number(clamp(round(w, 0.05), 1.5, 3.5).toFixed(2)) } : {}),
    ...(l != null ? { length: Number(clamp(round(l, 0.5), 4, 30).toFixed(1)) } : {}),
    ...(t != null ? { weight: clamp(round(t, 1), 1, 60) } : {}),
    ...(q.get("hz") === "1" ? { hazmat: true } : {}),
  };
}

const place = (name: string | null) => CITIES.find((c) => c.name.toLowerCase() === (name ?? "").trim().toLowerCase()) ?? null;
const keyOf = (from: string, to: string, s: TruckSize) => `routes/${[from, to, s.kind, s.height ?? "", s.width ?? "", s.length ?? "", s.weight ?? "", s.hazmat ? 1 : 0].join("|").toLowerCase().replace(/[^a-z0-9|.-]/g, "")}`;

const memory = new Map<string, { at: number; route: TruckRoute }>();

/** Douglas–Peucker in km around the route's middle latitude: keeps the shape, drops the rest. */
export function simplify(points: [number, number][], toleranceKm: number, max = 400): [number, number][] {
  if (points.length <= 2) return points;
  const lat0 = (points[0][0] + points[points.length - 1][0]) / 2 * Math.PI / 180;
  const xy = (p: [number, number]) => [p[1] * Math.cos(lat0) * 111.32, p[0] * 110.57];
  const P = points.map(xy);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = P[a], [bx, by] = P[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = clamp(((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / len2, 0, 1);
      const d = Math.hypot(P[i][0] - (ax + t * dx), P[i][1] - (ay + t * dy));
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > toleranceKm && at > 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out = points.filter((_, i) => keep[i]);
  return out.length > max ? simplify(points, toleranceKm * 2, max) : out;
}

/** ORS's answer → our route, or an error message for the planner. */
export function parseOrs(body: unknown, from: string, to: string, size: TruckSize): TruckRoute | null {
  const f = (body as { features?: { geometry?: { coordinates?: unknown }; properties?: { summary?: { distance?: unknown; duration?: unknown } } }[] })?.features?.[0];
  const coords = Array.isArray(f?.geometry?.coordinates) ? (f!.geometry!.coordinates as unknown[]) : [];
  const km = Number(f?.properties?.summary?.distance) / 1000, minutes = Number(f?.properties?.summary?.duration) / 60;
  const line = coords.filter((c): c is [number, number] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[1], c[0]] as [number, number]);
  if (!(km > 0) || !(minutes > 0) || line.length < 2) return null;
  return { source: "openrouteservice", from, to, km: Math.round(km * 10) / 10, minutes: Math.round(minutes), line: simplify(line, 0.15).map(([a, b]) => [Number(a.toFixed(5)), Number(b.toFixed(5))]), size, attribution: ROUTE_ATTRIBUTION };
}

export class RouteUnavailable extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function fromOrs(d: MarketDeps, key: string, from: (typeof CITIES)[number], to: (typeof CITIES)[number], size: TruckSize): Promise<TruckRoute> {
  const profile = size.kind === "van" ? "driving-car" : "driving-hgv";
  const restrictions = Object.fromEntries(Object.entries({ height: size.height, width: size.width, length: size.length, weight: size.weight, hazmat: size.hazmat }).filter(([, v]) => v != null));
  const body = {
    coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
    // A place's centre may sit off the road network: look up to 5 km around it.
    radiuses: [5000, 5000],
    instructions: false,
    ...(profile === "driving-hgv" ? { options: { vehicle_type: size.kind === "bus" ? "bus" : "hgv", ...(Object.keys(restrictions).length ? { profile_params: { restrictions } } : {}) } } : {}),
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await d.transport(new Request(`${ORS}/${profile}/geojson`, { method: "POST", signal: ctl.signal, headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/geo+json, application/json" }, body: JSON.stringify(body) }));
  } catch {
    throw new RouteUnavailable("The routing service didn't answer", 504);
  } finally { clearTimeout(timer); }
  const j = await res.json().catch(() => null) as { error?: { code?: number; message?: string } } | null;
  if (res.status === 401 || res.status === 403) throw new RouteUnavailable("The OpenRouteService key wasn't accepted", 503);
  if (res.status === 429) throw new RouteUnavailable("The routing service's daily limit is used up", 503);
  if (!res.ok) {
    const code = j?.error?.code;
    throw new RouteUnavailable(code === 2009 || code === 2010 ? "No road route this truck can use was found between these places" : `The routing service answered ${res.status}`, code === 2009 || code === 2010 ? 404 : 502);
  }
  const route = parseOrs(j, from.name, to.name, size);
  if (!route) throw new RouteUnavailable("The routing service sent a route we couldn't read", 502);
  return route;
}

/** The route for a truck between two of the planner's places. */
export async function truckRoute(d: MarketDeps & { env?: { ORS_API_KEY?: string }; store?: Ctx["store"] }, q: URLSearchParams): Promise<TruckRoute> {
  const from = place(q.get("from")), to = place(q.get("to"));
  if (!from || !to || from === to) throw new RouteUnavailable("Choose two of the planner's places", 400);
  const size = cleanSize(q);
  const key = keyOf(from.name, to.name, size);
  const now = d.now().getTime();
  const hit = memory.get(key);
  if (hit && now - hit.at < KEEP_MS) return hit.route;
  if (d.mode !== "live") {
    // The demo: ask the deployment it runs on (no key in the browser).
    if (!d.marketUrl) throw new RouteUnavailable("Real lorry routes aren't available here", 503);
    const qs = new URLSearchParams({ from: from.name, to: to.name, kind: size.kind, ...(size.height ? { h: String(size.height) } : {}), ...(size.width ? { w: String(size.width) } : {}), ...(size.length ? { l: String(size.length) } : {}), ...(size.weight ? { t: String(size.weight) } : {}), ...(size.hazmat ? { hz: "1" } : {}) });
    let res: Response;
    try { res = await d.transport(new Request(`${d.marketUrl.replace(/\/+$/, "")}/api/public/route?${qs}`)); } catch { throw new RouteUnavailable("Real lorry routes aren't available here", 503); }
    const j = await res.json().catch(() => null) as { data?: TruckRoute; error?: { message?: string } } | null;
    if (!res.ok || !j?.data) throw new RouteUnavailable(j?.error?.message ?? "Real lorry routes aren't available here", res.ok ? 502 : res.status);
    memory.set(key, { at: now, route: j.data });
    return j.data;
  }
  const stored = d.store ? await getLive<{ at: number; route: TruckRoute }>(d.store, key).catch(() => null) : null;
  if (stored && now - stored.at < KEEP_MS) { memory.set(key, stored); return stored.route; }
  const apiKey = d.env?.ORS_API_KEY;
  if (!apiKey) throw new RouteUnavailable("Real lorry routes need an OpenRouteService key (free): see docs/trip-planner.md", 503);
  const route = await fromOrs(d, apiKey, from, to, size);
  const entry = { at: now, route };
  memory.set(key, entry);
  if (memory.size > 300) memory.delete(memory.keys().next().value!);
  if (d.store) await d.store.putLive({ [key]: entry }).catch(() => undefined);
  return route;
}
