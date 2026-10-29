// Grid carbon intensity, half-hourly, in g CO2 per kWh. Live data comes from NESO's free Carbon
// Intensity API (regional forecast by postcode district, 48 hours ahead, and history). When that
// isn't reachable, or in demo mode, a modelled series with the usual GB daily shape stands in and
// is labelled as such everywhere it's shown.
import { MINUTE } from "../util";

export const HALF_HOUR = 30 * MINUTE;

export interface CarbonPoint {
  /** Start of the half-hour, ISO. */
  from: string;
  /** g CO2/kWh. */
  intensity: number;
  /** True when this half-hour is modelled rather than from NESO. */
  modelled?: boolean;
}

export interface CarbonSeries {
  /** NESO region name, e.g. "East Midlands", when known. */
  region: string | null;
  /** "neso" when every point is NESO data, "mixed" when gaps were modelled, "modelled" otherwise. */
  source: "neso" | "mixed" | "modelled";
  points: CarbonPoint[];
}

/** Bands for labels and colour. Fixed g/kWh thresholds so a band means the same thing every day. */
export const CARBON_BANDS = [
  { max: 60, label: "Very low" },
  { max: 110, label: "Low" },
  { max: 170, label: "Moderate" },
  { max: 230, label: "High" },
  { max: Infinity, label: "Very high" },
] as const;

export function carbonBand(g: number): { level: 0 | 1 | 2 | 3 | 4; label: string } {
  const i = CARBON_BANDS.findIndex((b) => g < b.max);
  return { level: Math.max(0, i) as 0 | 1 | 2 | 3 | 4, label: CARBON_BANDS[Math.max(0, i)].label };
}

export const floorHalfHour = (t: number) => Math.floor(t / HALF_HOUR) * HALF_HOUR;

/** "NN4 7PB" → "NN4"; "nn47pb" → "NN4". Null when it doesn't look like a UK postcode. */
export function outcode(postcode: string | null | undefined): string | null {
  const s = (postcode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 2) return null;
  if (s.length >= 5) return s.slice(0, s.length - 3);
  return /^[A-Z]{1,2}\d[A-Z\d]?$/.test(s) ? s : null;
}

// --- Modelled series ---------------------------------------------------------------------------

/** Typical GB shape by hour of day (UK time), g/kWh, before weather and season. */
const HOURLY = [104, 98, 93, 90, 92, 99, 116, 136, 146, 140, 128, 118, 111, 108, 113, 125, 146, 166, 171, 160, 145, 132, 120, 111];

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

const ukHour = (() => {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  return (d: Date) => { const [h, m] = f.format(d).split(":").map(Number); return h + m / 60; };
})();

/** Wind: a slowly varying multiplier, smooth across days (0.55 windy … 1.35 still). */
function windFactor(t: number, seed: string): number {
  const day = t / (24 * 60 * MINUTE);
  const d0 = Math.floor(day), f = day - d0;
  const a = hash01(`${seed}:${d0}`), b = hash01(`${seed}:${d0 + 1}`);
  const k = (1 - Math.cos(Math.PI * f)) / 2;
  return 0.55 + 0.8 * (a * (1 - k) + b * k);
}

/** Modelled g/kWh at an instant, deterministic for (time, region). */
export function modelledIntensity(at: Date, region = "GB"): number {
  const t = at.getTime();
  const h = ukHour(at);
  const h0 = Math.floor(h) % 24, h1 = (h0 + 1) % 24, f = h - Math.floor(h);
  const shape = HOURLY[h0] * (1 - f) + HOURLY[h1] * f;
  const month = at.getUTCMonth();
  const season = 1 + 0.14 * Math.cos(((month + 0.5) / 12) * 2 * Math.PI); // winter higher
  const regional = 0.85 + 0.3 * hash01(`region:${region}`);
  const noise = 0.94 + 0.12 * hash01(`${region}:${floorHalfHour(t)}`);
  return Math.round(shape * season * regional * windFactor(t, region) * noise);
}

