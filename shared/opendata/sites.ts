// Public charging sites from open data: UK operators' statutory feeds (the Public Charge Point
// Regulations 2023 make every public operator publish their sites, mostly as OCPI) and Open Charge
// Map. They show on the booking map as "not bookable here yet", next to the operators fleets can
// book. Only sites that could serve heavy vehicles are kept: truck bays, MCS, or high power.
//
// A daily GitHub Action (scripts/opendata.ts) fetches the sources and publishes one compact file;
// the app reads it through GET /api/public/sites. See docs/open-data.md.

/** "trucks": the data says heavy vehicles fit (truck bays, MCS, or a truck charging network).
 *  "check": high power, but the operator doesn't publish bay sizes. */
export type HgvFit = "trucks" | "check";

export interface OpenSite {
  /** `${source}:${id}` */
  id: string;
  name: string;
  operator: string;
  lat: number;
  lon: number;
  address?: string;
  city?: string;
  postcode?: string;
  /** Highest connector power, kW. */
  max_kw: number;
  /** e.g. ["MCS", "CCS2"], best first. */
  connectors: string[];
  /** Charge points (EVSEs) at the site. */
  evses: number;
  hgv: HgvFit;
  /** Why, in a few words: "Truck bays", "MCS connector", "Truck charging network", … */
  hgv_why: string;
  drive_through?: boolean;
  /** Bay limits where the operator publishes them (OCPI 2.3 parking). */
  max_length_cm?: number;
  max_height_cm?: number;
  max_weight_kg?: number;
  /** Source id (see OpenSitesFile.sources) and, for aggregators, who supplied the record. */
  source: string;
  provider?: string;
  updated?: string;
}

export interface OpenSource {
  id: string;
  name: string;
  /** Where the data comes from and on what terms, for the attribution line. */
  attribution: string;
  url: string;
  count: number;
}

export interface OpenSitesFile {
  generated_at: string;
  sources: OpenSource[];
  sites: OpenSite[];
}

/** Networks built for trucks: their sites take HGVs even when a feed omits bay sizes. */
export const TRUCK_NETWORKS = [/\bmilence\b/i, /\bvoltempo\b/i, /electric freightway/i, /\btruck\s?charg/i, /\bhgv\b/i, /\beinride\b/i];
const TRUCK_WORDS = /\b(hgvs?|lorry|lorries|trucks?|heavy goods|truck stop|truckstop|artics?)\b/i;
const HEAVY: readonly string[] = ["SEMI_TRACTOR", "TRUCK_WITH_TRAILER", "RIGID", "BUS"];
/** Below this a site can't charge a truck in a reasonable stop. */
export const MIN_KW = 150;

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const inGB = (lat: number, lon: number) => lat > 49.8 && lat < 61 && lon > -8.7 && lon < 2;

/** Friendly connector names, best for trucks first. */
const STANDARD: Record<string, string> = {
  MCS: "MCS", IEC_62196_T2_COMBO: "CCS2", IEC_62196_T1_COMBO: "CCS1", CHADEMO: "CHAdeMO", CHAOJI: "ChaoJi",
  GBT_DC: "GB/T DC", IEC_62196_T2: "Type 2", TESLA_S: "Tesla",
};
const RANK = ["MCS", "CCS2", "CCS1", "CHAdeMO", "ChaoJi", "GB/T DC", "Tesla", "Type 2"];
const sortConnectors = (c: Iterable<string>) => [...new Set(c)].sort((a, b) => (RANK.indexOf(a) + 1 || 99) - (RANK.indexOf(b) + 1 || 99));

function classify(o: { connectors: string[]; max_kw: number; operator: string; text: string; heavyBays: boolean }): { hgv: HgvFit; hgv_why: string } | null {
  if (o.heavyBays) return { hgv: "trucks", hgv_why: "Truck bays" };
  if (o.connectors.includes("MCS")) return { hgv: "trucks", hgv_why: "MCS connector" };
  if (TRUCK_NETWORKS.some((r) => r.test(o.operator))) return { hgv: "trucks", hgv_why: "Truck charging network" };
  if (o.max_kw >= MIN_KW && TRUCK_WORDS.test(o.text)) return { hgv: "trucks", hgv_why: "Listed for trucks" };
  if (o.max_kw >= MIN_KW) return { hgv: "check", hgv_why: "High power; bay size not published" };
  return null;
}

// ---- OCPI (operators' statutory feeds) --------------------------------------------------------

/** Connector power in kW: max_electric_power (OCPI 2.2+), else volts × amps (2.1.1). */
function connectorKw(c: Record<string, unknown>): number {
  const w = num(c.max_electric_power);
  if (w) return w / 1000;
  const v = num(c.max_voltage) ?? 0, a = num(c.max_amperage) ?? 0;
  return ((c.power_type === "AC_3_PHASE" ? 3 : 1) * v * a) / 1000;
}

