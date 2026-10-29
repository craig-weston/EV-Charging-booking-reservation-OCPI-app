// Carbon intensity series for the UI, fetched once per site and range and shared between screens.
import { useEffect, useState } from "react";
import { HALF_HOUR, floorHalfHour, type CarbonSeries } from "../../shared/energy/carbon";
import { useApp } from "./state";

const cache = new Map<string, { at: number; value: Promise<CarbonSeries | null> }>();
const TTL = 15 * 60_000;

/** Half-hourly grid carbon for a postcode over [from, to). Null while loading or on failure. */
export function useCarbon(postcode: string | null | undefined, from: Date | null, to: Date | null): CarbonSeries | null {
  const { api } = useApp();
  const f = from ? floorHalfHour(from.getTime()) : null;
  const t = to ? floorHalfHour(to.getTime() - 1) + HALF_HOUR : null;
  const key = postcode && f != null && t != null ? `${postcode}|${f}|${t}` : null;
  const [series, setSeries] = useState<{ key: string; value: CarbonSeries | null } | null>(null);

  useEffect(() => {
    if (!key || f == null || t == null || !postcode) return;
    let alive = true;
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > TTL) {
      const value = api<CarbonSeries>("GET", `/energy/carbon?postcode=${encodeURIComponent(postcode)}&from=${new Date(f).toISOString()}&to=${new Date(t).toISOString()}`).catch(() => null);
      hit = { at: Date.now(), value };
      cache.set(key, hit);
    }
    void hit.value.then((v) => { if (alive) setSeries({ key, value: v }); });
    return () => { alive = false; };
  }, [api, key, f, t, postcode]);

  return series && series.key === key ? series.value : null;
}

/** Many series at once (Savings): caller-chosen key → series. */
export function useCarbonMany(requests: { key: string; postcode: string; from: Date; to: Date }[]): Map<string, CarbonSeries> {
  const { api } = useApp();
  const sig = requests.map((r) => `${r.key}|${r.postcode}|${floorHalfHour(r.from.getTime())}|${floorHalfHour(r.to.getTime())}`).sort().join(",");
  const [out, setOut] = useState<{ sig: string; map: Map<string, CarbonSeries> }>({ sig: "", map: new Map() });
  useEffect(() => {
    if (!sig) return;
    let alive = true;
    void Promise.all(requests.map(async (r) => {
      const f = floorHalfHour(r.from.getTime()), t = floorHalfHour(r.to.getTime() - 1) + HALF_HOUR;
      const ck = `${r.postcode}|${f}|${t}`;
      let hit = cache.get(ck);
      if (!hit || Date.now() - hit.at > TTL) {
        hit = { at: Date.now(), value: api<CarbonSeries>("GET", `/energy/carbon?postcode=${encodeURIComponent(r.postcode)}&from=${new Date(f).toISOString()}&to=${new Date(t).toISOString()}`).catch(() => null) };
        cache.set(ck, hit);
      }
      return [r.key, await hit.value] as const;
    })).then((pairs) => {
      if (!alive) return;
      const map = new Map<string, CarbonSeries>();
      for (const [k, v] of pairs) if (v) map.set(k, v);
      setOut({ sig, map });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sig]);
  return out.sig === sig ? out.map : EMPTY;
}
const EMPTY = new Map<string, CarbonSeries>();

export const SOURCE_NOTE: Record<CarbonSeries["source"], string> = {
  neso: "NESO regional carbon forecast",
  mixed: "NESO forecast, modelled beyond 48 hours",
  modelled: "Modelled carbon (typical GB pattern)",
};
