// Grid carbon intensity for a site, half-hourly. Live mode asks NESO's free Carbon Intensity API
// (https://carbonintensity.org.uk, no key needed) for the postcode district and fills any gaps,
// such as beyond its 48-hour forecast, with the modelled series. Demo mode is fully modelled so it
// works offline and never calls out from a visitor's browser.
import type { Ctx } from "./context";
import { HALF_HOUR, completeSeries, floorHalfHour, modelledSeries, outcode, parseNeso, type CarbonSeries } from "../shared/energy/carbon";

const NESO = "https://api.carbonintensity.org.uk";
const MAX_RANGE_MS = 35 * 24 * 60 * 60_000;
const CHUNK_MS = 13 * 24 * 60 * 60_000; // NESO caps regional ranges at 14 days
const TTL_FORECAST = 30 * 60_000;
const TTL_PAST = 12 * 60 * 60_000;
const cache = new Map<string, { at: number; value: Promise<{ region: string | null; points: CarbonSeries["points"] } | null> }>();

const isoMin = (t: number) => new Date(t).toISOString().slice(0, 16) + "Z";

async function nesoChunk(ctx: Ctx, area: string, from: number, to: number) {
  const key = `${area}|${from}|${to}`;
  const now = ctx.now().getTime();
  const hit = cache.get(key);
  const ttl = to < now ? TTL_PAST : TTL_FORECAST;
  if (hit && now - hit.at < ttl) return hit.value;
  const value = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await ctx.transport(new Request(`${NESO}/regional/intensity/${isoMin(from)}/${isoMin(to)}/postcode/${encodeURIComponent(area)}`, { headers: { Accept: "application/json" }, signal: ctl.signal }));
      if (!res.ok) return null;
      return parseNeso(await res.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  cache.set(key, { at: now, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

export async function carbonFor(ctx: Ctx, postcode: string | null, fromIso: string | null, toIso: string | null): Promise<CarbonSeries> {
  const now = ctx.now().getTime();
  let from = fromIso ? new Date(fromIso).getTime() : now - HALF_HOUR;
  let to = toIso ? new Date(toIso).getTime() : now + 48 * 60 * 60_000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { from = now - HALF_HOUR; to = now + 48 * 60 * 60_000; }
  if (to - from > MAX_RANGE_MS) from = to - MAX_RANGE_MS;
  from = floorHalfHour(from);
  to = floorHalfHour(to - 1) + HALF_HOUR;
  const area = outcode(postcode);
  const seed = area ?? "GB";
  if (ctx.mode !== "live" || !area) return { ...modelledSeries(new Date(from), new Date(to), seed), region: null };

  const parts: Promise<Awaited<ReturnType<typeof nesoChunk>>>[] = [];
  for (let s = from; s < to; s += CHUNK_MS) parts.push(nesoChunk(ctx, area, s, Math.min(to, s + CHUNK_MS)));
  const got = (await Promise.all(parts)).filter((x): x is NonNullable<typeof x> => !!x);
  const merged = got.length ? { region: got.find((g) => g.region)?.region ?? null, points: got.flatMap((g) => g.points) } : null;
  return completeSeries(new Date(from), new Date(to), merged, seed);
}