/** One OCPI Location (2.1.1, 2.2.1 or 2.3) as an OpenSite, or null if it can't serve trucks. */
export function fromOcpiLocation(loc: unknown, source: string): OpenSite | null {
  const l = (loc ?? {}) as Record<string, unknown>;
  const coords = (l.coordinates ?? {}) as Record<string, unknown>;
  const lat = num(coords.latitude), lon = num(coords.longitude);
  const id = str(l.id, 80);
  if (lat == null || lon == null || !id || !inGB(lat, lon) || l.publish === false) return null;
  const evses = (Array.isArray(l.evses) ? l.evses : []) as Record<string, unknown>[];
  const live = evses.filter((e) => e.status !== "REMOVED");
  const conns = live.flatMap((e) => (Array.isArray(e.connectors) ? e.connectors : []) as Record<string, unknown>[]);
  if (!conns.length) return null;
  const max_kw = Math.round(Math.max(...conns.map(connectorKw)));
  const connectors = sortConnectors(conns.map((c) => STANDARD[String(c.standard)] ?? "").filter(Boolean));
  // OCPI 2.3 parking: bays that take heavy vehicles, and their limits.
  const parking = (Array.isArray(l.parking_places) ? l.parking_places : []) as Record<string, unknown>[];
  const heavy = parking.filter((p) => Array.isArray(p.vehicle_types) && (p.vehicle_types as string[]).some((t) => HEAVY.includes(t)));
  const best = heavy.reduce<Record<string, unknown> | null>((m, p) => (!m || (num(p.max_vehicle_length) ?? 0) > (num(m.max_vehicle_length) ?? 0) ? p : m), null);
  const operator = str((l.operator as Record<string, unknown> | undefined)?.name, 80) ?? str((l.owner as Record<string, unknown> | undefined)?.name, 80) ?? "";
  const name = str(l.name, 120) ?? str(l.address, 120) ?? id;
  const fit = classify({ connectors, max_kw, operator, text: `${name} ${operator}`, heavyBays: heavy.length > 0 });
  if (!fit) return null;
  return {
    id: `${source}:${id}`, name, operator: operator || source, lat, lon,
    address: str(l.address), city: str(l.city, 80), postcode: str(l.postal_code, 12),
    max_kw, connectors, evses: live.length, ...fit,
    ...(heavy.some((p) => p.drive_through === true) ? { drive_through: true } : {}),
    ...(best ? { max_length_cm: num(best.max_vehicle_length), max_height_cm: num(best.max_vehicle_height), max_weight_kg: num(best.max_vehicle_weight) } : {}),
    source, updated: str(l.last_updated, 40),
  };
}

/**
 * OCPI responses come as { data: [...] }, a bare array, or { data: { ... } } for one location. Some
 * feeds send locations and tariffs together (Osprey): { locations: [...], tariffs: [...] }, possibly
 * inside data.
 */
export function ocpiLocations(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const o = body as { data?: unknown; locations?: unknown } | null;
  if (Array.isArray(o?.locations)) return o!.locations as unknown[];
  const d = o?.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === "object" && Array.isArray((d as { locations?: unknown }).locations)) return (d as { locations: unknown[] }).locations;
  return d && typeof d === "object" ? [d] : [];
}

/** For the job's log when a feed gives no sites: the shape it sent (key names only, never values). */
export function payloadShape(body: unknown): string {
  if (Array.isArray(body)) return `an array of ${body.length}`;
  if (!body || typeof body !== "object") return typeof body;
  const keys = (o: object) => Object.keys(o).slice(0, 12).join(", ");
  const d = (body as { data?: unknown }).data;
  return `an object with keys: ${keys(body)}${d && typeof d === "object" && !Array.isArray(d) ? ` (data has: ${keys(d)})` : ""}`;
}

// ---- Open Charge Map ----------------------------------------------------------------------------

