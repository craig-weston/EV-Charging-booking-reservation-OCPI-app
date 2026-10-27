// Read-only check of an operator's OCPI 2.3.0 interface before (or after) connecting it, so
// problems show up as a readable report rather than a failed registration. Only GET requests:
// it never registers, books or changes anything. Used by scripts/ocpi-probe.ts.
import type { BookingLocation, Location, Tariff } from "../../shared/ocpi/types";
import { assess } from "../../shared/booking/compat";
import { sampleVehicles } from "../api/samples";
import { authHeader, parseNextLink } from "./http";

export type Level = "pass" | "warn" | "fail" | "info";
export interface Finding { level: Level; area: string; text: string }
export interface ProbeReport {
  versions_url: string;
  version: string | null;
  findings: Finding[];
  counts: Record<string, number>;
  /** Booking locations a typical HGV could book, per sample truck. */
  bookable: Record<string, number>;
  ok: boolean;
}

export interface ProbeOptions {
  versionsUrl: string;
  token: string;
  /** Our party, sent in routing headers (OCPI-from-…). */
  from?: { country_code: string; party_id: string };
  /** Max pages per module (each up to the operator's limit). */
  maxPages?: number;
  fetch?: (req: Request) => Promise<Response>;
}

interface Envelope<T> { data?: T; status_code?: number; status_message?: string; timestamp?: string }

