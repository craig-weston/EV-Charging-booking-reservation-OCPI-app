// Fleets' reports on public sites ("an artic fits" / "no room"): everyone's totals from this
// deployment's /api/public/site-reports, this fleet's own from its API, and saving a new one.
import { useCallback, useEffect, useState } from "react";
import type { MySiteReports, SiteTally, SiteVerdict, TruckClass } from "../../shared/opendata/reports";

type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export interface SiteReports {
  tallies: Record<string, SiteTally>;
  mine: Record<string, MySiteReports>;
  /** Save this fleet's report for a site (null withdraws it). */
  report(site: string, truck: TruckClass, verdict: SiteVerdict | null): Promise<void>;
}

/** Take one fleet's report out of, or put it into, a site's totals (so the panel updates at once). */
function adjust(t: SiteTally | undefined, truck: TruckClass, was: SiteVerdict | undefined, now: SiteVerdict | null): SiteTally | undefined {
  const c = { ...(t?.[truck] ?? { fits: 0, no_room: 0 }) };
  if (was) c[was] = Math.max(0, c[was] - 1);
  if (now) c[now] += 1;
  const out: SiteTally = { ...(t ?? { latest: new Date().toISOString() }), [truck]: c };
  if (now) out.latest = new Date().toISOString();
  const any = (["artic", "rigid"] as TruckClass[]).some((k) => (out[k]?.fits ?? 0) + (out[k]?.no_room ?? 0) > 0);
  return any ? out : undefined;
}

export function useSiteReports(origin: string | undefined, api: Api, fleetId: string | null): SiteReports {
  const [tallies, setTallies] = useState<Record<string, SiteTally>>({});
  const [mine, setMine] = useState<Record<string, MySiteReports>>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      const [pub, own] = await Promise.all([
        origin ? fetch(`${origin.replace(/\/+$/, "")}/api/public/site-reports`, { headers: { Accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).then((j: { data?: Record<string, SiteTally> } | null) => j?.data ?? {}).catch(() => ({})) : Promise.resolve({}),
        fleetId ? api<Record<string, MySiteReports>>("GET", `/fleets/${fleetId}/site-reports`).catch(() => ({})) : Promise.resolve({}),
      ]);
      if (!live) return;
      // Where this fleet's reports aren't in the public totals (the demo keeps them in the browser), add them.
      const merged: Record<string, SiteTally> = { ...(pub as Record<string, SiteTally>) };
      for (const [site, m] of Object.entries(own as Record<string, MySiteReports>)) {
        for (const truck of ["artic", "rigid"] as TruckClass[]) {
          const v = m[truck];
          if (v && !((merged[site]?.[truck]?.[v] ?? 0) > 0)) { const t = adjust(merged[site], truck, undefined, v); if (t) merged[site] = t; }
        }
      }
      setTallies(merged); setMine(own as Record<string, MySiteReports>);
    })();
    return () => { live = false; };
  }, [origin, api, fleetId]);
  const report = useCallback(async (site: string, truck: TruckClass, verdict: SiteVerdict | null) => {
    if (!fleetId) return;
    const res = await api<{ mine: MySiteReports }>("PUT", `/fleets/${fleetId}/site-reports`, { site, truck, verdict });
    setMine((m) => {
      const was = m[site]?.[truck];
      setTallies((t) => { const next = { ...t }; const a = adjust(t[site], truck, was, verdict); if (a) next[site] = a; else delete next[site]; return next; });
      return { ...m, [site]: res.mine };
    });
  }, [api, fleetId]);
  return { tallies, mine, report };
}