export function modelledSeries(from: Date, to: Date, region = "GB"): CarbonSeries {
  const points: CarbonPoint[] = [];
  for (let t = floorHalfHour(from.getTime()); t < to.getTime(); t += HALF_HOUR) {
    points.push({ from: new Date(t).toISOString(), intensity: modelledIntensity(new Date(t + HALF_HOUR / 2), region), modelled: true });
  }
  return { region: null, source: "modelled", points };
}

// --- Reading a series --------------------------------------------------------------------------

function indexOf(series: CarbonSeries) {
  const m = new Map<number, number>();
  for (const p of series.points) m.set(new Date(p.from).getTime(), p.intensity);
  return m;
}
const idxCache = new WeakMap<CarbonSeries, Map<number, number>>();
function idx(series: CarbonSeries) {
  let m = idxCache.get(series);
  if (!m) { m = indexOf(series); idxCache.set(series, m); }
  return m;
}

export function intensityAt(series: CarbonSeries | null, at: Date): number | null {
  if (!series) return null;
  return idx(series).get(floorHalfHour(at.getTime())) ?? null;
}

/** Time-weighted average g/kWh over [start, end); null if any half-hour is missing. */
export function averageIntensity(series: CarbonSeries | null, start: Date, end: Date): number | null {
  if (!series) return null;
  const m = idx(series);
  if (!(end > start)) return m.get(floorHalfHour(start.getTime())) ?? null;
  let sum = 0, w = 0;
  for (let t = floorHalfHour(start.getTime()); t < end.getTime(); t += HALF_HOUR) {
    const v = m.get(t);
    if (v == null) return null;
    const overlap = Math.min(end.getTime(), t + HALF_HOUR) - Math.max(start.getTime(), t);
    sum += v * overlap; w += overlap;
  }
  return w ? sum / w : null;
}

/** Shape of NESO's regional responses (by postcode, with or without a time range). */
interface NesoRegional {
  data?: { regionid?: number; shortname?: string; data?: { from: string; to: string; intensity?: { forecast?: number; actual?: number | null } }[] }
    | { regionid?: number; shortname?: string; data?: { from: string; intensity?: { forecast?: number } }[] }[];
}

export function parseNeso(json: unknown): { region: string | null; points: CarbonPoint[] } {
  const d = (json as NesoRegional)?.data;
  const block = Array.isArray(d) ? d[0] : d;
  const rows = block?.data ?? [];
  const points: CarbonPoint[] = [];
  for (const r of rows) {
    const g = (r.intensity as { actual?: number | null; forecast?: number } | undefined);
    const v = g?.actual ?? g?.forecast;
    const t = new Date(r.from.replace(/Z?$/, "Z")).getTime();
    if (typeof v === "number" && Number.isFinite(v) && Number.isFinite(t)) points.push({ from: new Date(t).toISOString(), intensity: Math.round(v) });
  }
  return { region: block?.shortname ?? null, points };
}

/** Fill any half-hours NESO didn't cover with modelled values, so callers always get a full range. */
export function completeSeries(from: Date, to: Date, neso: { region: string | null; points: CarbonPoint[] } | null, regionSeed: string): CarbonSeries {
  const have = new Map((neso?.points ?? []).map((p) => [new Date(p.from).getTime(), p.intensity]));
  const points: CarbonPoint[] = [];
  let modelled = 0;
  for (let t = floorHalfHour(from.getTime()); t < to.getTime(); t += HALF_HOUR) {
    const v = have.get(t);
    if (v != null) points.push({ from: new Date(t).toISOString(), intensity: v });
    else { modelled++; points.push({ from: new Date(t).toISOString(), intensity: modelledIntensity(new Date(t + HALF_HOUR / 2), regionSeed), modelled: true }); }
  }
  const source = modelled === 0 ? "neso" : modelled === points.length ? "modelled" : "mixed";
  return { region: neso?.region ?? null, source, points };
}