/** One Open Charge Map POI (compact=false) as an OpenSite, or null. */
export function fromOcm(poi: unknown, source = "ocm"): OpenSite | null {
  const p = (poi ?? {}) as Record<string, unknown>;
  const a = (p.AddressInfo ?? {}) as Record<string, unknown>;
  const lat = num(a.Latitude), lon = num(a.Longitude), id = num(p.ID);
  if (lat == null || lon == null || id == null || !inGB(lat, lon)) return null;
  const status = p.StatusType as { IsOperational?: boolean } | undefined;
  if (status && status.IsOperational === false) return null;
  const conns = (Array.isArray(p.Connections) ? p.Connections : []) as Record<string, unknown>[];
  if (!conns.length) return null;
  const max_kw = Math.round(Math.max(...conns.map((c) => num(c.PowerKW) ?? 0)));
  const typeName = (c: Record<string, unknown>) => {
    const t = (c.ConnectionType ?? {}) as Record<string, unknown>;
    const s = `${t.Title ?? ""} ${t.FormalName ?? ""}`;
    return /megawatt|\bMCS\b/i.test(s) ? "MCS" : /CCS|combo/i.test(s) ? (/type ?1/i.test(s) ? "CCS1" : "CCS2") : /chademo/i.test(s) ? "CHAdeMO" : /tesla/i.test(s) ? "Tesla" : /type ?2/i.test(s) ? "Type 2" : "";
  };
  const connectors = sortConnectors(conns.map(typeName).filter(Boolean));
  const operator = str((p.OperatorInfo as Record<string, unknown> | undefined)?.Title, 80) ?? "";
  const name = str(a.Title, 120) ?? str(a.AddressLine1, 120) ?? `Site ${id}`;
  const text = `${name} ${operator} ${p.GeneralComments ?? ""} ${a.AccessComments ?? ""}`;
  const fit = classify({ connectors, max_kw, operator, text, heavyBays: false });
  if (!fit) return null;
  const provider = str((p.DataProvider as Record<string, unknown> | undefined)?.Title, 80);
  const points = num(p.NumberOfPoints) ?? conns.reduce((s, c) => s + (num(c.Quantity) ?? 1), 0);
  return {
    id: `${source}:${id}`, name, operator: operator || "Unknown operator", lat, lon,
    address: [str(a.AddressLine1), str(a.AddressLine2)].filter(Boolean).join(", ") || undefined,
    city: str(a.Town, 80), postcode: str(a.Postcode, 12),
    max_kw, connectors, evses: points, ...fit, source,
    ...(provider && !/open charge map/i.test(provider) ? { provider } : {}),
    updated: str(p.DateLastStatusUpdate, 40) ?? str(p.DateLastVerified, 40),
  };
}

// ---- merging --------------------------------------------------------------------------------------

const metres = (a: OpenSite, b: OpenSite) => {
  const dy = (a.lat - b.lat) * 111_320, dx = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
};
const sameOperator = (a: string, b: string) => {
  const k = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "").slice(0, 6);
  return k(a) === k(b) || !a || !b || /unknown/i.test(a) || /unknown/i.test(b);
};

/** One record per physical site: an operator's own feed wins over an aggregator's copy, and
 *  within a source the higher-powered record wins. `sources` are in priority order. */
export function mergeSites(lists: OpenSite[][]): OpenSite[] {
  const out: OpenSite[] = [];
  for (const list of lists) {
    for (const s of list) {
      const dup = out.find((o) => metres(o, s) < 80 && sameOperator(o.operator, s.operator));
      if (!dup) { out.push(s); continue; }
      if (dup.source === s.source && s.max_kw > dup.max_kw) Object.assign(dup, s);
      else if (dup.hgv === "check" && s.hgv === "trucks") Object.assign(dup, { hgv: s.hgv, hgv_why: s.hgv_why });
    }
  }
  return out.sort((a, b) => (a.hgv === b.hgv ? b.max_kw - a.max_kw : a.hgv === "trucks" ? -1 : 1));
}

/** Can this vehicle use the site? Unknown limits don't rule it out; heavy vehicles get told to
 *  check bay size where it isn't published. */
export function openSiteFit(s: OpenSite, v: { vehicle_type?: string; length_cm?: number | null; height_cm?: number | null; gross_weight_kg?: number | null } | null): { ok: boolean; note: string | null } {
  if (!v) return { ok: true, note: null };
  const heavy = v.vehicle_type !== "VAN";
  if (s.max_length_cm && v.length_cm && v.length_cm > s.max_length_cm) return { ok: false, note: "Bays too short" };
  if (s.max_height_cm && v.height_cm && v.height_cm > s.max_height_cm) return { ok: false, note: "Too low" };
  if (s.max_weight_kg && v.gross_weight_kg && v.gross_weight_kg > s.max_weight_kg) return { ok: false, note: "Too heavy" };
  if (heavy && s.hgv === "check") return { ok: true, note: "Bay size not published: check before sending an HGV" };
  return { ok: true, note: null };
}

/** Is a parsed file safe to show? Drops anything malformed. */
export function cleanOpenSites(x: unknown): OpenSitesFile | null {
  const f = x as Partial<OpenSitesFile> | null;
  if (!f || !Array.isArray(f.sites) || !Array.isArray(f.sources)) return null;
  const sites = f.sites.filter((s): s is OpenSite => !!s && typeof s.id === "string" && Number.isFinite(s.lat) && Number.isFinite(s.lon) && typeof s.name === "string" && (s.hgv === "trucks" || s.hgv === "check")).slice(0, 20_000);
  return { generated_at: String(f.generated_at ?? ""), sources: f.sources.filter((s) => s && typeof s.id === "string").slice(0, 100), sites };
}
