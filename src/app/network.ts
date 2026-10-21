// Turns the OCPI network snapshot into "sites" the planner can rank for one vehicle and time.
import type { BookingLocation, Location, Tariff } from "../../shared/ocpi/types";
import type { NetworkSnapshot, Vehicle } from "../../shared/model";
import { assess, type Assessment } from "../../shared/booking/compat";
import { availabilityRatio, durationLimits, suggestSlots, type Suggestion } from "../../shared/booking/slots";
import { summarizeTariffs, type TariffSummary } from "../../shared/booking/tariffs";
import { haversineKm, upper } from "../../shared/util";

export interface SiteOption {
  bl: BookingLocation;
  assessment: Assessment;
  tariff: TariffSummary | null;
  best: Suggestion | null;
  alternatives: Suggestion[];
  ratio: number;
}

export interface Site {
  key: string;
  location: Location;
  operator: string;
  shortName: string;
  road: string | null;
  lat: number;
  lon: number;
  distanceKm: number | null;
  options: SiteOption[];
  best: SiteOption | null; // best compatible option with a slot
  fits: boolean; // some option is compatible (ignoring zero-touch)
  zeroTouch: boolean; // some compatible option is zero-touch
  isSimulator: boolean;
}

export const siteKey = (cc: string, pid: string, locId: string) => `${upper(cc)}*${upper(pid)}*${locId}`;

export function operatorFor(net: NetworkSnapshot | null, cc: string, pid: string, loc?: Location | null): string {
  const op = net?.operators.find((o) => o.country_code === upper(cc) && o.party_id === upper(pid));
  return loc?.operator?.name ?? op?.name ?? `${upper(cc)}*${upper(pid)}`;
}

export function shortSiteName(loc: Location, operator: string): string {
  const name = loc.name ?? loc.address;
  const first = operator.split(/[\s(]/)[0];
  return first && name.toLowerCase().startsWith(first.toLowerCase() + " ") ? name.slice(first.length + 1) : name;
}

export function findLocation(net: NetworkSnapshot | null, cc: string, pid: string, id: string): Location | null {
  return net?.locations.find((l) => l.country_code === upper(cc) && l.party_id === upper(pid) && l.id === id)?.data ?? null;
}

export function findBookingLocation(net: NetworkSnapshot | null, cc: string, pid: string, id: string): BookingLocation | null {
  return net?.booking_locations.find((l) => l.country_code === upper(cc) && l.party_id === upper(pid) && l.id === id)?.data ?? null;
}

export function tariffsFor(net: NetworkSnapshot | null, bl: BookingLocation): Tariff[] {
  if (!net) return [];
  const ids = new Set(bl.tariff_ids ?? []);
  return net.tariffs.filter((t) => t.country_code === upper(bl.country_code) && t.party_id === upper(bl.party_id) && ids.has(t.id)).map((t) => t.data);
}

export function roadOf(loc: Location): string | null {
  const rel = loc.related_locations as { name?: { text?: string } }[] | undefined;
  return rel?.find((r) => r.name?.text)?.name?.text ?? null;
}

export interface PlanQuery {
  vehicle: Vehicle;
  desired: Date;
  durationMin: number;
  near: { lat: number; lon: number } | null;
  now: Date;
}

export function rankSites(net: NetworkSnapshot, q: PlanQuery): Site[] {
  const byLoc = new Map<string, BookingLocation[]>();
  for (const o of net.booking_locations) {
    const k = siteKey(o.country_code, o.party_id, o.data.location_id);
    byLoc.set(k, [...(byLoc.get(k) ?? []), o.data]);
  }
  const dayFrom = new Date(q.desired.getTime() - 12 * 3_600_000);
  const dayTo = new Date(q.desired.getTime() + 12 * 3_600_000);
  const sites: Site[] = [];
  for (const [key, bls] of byLoc) {
    const [cc, pid] = key.split("*");
    const loc = findLocation(net, cc, pid, bls[0].location_id);
    if (!loc) continue;
    const operator = operatorFor(net, cc, pid, loc);
    const lat = Number(loc.coordinates.latitude);
    const lon = Number(loc.coordinates.longitude);
    const options: SiteOption[] = bls.map((bl) => {
      const a = assess(q.vehicle, bl, loc);
      const lim = durationLimits(bl);
      const dur = Math.min(Math.max(q.durationMin, lim.min), lim.max);
      const sug = a.ok ? suggestSlots(bl, q.desired, dur, q.now, { count: 3, horizonMin: 10 * 60 }) : [];
      const best = [...sug].sort((x, y) => Math.abs(x.deltaMin) - Math.abs(y.deltaMin))[0] ?? null;
      return { bl, assessment: a, tariff: summarizeTariffs(tariffsFor(net, bl)), best, alternatives: sug, ratio: availabilityRatio(bl, dayFrom, dayTo) };
    });
    const compatible = options.filter((o) => o.assessment.ok);
    const ranked = [...compatible].sort((x, y) =>
      Number(y.assessment.zeroTouch) - Number(x.assessment.zeroTouch)
      || (x.best ? Math.abs(x.best.deltaMin) : 1e9) - (y.best ? Math.abs(y.best.deltaMin) : 1e9)
      || (y.assessment.usableKw ?? 0) - (x.assessment.usableKw ?? 0));
    sites.push({
      key, location: loc, operator, shortName: shortSiteName(loc, operator), road: roadOf(loc), lat, lon,
      distanceKm: q.near ? haversineKm(q.near.lat, q.near.lon, lat, lon) : null,
      options, best: ranked.find((o) => o.best) ?? ranked[0] ?? null, fits: compatible.length > 0,
      zeroTouch: compatible.some((o) => o.assessment.zeroTouch),
      isSimulator: !!net.operators.find((o) => o.country_code === upper(cc) && o.party_id === upper(pid))?.is_simulator,
    });
  }
  return sites.sort((a, b) => {
    const ab = a.best?.best, bb = b.best?.best;
    if (!!ab !== !!bb) return ab ? -1 : 1;
    if (a.distanceKm != null && b.distanceKm != null) {
      // Within ~30 min of the wanted time, prefer the closer site.
      const ad = ab ? Math.abs(ab.deltaMin) : 1e9, bd = bb ? Math.abs(bb.deltaMin) : 1e9;
      if (Math.abs(ad - bd) <= 30) return a.distanceKm - b.distanceKm;
      return ad - bd;
    }
    return (ab ? Math.abs(ab.deltaMin) : 1e9) - (bb ? Math.abs(bb.deltaMin) : 1e9) || a.shortName.localeCompare(b.shortName);
  });
}
