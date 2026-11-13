// What fleets say about public sites. Operators' open data almost never says whether a lorry fits,
// so planners and drivers who have been there can say: "an artic fits" or "no room". One report per
// fleet, per site, per kind of truck (the latest replaces the last); everyone sees the totals.
import type { VehicleType } from "../ocpi/types";

export type TruckClass = "artic" | "rigid";
export type SiteVerdict = "fits" | "no_room";

export interface SiteReport {
  verdict: SiteVerdict;
  /** When it was reported (ISO). */
  at: string;
}

/** Reports for one site: how many fleets said what, for each kind of truck. */
export interface SiteTally {
  artic?: { fits: number; no_room: number };
  rigid?: { fits: number; no_room: number };
  /** The most recent report (ISO). */
  latest: string;
}

/** A fleet's own reports for one site. */
export type MySiteReports = Partial<Record<TruckClass, SiteVerdict>>;

export const TRUCK_CLASSES: TruckClass[] = ["artic", "rigid"];
export const TRUCK_LABEL: Record<TruckClass, string> = { artic: "an artic", rigid: "a rigid" };

/** Artics are tractor-and-trailer combinations (or anything as long as one); the rest are rigids. */
export function truckClass(v: { vehicle_type?: VehicleType | string | null; length_cm?: number | null } | null | undefined): TruckClass {
  if (!v) return "artic";
  const t = v.vehicle_type ?? "";
  return t === "SEMI_TRACTOR" || t === "TRUCK_WITH_TRAILER" || (v.length_cm ?? 0) >= 1300 ? "artic" : "rigid";
}

export const isVerdict = (v: unknown): v is SiteVerdict => v === "fits" || v === "no_room";
export const isTruckClass = (v: unknown): v is TruckClass => v === "artic" || v === "rigid";
/** Open-data site ids look like `mfg:1234` (shared/opendata/sites.ts). */
export const isSiteId = (v: unknown): v is string => typeof v === "string" && v.length <= 160 && /^[a-z0-9_-]{1,24}:[^\s/]{1,130}$/i.test(v);

export function addToTally(t: SiteTally | undefined, truck: TruckClass, r: SiteReport): SiteTally {
  const out: SiteTally = t ? { ...t } : { latest: r.at };
  const c = { ...(out[truck] ?? { fits: 0, no_room: 0 }) };
  c[r.verdict] += 1;
  out[truck] = c;
  if (r.at > out.latest) out.latest = r.at;
  return out;
}

/** What the reports add up to for this kind of truck: "fits", "no_room", "mixed", or null (none). */
export function reportedFit(t: SiteTally | null | undefined, truck: TruckClass): "fits" | "no_room" | "mixed" | null {
  const c = t?.[truck];
  if (!c || c.fits + c.no_room === 0) return null;
  return c.no_room === 0 ? "fits" : c.fits === 0 ? "no_room" : "mixed";
}

const fleets = (n: number) => `${n} ${n === 1 ? "fleet says" : "fleets say"}`;

/** In words, for the site panel. */
export function tallyText(t: SiteTally | null | undefined, truck: TruckClass): string | null {
  const c = t?.[truck];
  const what = TRUCK_LABEL[truck];
  switch (reportedFit(t, truck)) {
    case "fits": return `${fleets(c!.fits)} ${what} fits`;
    case "no_room": return `${fleets(c!.no_room)} there's no room for ${what}`;
    case "mixed": return `Reports differ: ${c!.fits} say ${what} fits, ${c!.no_room} say there's no room`;
    default: return null;
  }
}
