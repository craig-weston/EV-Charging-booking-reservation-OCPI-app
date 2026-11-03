// Where a depot's electricity prices come from. Four ways, from any supplier:
//
//   octopus    Octopus Energy's public API: live half-hourly prices (Agile, business Agile,
//              half-hourly business tariffs, Go…), region worked out from the depot's postcode.
//   wholesale  For wholesale-linked ("pass-through") contracts with any supplier: Elexon's
//              half-hourly Market Index Price plus the fleet's own uplift for non-energy costs.
//   fixed      Any supplier's fixed rates: one all-day rate, optionally with timed rates.
//   feed       Any supplier that publishes a price file: a URL returning half-hourly prices.
//
// Live sources fill half-hours that aren't published yet (Agile's next day arrives about 4pm) with
// the same half-hour a day earlier, and say so.

export type SupplySource = "fixed" | "octopus" | "wholesale" | "feed";

export interface OctopusProduct { code: string; label: string; business: boolean; note: string }

/** Common Octopus tariffs with live half-hourly or time-of-use prices. Any other code works too. */
export const OCTOPUS_PRODUCTS: OctopusProduct[] = [
  { code: "AGILE-BUS-25-02-05", label: "Shape Shifters: Agile (business)", business: true, note: "Half-hourly prices that follow the wholesale market" },
  { code: "BUS-VAR-ADVANCED-AUG25-TOU-MHHS", label: "Flexible Octopus, half-hourly (business)", business: true, note: "Half-hourly business tariff under MHHS" },
  { code: "AGILE-24-10-01", label: "Agile Octopus", business: false, note: "Half-hourly prices that follow the wholesale market" },
  { code: "IOG-SMB-VAR-26-10-29", label: "Intelligent Octopus Go", business: false, note: "Cheap overnight rate for smart charging" },
  { code: "GO-VAR-22-10-14", label: "Octopus Go", business: false, note: "Cheap overnight rate" },
];

export const OCTOPUS_REGIONS = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P"] as const;

export const REGION_NAMES: Record<string, string> = {
  A: "East England", B: "East Midlands", C: "London", D: "Merseyside and North Wales", E: "West Midlands", F: "North East England",
  G: "North West England", H: "Southern England", J: "South East England", K: "South Wales", L: "South West England", M: "Yorkshire",
  N: "South Scotland", P: "North Scotland",
};

export const SOURCE_LABEL: Record<SupplySource, string> = {
  octopus: "Octopus Energy (live prices)",
  wholesale: "Wholesale-linked (any supplier)",
  fixed: "Fixed rates (any supplier)",
  feed: "Price feed (any supplier)",
};

export const validProduct = (s: unknown): s is string => typeof s === "string" && /^[A-Z0-9][A-Z0-9-]{2,59}$/.test(s);

/** A half-hourly price series, £/kWh before VAT. */
export interface PriceSeries {
  points: { from: string; price: number }[];
  /** Where it came from, for labels: "octopus", "elexon" or "feed". */
  source: string;
}

export interface FilledPrices {
  priceAt(t: number): number;
  /** First half-hour that is estimated (copied from a day earlier), or null if all are published. */
  estimatedFrom: number | null;
  /** True when no live prices were available and the fallback was used throughout. */
  allFallback: boolean;
}

const HALF = 30 * 60_000;
const DAY = 24 * 60 * 60_000;

/**
 * Prices for [from, to): published half-hours as they are; missing ones from the same half-hour on
 * one of the previous seven days; anything else from `fallback`.
 */
export function fillPrices(series: PriceSeries | null, from: number, to: number, fallback: (t: number) => number, adjust: (p: number) => number = (p) => p): FilledPrices {
  const have = new Map<number, number>();
  for (const p of series?.points ?? []) {
    const t = Date.parse(p.from);
    if (Number.isFinite(t) && Number.isFinite(p.price)) have.set(Math.floor(t / HALF) * HALF, p.price);
  }
  let estimatedFrom: number | null = null;
  const filled = new Map<number, number>();
  for (let t = Math.floor(from / HALF) * HALF; t < to; t += HALF) {
    if (have.has(t)) { filled.set(t, adjust(have.get(t)!)); continue; }
    // Not published: the same half-hour on a recent day, else the fallback. Either way, estimated.
    if (estimatedFrom == null || t < estimatedFrom) estimatedFrom = t;
    let v: number | undefined;
    for (let k = 1; k <= 7 && v == null; k++) v = have.get(t - k * DAY);
    if (v != null) filled.set(t, adjust(v));
  }
  const allFallback = have.size === 0;
  return {
    priceAt: (t: number) => filled.get(Math.floor(t / HALF) * HALF) ?? fallback(t),
    estimatedFrom: allFallback ? null : estimatedFrom,
    allFallback,
  };
}

/** Parse Octopus standard-unit-rates results (p/kWh) into £/kWh. */
export function parseOctopusRates(json: unknown): PriceSeries {
  const rows = ((json as { results?: { value_exc_vat?: number; valid_from?: string; valid_to?: string | null }[] })?.results ?? []);
  const points: PriceSeries["points"] = [];
  for (const r of rows) {
    if (typeof r.value_exc_vat !== "number" || !r.valid_from) continue;
    const a = Date.parse(r.valid_from);
    const b = r.valid_to ? Date.parse(r.valid_to) : a + HALF;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    // Time-of-use tariffs return long periods; split them into half-hours (capped at 8 days).
    for (let t = a, n = 0; t < b && n < 384; t += HALF, n++) points.push({ from: new Date(t).toISOString(), price: Math.round(r.value_exc_vat * 100) / 10000 });
  }
  return { points, source: "octopus" };
}

/** Parse Elexon Market Index Data (APX, £/MWh) into £/kWh energy prices. */
export function parseElexonMid(json: unknown): PriceSeries {
  const rows = ((json as { data?: { startTime?: string; price?: number; dataProvider?: string; volume?: number }[] })?.data ?? []);
  const points: PriceSeries["points"] = [];
  for (const r of rows) {
    if (!r.startTime || typeof r.price !== "number") continue;
    if (r.dataProvider && r.dataProvider !== "APXMIDP") continue;
    if (r.volume === 0 && r.price === 0) continue; // no trades in that period
    points.push({ from: new Date(r.startTime).toISOString(), price: Math.round(r.price * 100) / 100000 });
  }
  return { points, source: "elexon" };
}

/**
 * Parse a supplier price feed: `[{ "start": ISO, "price": £/kWh }]`, `{ "data": [...] }`, or
 * Octopus-style `{ "results": [...] }`. Prices above £5 are taken to be pence and converted.
 */
export function parseFeed(json: unknown): PriceSeries {
  const j = json as { data?: unknown; results?: unknown };
  if (j && typeof j === "object" && Array.isArray(j.results)) return { ...parseOctopusRates(json), source: "feed" };
  const rows = (Array.isArray(json) ? json : Array.isArray(j?.data) ? j.data : []) as { start?: string; from?: string; valid_from?: string; price?: number; value?: number }[];
  const points: PriceSeries["points"] = [];
  for (const r of rows.slice(0, 2000)) {
    const start = r.start ?? r.from ?? r.valid_from;
    let price = typeof r.price === "number" ? r.price : typeof r.value === "number" ? r.value : NaN;
    if (!start || !Number.isFinite(price) || !Number.isFinite(Date.parse(start))) continue;
    if (Math.abs(price) > 5) price = price / 100;
    points.push({ from: new Date(start).toISOString(), price: Math.round(price * 10000) / 10000 });
  }
  return { points, source: "feed" };
}
