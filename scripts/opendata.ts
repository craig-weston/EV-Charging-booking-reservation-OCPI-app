// Builds the public charging-site snapshot the booking map shows as "not bookable here yet".
// Run daily by .github/workflows/opendata.yml (which publishes the file); locally:
//   npx tsx scripts/opendata.ts out/sites.json
// Sources needing a key are skipped unless their secret is set (see shared/opendata/sources.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SOURCES, OCM_URL, attributionFor, type OcpiSource } from "../shared/opendata/sources";
import { fromOcm, fromOcpiLocation, mergeSites, ocpiLocations, type OpenSite, type OpenSitesFile, type OpenSource } from "../shared/opendata/sites";

const UA = "fleet-charging-open-data/1.0 (+https://github.com/craig-weston/EV-Charging-booking-reservation-OCPI-app)";
const MAX_PAGES = 200;

async function get(url: string, headers: Record<string, string>): Promise<{ body: unknown; next: string | null }> {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45_000);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA, ...headers }, signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const link = res.headers.get("link") ?? "";
      const next = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link)?.[1] ?? null;
      return { body: await res.json(), next: next ? new URL(next, url).toString() : null };
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      clearTimeout(timer);
    }
  }
}

function authHeaders(s: OcpiSource): Record<string, string> | null {
  if (!s.secret) return {};
  const key = process.env[s.secret];
  if (!key) return null;
  const value = s.scheme === "Basic" ? `Basic ${Buffer.from(key).toString("base64")}` : s.scheme ? `${s.scheme} ${key}` : key;
  return { [s.header ?? "Authorization"]: value };
}

async function ocpi(s: OcpiSource): Promise<OpenSite[] | null> {
  const headers = authHeaders(s);
  if (!headers) return null;
  const out: OpenSite[] = [];
  let url: string | null = s.url;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const { body, next } = await get(url, headers);
    for (const l of ocpiLocations(body)) {
      const site = fromOcpiLocation(l, s.id);
      if (site) out.push(site);
    }
    url = next;
  }
  return out;
}

async function ocm(secret: string): Promise<OpenSite[] | null> {
  const key = process.env[secret];
  if (!key) return null;
  const { body } = await get(OCM_URL, { "X-API-Key": key });
  return (Array.isArray(body) ? body : []).map((p) => fromOcm(p)).filter((x): x is OpenSite => !!x);
}

async function main() {
  const outPath = process.argv[2] ?? "out/sites.json";
  const lists: OpenSite[][] = [];
  const sources: OpenSource[] = [];
  for (const s of SOURCES) {
    try {
      const sites = s.kind === "ocm" ? await ocm(s.secret) : await ocpi(s);
      if (sites === null) { console.log(`${s.name}: skipped (no ${s.secret})`); continue; }
      console.log(`${s.name}: ${sites.length} sites that could take trucks`);
      lists.push(sites);
      sources.push({ id: s.id, name: s.name, attribution: attributionFor(s), url: s.page, count: sites.length });
    } catch (e) {
      console.log(`${s.name}: failed (${(e as Error).message}); left out this time`);
    }
  }
  const sites = mergeSites(lists);
  const file: OpenSitesFile = { generated_at: new Date().toISOString(), sources: sources.map((s) => ({ ...s, count: sites.filter((x) => x.source === s.id).length })), sites };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(file));
  console.log(`${sites.length} sites (${sites.filter((s) => s.hgv === "trucks").length} built for trucks) → ${outPath}`);
  if (!sites.length) process.exitCode = 1; // don't publish an empty map
}

void main();
