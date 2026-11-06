// Live market data: Octopus Energy tariffs, Elexon wholesale prices, supplier price feeds and the
// NESO Carbon Intensity API — all free, public, no keys.
//
// In live mode the Worker calls these services directly and caches the answers. The in-browser
// demo can't (and shouldn't make visitors' browsers call third parties), so when it runs on a real
// deployment it asks this app's own public, cached endpoints instead:
//   GET /api/public/prices?source=octopus&product=…&region=B&from=…&to=…
//   GET /api/public/prices?source=wholesale&from=…&to=…
//   GET /api/public/region?postcode=NN4 7AB
//   GET /api/public/carbon?postcode=NN4 7AB&from=…&to=…
//   GET /api/public/sites  (public charging sites from open data, refreshed daily; docs/open-data.md)
// Without either (tests, the offline preview) callers fall back to modelled data and say so.
import type { Ctx } from "./context";
import { parseElexonMid, parseFeed, parseOctopusRates, validProduct, OCTOPUS_REGIONS, type PriceSeries } from "../shared/energy/suppliers";
import { outcode } from "../shared/energy/carbon";
import { carbonFor } from "./energy";
import { RouteUnavailable, truckRoute } from "./routing";

export type MarketDeps = Pick<Ctx, "mode" | "now" | "transport"> & { marketUrl?: string; sitesUrl?: string; env?: { ORS_API_KEY?: string }; store?: Ctx["store"] };

/** The daily open-data snapshot (.github/workflows/opendata.yml); OPEN_SITES_URL overrides it. */
export const OPEN_SITES_URL = "https://github.com/craig-weston/EV-Charging-booking-reservation-OCPI-app/releases/download/opendata/sites.json";

const OCTOPUS = "https://api.octopus.energy/v1";
const ELEXON = "https://data.elexon.co.uk/bmrs/api/v1";
const HALF = 30 * 60_000;
const MAX_PRICE_RANGE = 9 * 24 * 60 * 60_000;
const cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttl: number, now: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value as Promise<T>;
  const value = load().catch(() => null) as Promise<T>;
  cache.set(key, { at: now, ttl, value });
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  return value;
}

async function getJson(d: MarketDeps, url: string, timeoutMs = 5000): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await d.transport(new Request(url, { headers: { Accept: "application/json" }, signal: ctl.signal }));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const clampRange = (from: number, to: number) => ({ from: Math.floor(Math.max(from, to - MAX_PRICE_RANGE) / HALF) * HALF, to: Math.ceil(to / HALF) * HALF });

/** Through this app's public endpoint (demo on a real deployment), or null. */
async function viaPublic<T>(d: MarketDeps, path: string): Promise<T | null> {
  if (!d.marketUrl) return null;
  const j = (await getJson(d, `${d.marketUrl.replace(/\/+$/, "")}/api/public/${path}`)) as { data?: T } | null;
  return j?.data ?? null;
}

/** The Octopus/DNO region letter (A–P) for a postcode, or null. */
export async function octopusRegion(d: MarketDeps, postcode: string | null | undefined): Promise<string | null> {
  const area = outcode(postcode);
  if (!area) return null;
  if (d.mode !== "live") return (await viaPublic<{ region: string | null }>(d, `region?postcode=${encodeURIComponent(area)}`))?.region ?? null;
  return cached(`region|${area}`, 7 * 24 * 3_600_000, d.now().getTime(), async () => {
    const j = (await getJson(d, `${OCTOPUS}/industry/grid-supply-points/?postcode=${encodeURIComponent(area)}`)) as { results?: { group_id?: string }[] } | null;
    const g = j?.results?.[0]?.group_id?.replace(/^_/, "") ?? null;
    return g && (OCTOPUS_REGIONS as readonly string[]).includes(g) ? g : null;
  });
}

/** Octopus half-hourly unit rates for a product in a region, £/kWh ex VAT. */
export async function octopusRates(d: MarketDeps, product: string, region: string, fromMs: number, toMs: number): Promise<PriceSeries | null> {
  if (!validProduct(product) || !(OCTOPUS_REGIONS as readonly string[]).includes(region)) return null;
  const { from, to } = clampRange(fromMs, toMs);
  if (d.mode !== "live") return viaPublic<PriceSeries>(d, `prices?source=octopus&product=${encodeURIComponent(product)}&region=${region}&from=${iso(from)}&to=${iso(to)}`);
  const ttl = 30 * 60_000;
  return cached(`oct|${product}|${region}|${from}|${to}`, ttl, d.now().getTime(), async () => {
    const tariff = `E-1R-${product}-${region}`;
    const j = await getJson(d, `${OCTOPUS}/products/${encodeURIComponent(product)}/electricity-tariffs/${encodeURIComponent(tariff)}/standard-unit-rates/?period_from=${iso(from)}&period_to=${iso(to)}&page_size=1500`);
    if (!j) return null;
    const s = parseOctopusRates(j);
    return s.points.length ? s : null;
  });
}

