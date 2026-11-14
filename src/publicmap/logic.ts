// The public charging map's rules, kept apart from the page so they can be tested: which sites a
// filter keeps, how the list is ordered, what search finds, and how a site's truck access reads.
import type { OpenSite } from "../../shared/opendata/sites";
import { TRUCK_LABEL, reportedFit, tallyText, type SiteTally, type TruckClass } from "../../shared/opendata/reports";

/** The truck the visitor is planning for: an artic or a rigid (see TRUCKS). */
export type Truck = TruckClass;

/**
 * Typical UK trucks, for the checks and the break estimate: a 44 t artic and a 26 t rigid. Energy
 * use is for a loaded truck on main roads; top charging rates are what today's electric trucks take
 * on CCS (MCS trucks take more, but few sites have it yet).
 */
export const TRUCKS: Record<Truck, { label: string; length_cm: number; height_cm: number; weight_kg: number; kwhPerKm: number; maxKw: number }> = {
  artic: { label: "Artic", length_cm: 1650, height_cm: 400, weight_kg: 44000, kwhPerKm: 1.25, maxKw: 375 },
  rigid: { label: "Rigid", length_cm: 1000, height_cm: 380, weight_kg: 26000, kwhPerKm: 0.9, maxKw: 250 },
};

export interface Filters {
  /** Lowest connector power to show, kW. */
  minKw: 150 | 350;
  /** Only sites with a megawatt (MCS) connector. */
  mcs: boolean;
  /** Only sites that suit trucks: built for them, or fleets say an artic fits. */
  trucks: boolean;
  /** One operator, or "" for all. */
  operator: string;
  /** Only sites open (or chargeable) around the clock. */
  open247: boolean;
}

export const NO_FILTERS: Filters = { minKw: 150, mcs: false, trucks: false, operator: "", open247: false };

/** How a pin is drawn: built for (or reported to suit) trucks, ultra-rapid (350 kW+), or rapid. */
export type Tier = "truck" | "ultra" | "rapid";

export type Tallies = Record<string, SiteTally>;

/** Suits this kind of truck: the operator says trucks fit (and the bay isn't too small for it), or fleets say it fits. */
export function suitsTrucks(s: OpenSite, t?: SiteTally | null, truck: Truck = "artic"): boolean {
  if (tooSmall(s, truck).length) return false;
  return s.hgv === "trucks" || reportedFit(t, truck) === "fits";
}
/** Where the operator publishes bay limits this truck is over: ["length", "height", "weight"]. */
export function tooSmall(s: OpenSite, truck: Truck): ("length" | "height" | "weight")[] {
  const t = TRUCKS[truck];
  const out: ("length" | "height" | "weight")[] = [];
  if (s.max_length_cm && s.max_length_cm < t.length_cm) out.push("length");
  if (s.max_height_cm && s.max_height_cm < t.height_cm) out.push("height");
  if (s.max_weight_kg && s.max_weight_kg < t.weight_kg) out.push("weight");
  return out;
}
export const hasMcs = (s: OpenSite) => s.connectors.some((c) => /mcs/i.test(c));

export function tier(s: OpenSite, t?: SiteTally | null, truck: Truck = "artic"): Tier {
  if (suitsTrucks(s, t, truck)) return "truck";
  return s.max_kw >= 350 ? "ultra" : "rapid";
}

export function keep(s: OpenSite, f: Filters, t?: SiteTally | null, truck: Truck = "artic"): boolean {
  if (s.max_kw < f.minKw) return false;
  if (f.mcs && !hasMcs(s)) return false;
  if (f.trucks && !suitsTrucks(s, t, truck)) return false;
  if (f.operator && s.operator !== f.operator) return false;
  if (f.open247 && s.open247 !== true) return false;
  return true;
}

export const isFiltered = (f: Filters) => f.minKw !== 150 || f.mcs || f.trucks || f.operator !== "" || f.open247;

