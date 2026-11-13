// Fleets' reports on public sites (shared/opendata/reports.ts): does an artic or a rigid fit?
//
//   GET /api/public/site-reports                       totals for every reported site; no account needed
//   GET /api/fleets/{fleet}/site-reports               this fleet's own reports
//   PUT /api/fleets/{fleet}/site-reports               { site, truck, verdict } — verdict null withdraws it
//
// Kept as live records under sitereports/{site}/{truck}/{fleet}: one per fleet, per site, per kind of
// truck, so a fleet changing its mind replaces its report and nobody can stuff the totals. A report
// says nothing about the fleet beyond its id in the key, and the public totals don't include that.
import type { Ctx } from "./context";
import { seg, unseg } from "./livekeys";
import { addToTally, isSiteId, isTruckClass, isVerdict, type MySiteReports, type SiteReport, type SiteTally, type TruckClass } from "../shared/opendata/reports";

const ROOT = "sitereports/";
const key = (site: string, truck: TruckClass, fleet: string) => `${ROOT}${seg(site)}/${truck}/${seg(fleet)}`;

type Store = Pick<Ctx["store"], "listLive" | "putLive" | "deleteLive">;

async function all(store: Pick<Store, "listLive">): Promise<{ site: string; truck: TruckClass; fleet: string; report: SiteReport }[]> {
  const rows = await store.listLive<SiteReport>(ROOT);
  const out: { site: string; truck: TruckClass; fleet: string; report: SiteReport }[] = [];
  for (const [k, report] of Object.entries(rows)) {
    const [site, truck, fleet] = k.split("/");
    if (site && fleet && isTruckClass(truck) && isVerdict(report?.verdict) && typeof report.at === "string") out.push({ site: unseg(site), truck, fleet: unseg(fleet), report });
  }
  return out;
}

/** Totals by site, for everyone. */
export async function siteTallies(store: Pick<Store, "listLive">): Promise<Record<string, SiteTally>> {
  const out: Record<string, SiteTally> = {};
  for (const r of await all(store)) out[r.site] = addToTally(out[r.site], r.truck, r.report);
  return out;
}

/** This fleet's own reports, by site. */
export async function fleetSiteReports(store: Pick<Store, "listLive">, fleetId: string): Promise<Record<string, MySiteReports>> {
  const out: Record<string, MySiteReports> = {};
  for (const r of await all(store)) if (r.fleet === fleetId) (out[r.site] ??= {})[r.truck] = r.report.verdict;
  return out;
}

export class BadReport extends Error {}

/** Save (or, with no verdict, withdraw) a fleet's report. Returns the site's totals afterwards. */
export async function reportSite(ctx: Pick<Ctx, "store" | "now">, fleetId: string, b: { site?: unknown; truck?: unknown; verdict?: unknown }): Promise<{ site: string; tally: SiteTally | null; mine: MySiteReports }> {
  if (!isSiteId(b.site)) throw new BadReport("Say which public site this is about");
  if (!isTruckClass(b.truck)) throw new BadReport('The truck must be "artic" or "rigid"');
  if (b.verdict != null && !isVerdict(b.verdict)) throw new BadReport('The report must be "fits" or "no_room"');
  const k = key(b.site, b.truck, fleetId);
  if (b.verdict == null) await ctx.store.deleteLive(k);
  else await ctx.store.putLive<SiteReport>({ [k]: { verdict: b.verdict, at: ctx.now().toISOString().slice(0, 19) + "Z" } });
  const site = b.site;
  const rows = (await all(ctx.store)).filter((r) => r.site === site);
  let tally: SiteTally | null = null;
  const mine: MySiteReports = {};
  for (const r of rows) {
    tally = addToTally(tally ?? undefined, r.truck, r.report);
    if (r.fleet === fleetId) mine[r.truck] = r.report.verdict;
  }
  return { site, tally, mine };
}