/** Elexon Market Index Price (APX), half-hourly, as £/kWh energy cost. */
export async function wholesaleRates(d: MarketDeps, fromMs: number, toMs: number): Promise<PriceSeries | null> {
  const { from, to } = clampRange(fromMs, toMs);
  if (d.mode !== "live") return viaPublic<PriceSeries>(d, `prices?source=wholesale&from=${iso(from)}&to=${iso(to)}`);
  return cached(`mid|${from}|${to}`, 30 * 60_000, d.now().getTime(), async () => {
    // Published as trading happens: ask for the week before too, so tomorrow can be estimated.
    const j = await getJson(d, `${ELEXON}/balancing/pricing/market-index?from=${iso(from - 7 * 24 * 3_600_000)}&to=${iso(to)}&dataProviders=APXMIDP`);
    if (!j) return null;
    const s = parseElexonMid(j);
    return s.points.length ? s : null;
  });
}

/** A supplier's own price feed (live only; the URL is checked when it's saved). */
export async function feedRates(d: MarketDeps, url: string): Promise<PriceSeries | null> {
  if (d.mode !== "live" || !/^https:\/\//.test(url)) return null;
  return cached(`feed|${url}`, 30 * 60_000, d.now().getTime(), async () => {
    const j = await getJson(d, url);
    if (!j) return null;
    const s = parseFeed(j);
    return s.points.length ? s : null;
  });
}

// --- public endpoints ------------------------------------------------------------------------

const json = (data: unknown, status = 200, maxAge = 900) =>
  new Response(JSON.stringify(status === 200 ? { data } : { error: data }), { status, headers: { "Content-Type": "application/json", "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store" } });

/** The open-data snapshot, passed through without parsing (it can be a few hundred KB). */
async function openSites(d: MarketDeps): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await d.transport(new Request(d.sitesUrl || OPEN_SITES_URL, { headers: { Accept: "application/json" }, redirect: "follow", signal: ctl.signal }));
    const text = res.ok ? await res.text() : "";
    if (!text.startsWith("{") || text.length > 12_000_000) return json({ message: "Open data isn't available right now" }, 503);
    return new Response(`{"data":${text}}`, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return json({ message: "Open data isn't available right now" }, 503);
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/public/{prices,region,carbon,sites}: public data, cached; no account needed. */
export async function handlePublicMarket(req: Request, d: MarketDeps): Promise<Response> {
  if (req.method !== "GET") return json({ message: "Use GET" }, 405);
  const url = new URL(req.url);
  const what = url.pathname.replace(/^\/api\/public\/?/, "").replace(/\/+$/, "");
  if (what === "sites") return openSites(d);
  // Lorry routes for the trip planner (server/routing.ts), kept a week.
  if (what === "route") {
    try {
      return json(await truckRoute(d, url.searchParams), 200, 7 * 86400);
    } catch (e) {
      if (e instanceof RouteUnavailable) return json({ message: e.message }, e.status);
      throw e;
    }
  }
  const now = d.now().getTime();
  const time = (k: string, dflt: number) => { const t = Date.parse(url.searchParams.get(k) ?? ""); return Number.isFinite(t) ? t : dflt; };
  const from = time("from", now - HALF), to = time("to", now + 36 * 3_600_000);
  if (!(to > from)) return json({ message: "to must be after from" }, 400);
  const live = d; // the demo keeps its own mode, so it goes through marketUrl
  if (what === "region") return json({ region: await octopusRegion(live, url.searchParams.get("postcode")) }, 200, 86400);
  if (what === "carbon") return json(await carbonFor(live as Ctx, url.searchParams.get("postcode"), new Date(from).toISOString(), new Date(to).toISOString()));
  if (what === "prices") {
    const source = url.searchParams.get("source");
    if (source === "octopus") {
      const product = (url.searchParams.get("product") ?? "").toUpperCase();
      const region = (url.searchParams.get("region") ?? "").toUpperCase();
      if (!validProduct(product)) return json({ message: "Unknown product code" }, 400);
      if (!(OCTOPUS_REGIONS as readonly string[]).includes(region)) return json({ message: "region must be a letter A–P" }, 400);
      return json(await octopusRates(live, product, region, from, to));
    }
    if (source === "wholesale") return json(await wholesaleRates(live, from, to));
    return json({ message: "source must be octopus or wholesale" }, 400);
  }
  return json({ message: "Not found" }, 404);
}