/** Truck sites first, then the most powerful, then by name. */
export function order(a: OpenSite, b: OpenSite, tallies: Tallies, truck: Truck = "artic"): number {
  const ta = suitsTrucks(a, tallies[a.id], truck) ? 1 : 0, tb = suitsTrucks(b, tallies[b.id], truck) ? 1 : 0;
  return tb - ta || b.max_kw - a.max_kw || a.name.localeCompare(b.name);
}

/** Operators with how many sites each, most first. */
export function operatorCounts(sites: OpenSite[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const s of sites) m.set(s.operator, (m.get(s.operator) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** [west, south, east, north] */
export type Bounds = [number, number, number, number];
export const inBounds = (s: OpenSite, b: Bounds) => s.lon >= b[0] && s.lon <= b[2] && s.lat >= b[1] && s.lat <= b[3];

export interface Place { name: string; lat: number; lon: number }
export type Suggestion = { kind: "place"; place: Place } | { kind: "site"; site: OpenSite };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** What search finds: places (towns and freight hubs) whose name starts with the words, then sites. */
export function search(q: string, sites: OpenSite[], places: Place[], limit = 8): Suggestion[] {
  const n = norm(q);
  if (n.length < 2) return [];
  const pc = n.replace(/ /g, "");
  const out: Suggestion[] = places.filter((p) => norm(p.name).startsWith(n)).slice(0, 3).map((place) => ({ kind: "place", place }));
  const scored: { s: OpenSite; score: number }[] = [];
  for (const s of sites) {
    const name = norm(s.name), op = norm(s.operator), town = norm(s.city ?? ""), post = (s.postcode ?? "").toLowerCase().replace(/\s/g, "");
    const score = name.startsWith(n) ? 4 : name.includes(n) ? 3 : town.startsWith(n) ? 2.5 : post && pc.length >= 3 && post.startsWith(pc) ? 2.5 : op.startsWith(n) ? 2 : norm(s.address ?? "").includes(n) ? 1 : 0;
    if (score) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || b.s.max_kw - a.s.max_kw);
  for (const { s } of scored) { if (out.length >= limit) break; out.push({ kind: "site", site: s }); }
  return out;
}

export interface Access {
  tone: "ok" | "bad" | "check";
  /** One line: "Built for trucks", "2 fleets say an artic fits", "Bay size not published". */
  title: string;
  detail: string;
}

/** Whether this truck can use the site, from the operator's data and fleets' reports. */
export function access(s: OpenSite, t?: SiteTally | null, truck: Truck = "artic"): Access {
  const what = TRUCK_LABEL[truck];
  const fleets = tallyText(t, truck);
  const said = reportedFit(t, truck);
  const over = tooSmall(s, truck);
  if (over.length) return { tone: "bad", title: `Too small for ${what}`, detail: `The operator's bay limits are under a typical ${TRUCKS[truck].label.toLowerCase()}'s ${over.join(" and ")}.` };
  if (s.hgv === "trucks") return { tone: "ok", title: "Built for trucks", detail: [s.hgv_why, fleets].filter(Boolean).join(". ") };
  if (said === "fits") return { tone: "ok", title: fleets!, detail: "The operator doesn't publish bay sizes, but fleets who've been say it fits." };
  if (said === "no_room") return { tone: "bad", title: fleets!, detail: `The operator doesn't publish bay sizes. Check before sending ${what}.` };
  if (said === "mixed") return { tone: "check", title: "Fleets' reports differ", detail: `${fleets}. Check before sending ${what}.` };
  return { tone: "check", title: "Bay size not published", detail: `The operator doesn't say whether ${what} fits. Check before sending one.` };
}

export type Check = { key: string; state: "ok" | "bad" | "unknown"; label: string; text: string };

/** The HGV checklist on a site: bay, drive-through, megawatt charging, fleets' reports. */
export function checklist(s: OpenSite, t: SiteTally | null | undefined, truck: Truck): Check[] {
  const spec = TRUCKS[truck];
  const over = tooSmall(s, truck);
  const limits = bayLimits(s);
  const fleets = tallyText(t, truck);
  const said = reportedFit(t, truck);
  return [
    {
      key: "bay", label: "Bay size",
      state: over.length ? "bad" : limits || s.hgv === "trucks" ? "ok" : "unknown",
      text: over.length ? `Too small: ${limits}` : limits ? `${limits}, fits ${(spec.length_cm / 100).toFixed(1)} m` : s.hgv === "trucks" ? s.hgv_why || "Truck bays" : "Not published",
    },
    {
      key: "hours", label: "Open 24/7",
      state: s.open247 ? "ok" : s.open247 === false ? "bad" : "unknown",
      text: s.open247 ? "Charge any time, day or night" : s.hours ? `Opening hours: ${s.hours}` : "Opening hours not published",
    },
    { key: "drive", label: "Drive-through", state: s.drive_through ? "ok" : "unknown", text: s.drive_through ? "No reversing on to the charger" : "Not published" },
    { key: "mcs", label: "Megawatt (MCS)", state: hasMcs(s) ? "ok" : "bad", text: hasMcs(s) ? "Megawatt charging for trucks" : `CCS, up to ${Math.round(s.max_kw)} kW` },
    { key: "fleets", label: "Fleets' reports", state: said === "fits" ? "ok" : said === "no_room" ? "bad" : "unknown", text: fleets ?? "None yet" },
  ];
}

/** What a driver's 45-minute break here adds, roughly: kWh and miles for this truck. */
export function breakCharge(s: OpenSite, truck: Truck): { kwh: number; miles: number } {
  const spec = TRUCKS[truck];
  // Charging slows as the battery fills: 85% of the lower of the site's and the truck's top rate.
  const kwh = Math.round(Math.min(s.max_kw, spec.maxKw) * 0.75 * 0.85);
  return { kwh, miles: Math.round((kwh / spec.kwhPerKm) * 0.6214) };
}

/** Bay limits where the operator publishes them: "18.8 m long · 4.5 m high · 44 t". */
export function bayLimits(s: OpenSite): string | null {
  const parts = [
    s.max_length_cm ? `${(s.max_length_cm / 100).toFixed(1)} m long` : "",
    s.max_height_cm ? `${(s.max_height_cm / 100).toFixed(1)} m high` : "",
    s.max_weight_kg ? `${Math.round(s.max_weight_kg / 1000)} t` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export const addressLine = (s: OpenSite) => [s.address, s.city, s.postcode].filter((x, i, a) => x && a.indexOf(x) === i).join(", ");

export const directionsUrl = (s: OpenSite) => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;

/** The site in the address bar: /map#site=mfg%3A123 */
export function siteFromHash(hash: string): string | null {
  const m = /(?:^#|&)site=([^&]+)/.exec(hash);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** What's on site, in a driver's words. */
export const FACILITY_LABEL: Record<string, string> = {
  CAFE: "Café", RESTAURANT: "Food", HOTEL: "Hotel", FUEL_STATION: "Fuel", WIFI: "Wi-Fi", PARKING_LOT: "Parking", SUPERMARKET: "Shop",
};

/** What a charge of this long adds, roughly, for this truck (as breakCharge, for any length). */
export function chargeFor(s: OpenSite, truck: Truck, minutes: number): { kwh: number; miles: number } {
  const spec = TRUCKS[truck];
  const kwh = Math.round(Math.min(s.max_kw, spec.maxKw) * (minutes / 60) * 0.85);
  return { kwh, miles: Math.round((kwh / spec.kwhPerKm) * 0.6214) };
}

/** Arrival times a trial booking offers: every half hour, from the next half hour today, or all day tomorrow. */
export function arrivalTimes(now: Date, tomorrow: boolean): string[] {
  const out: string[] = [];
  const startMin = tomorrow ? 0 : Math.ceil((now.getHours() * 60 + now.getMinutes() + 15) / 30) * 30;
  for (let m = startMin; m < 24 * 60; m += 30) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return out;
}

export const addMinutes = (hhmm: string, mins: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (h * 60 + m + mins) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
