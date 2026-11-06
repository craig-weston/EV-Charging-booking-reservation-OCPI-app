// Real lorry routes for the trip planner, from this deployment's /api/public/route
// (server/routing.ts: OpenRouteService's HGV profile). Without one (no key on the server, the
// static preview, or no road route the truck can use) the planner uses its straight-line estimate.
import { useEffect, useState } from "react";
import type { Vehicle } from "../../shared/model";
import type { TruckRoute } from "../../server/routing";

export type { TruckRoute };

/** The route query for a truck: its size decides which roads it can use. */
export function routeQuery(from: string, to: string, v: Pick<Vehicle, "vehicle_type" | "height_cm" | "width_cm" | "length_cm" | "gross_weight_kg" | "dangerous_goods">): string {
  const kind = v.vehicle_type === "VAN" ? "van" : v.vehicle_type === "BUS" ? "bus" : "hgv";
  const q = new URLSearchParams({ from, to, kind });
  if (kind !== "van") {
    if (v.height_cm) q.set("h", (v.height_cm / 100).toFixed(1));
    if (v.width_cm) q.set("w", (v.width_cm / 100).toFixed(2));
    if (v.length_cm) q.set("l", (v.length_cm / 100).toFixed(1));
    if (v.gross_weight_kg) q.set("t", String(Math.round(v.gross_weight_kg / 1000)));
    if (v.dangerous_goods) q.set("hz", "1");
  }
  return q.toString();
}

const known = new Map<string, Promise<{ route: TruckRoute | null; note: string | null }>>();

function load(origin: string, query: string): Promise<{ route: TruckRoute | null; note: string | null }> {
  const key = `${origin}?${query}`;
  let p = known.get(key);
  if (!p) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    p = fetch(`${origin.replace(/\/+$/, "")}/api/public/route?${query}`, { headers: { Accept: "application/json" }, signal: ctl.signal })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as { data?: TruckRoute; error?: { message?: string } } | null;
        return r.ok && j?.data?.line?.length ? { route: j.data, note: null } : { route: null, note: j?.error?.message ?? null };
      })
      .catch(() => ({ route: null, note: null }))
      .finally(() => clearTimeout(timer));
    known.set(key, p);
    // A failure is tried again next time the trip is planned.
    void p.then((x) => { if (!x.route) known.delete(key); });
  }
  return p;
}

/** The lorry route between two of the planner's places for this truck: null while loading, or
 *  when there isn't one (then `note` may say why). */
export function useTruckRoute(origin: string | undefined, from: string, to: string, vehicle: Vehicle | null): { route: TruckRoute | null; note: string | null; loading: boolean } {
  const query = vehicle && from !== to ? routeQuery(from, to, vehicle) : null;
  const [state, setState] = useState<{ query: string | null; route: TruckRoute | null; note: string | null }>({ query: null, route: null, note: null });
  useEffect(() => {
    if (!origin || !query) return;
    let live = true;
    void load(origin, query).then((r) => { if (live) setState({ query, ...r }); });
    return () => { live = false; };
  }, [origin, query]);
  const current = state.query === query;
  return { route: current ? state.route : null, note: current ? state.note : null, loading: !!origin && !!query && !current };
}