export async function probeOperator(o: ProbeOptions): Promise<ProbeReport> {
  const findings: Finding[] = [];
  const add = (level: Level, area: string, text: string) => findings.push({ level, area, text });
  const doFetch = o.fetch ?? ((r: Request) => fetch(r));
  const counts: Record<string, number> = {};
  const bookable: Record<string, number> = {};
  const report = (version: string | null): ProbeReport => ({ versions_url: o.versionsUrl, version, findings, counts, bookable, ok: !findings.some((f) => f.level === "fail") });

  async function get<T>(area: string, url: string, module = false): Promise<{ env: Envelope<T> | null; res: Response | null }> {
    const headers: Record<string, string> = { Authorization: authHeader(o.token), Accept: "application/json", "X-Request-ID": crypto.randomUUID(), "X-Correlation-ID": crypto.randomUUID() };
    if (module && o.from) Object.assign(headers, { "OCPI-from-country-code": o.from.country_code, "OCPI-from-party-id": o.from.party_id });
    let res: Response;
    try {
      res = await doFetch(new Request(url, { headers }));
    } catch (e) {
      add("fail", area, `Couldn't reach ${url}: ${e instanceof Error ? e.message : e}`);
      return { env: null, res: null };
    }
    const text = await res.text();
    let env: Envelope<T> | null = null;
    try { env = JSON.parse(text); } catch { /* reported below */ }
    if (!env || typeof env !== "object") {
      add("fail", area, `HTTP ${res.status} from ${url} wasn't an OCPI JSON response`);
      return { env: null, res };
    }
    if (res.status === 401 || env.status_code === 2001 && /token|auth/i.test(env.status_message ?? "")) {
      add(module ? "warn" : "fail", area, `HTTP ${res.status}: the token was refused${module ? ". A registration token (A) usually only opens versions and credentials: connect the operator in the app to pull these" : ""}.`);
      return { env: null, res };
    }
    if (env.status_code !== 1000) add("warn", area, `status_code ${env.status_code}${env.status_message ? ` (${env.status_message})` : ""} from ${url}`);
    if (!env.timestamp) add("warn", area, "Response envelope has no timestamp (required)");
    if (!res.headers.get("X-Request-ID") && module) add("info", area, "Response doesn't echo X-Request-ID");
    return { env, res };
  }

  // 1. Versions
  const v = await get<{ version: string; url: string }[]>("versions", o.versionsUrl);
  if (!v.env?.data) return report(null);
  const list = Array.isArray(v.env.data) ? v.env.data : [];
  add("info", "versions", `Offers ${list.map((x) => x.version).join(", ") || "no versions"}`);
  const match = list.find((x) => x.version === "2.3.0");
  if (!match) {
    add("fail", "versions", "OCPI 2.3.0 isn't offered. The Bookings module needs 2.3.0.");
    return report(null);
  }
  add("pass", "versions", "OCPI 2.3.0 offered");

  // 2. Version details and endpoints
  const d = await get<{ version: string; endpoints: { identifier: string; role: string; url: string }[] }>("endpoints", match.url);
  const endpoints = d.env?.data?.endpoints ?? [];
  if (!endpoints.length) {
    add("fail", "endpoints", "No endpoints listed for 2.3.0");
    return report("2.3.0");
  }
  const find = (id: string, role: string) => endpoints.find((e) => e.identifier === id && e.role === role)?.url ?? null;
  const need: [string, string, Level, string][] = [
    ["credentials", "SENDER", "fail", "needed to register"],
    ["locations", "SENDER", "fail", "sites, bays and connectors"],
    ["tariffs", "SENDER", "warn", "prices shown when booking"],
    ["bookings", "SENDER", "fail", "booking requests, booking locations and calendars"],
  ];
  for (const [id, role, level, why] of need) {
    const url = find(id, role) ?? (id === "credentials" ? find(id, "RECEIVER") : null);
    if (url) add("pass", "endpoints", `${id} ${role}: ${url}`);
    else add(level, "endpoints", `No ${id} ${role} endpoint (${why})`);
  }
  // Sessions, CDRs and booking updates are pushed to our Receiver endpoints, so they can't be checked from here.

  // 3. Module pulls (needs a token that's valid for the modules, i.e. after registration)
  async function pull<T extends { country_code: string; party_id: string; id: string }>(name: string, url: string | null): Promise<T[] | null> {
    if (!url) return null;
    const items: T[] = [];
    let next: string | null = `${url}${url.includes("?") ? "&" : "?"}limit=100`;
    for (let page = 0; next && page < (o.maxPages ?? 5); page++) {
      const r: { env: Envelope<T[]> | null; res: Response | null } = await get<T[]>(name, next, true);
      if (!r.env) return items.length ? items : null;
      if (!Array.isArray(r.env.data)) {
        add("fail", name, "data isn't a list");
        return items;
      }
      items.push(...r.env.data);
      if (page === 0) {
        const total = r.res?.headers.get("X-Total-Count");
        if (total == null) add("warn", name, "No X-Total-Count header (pagination)");
        if (r.res?.headers.get("X-Limit") == null) add("info", name, "No X-Limit header");
      }
      next = parseNextLink(r.res?.headers.get("Link") ?? null);
    }
    if (next) add("info", name, `Stopped after ${o.maxPages ?? 5} pages; there are more`);
    counts[name] = items.length;
    add(items.length ? "pass" : "warn", name, `${items.length} received`);
    const missing = items.filter((x) => !x.country_code || !x.party_id || !x.id).length;
    if (missing) add("fail", name, `${missing} without country_code, party_id or id`);
    return items;
  }

  const locations = await pull<Location>("locations", find("locations", "SENDER"));
  const tariffs = await pull<Tariff>("tariffs", find("tariffs", "SENDER"));
  const bookingsUrl = find("bookings", "SENDER");
  const bls = await pull<BookingLocation>("booking_locations", bookingsUrl ? `${bookingsUrl}/booking_locations` : null);

  // 4. Booking location quality: what our booking screens and checks depend on
  if (bls?.length) {
    const locIds = new Set((locations ?? []).map((l) => `${l.country_code}*${l.party_id}*${l.id}`.toUpperCase()));
    const tariffIds = new Set((tariffs ?? []).map((t) => t.id));
    const noLoc = bls.filter((b) => locations && !locIds.has(`${b.country_code}*${b.party_id}*${b.location_id}`.toUpperCase()));
    if (locations && noLoc.length) add("warn", "booking_locations", `${noLoc.length} refer to a location we didn't receive (e.g. ${noLoc[0].location_id})`);
    const noCal = bls.filter((b) => !b.calendars?.length);
    if (noCal.length) add("warn", "booking_locations", `${noCal.length} have no calendars, so no free slots can be shown`);
    const noTerms = bls.filter((b) => !b.booking_terms);
    if (noTerms.length) add("info", "booking_locations", `${noTerms.length} have no booking_terms (change and cancel rules default to "ask the operator")`);
    if (tariffs) {
      const badT = bls.filter((b) => (b.tariff_ids ?? []).some((t) => !tariffIds.has(t)));
      if (badT.length) add("warn", "booking_locations", `${badT.length} list tariff_ids we didn't receive`);
    }
    const noOption = bls.filter((b) => !b.booking_option);
    if (noOption.length) add("warn", "booking_locations", `${noOption.length} have no booking_option (vehicle size and connector limits unknown)`);

    const byKey = new Map((locations ?? []).map((l) => [`${l.country_code}*${l.party_id}*${l.id}`.toUpperCase(), l]));
    for (const v of sampleVehicles("probe", "GB", "XXX").slice(0, 3)) {
      bookable[`${v.name} (${v.make_model})`] = bls.filter((b) => assess(v, b, byKey.get(`${b.country_code}*${b.party_id}*${b.location_id}`.toUpperCase())).ok).length;
    }
    if (Object.values(bookable).every((n) => n === 0)) add("warn", "booking_locations", "None are bookable by our sample HGVs: check booking_option limits and connectors");
  }
  return report("2.3.0");
}

export function formatReport(r: ProbeReport): string {
  const icon: Record<Level, string> = { pass: "✔", warn: "!", fail: "✘", info: "·" };
  const lines = [`OCPI check: ${r.versions_url}`, ""];
  let area = "";
  for (const f of r.findings) {
    if (f.area !== area) { lines.push(`${f.area}`); area = f.area; }
    lines.push(`  ${icon[f.level]} ${f.text}`);
  }
  if (Object.keys(r.bookable).length) {
    lines.push("", "Bookable by sample trucks");
    for (const [k, n] of Object.entries(r.bookable)) lines.push(`  ${k}: ${n}`);
  }
  const n = (l: Level) => r.findings.filter((f) => f.level === l).length;
  lines.push("", `${r.ok ? "OK" : "Problems found"}: ${n("pass")} passed, ${n("warn")} warnings, ${n("fail")} failures`);
  return lines.join("\n");
}
