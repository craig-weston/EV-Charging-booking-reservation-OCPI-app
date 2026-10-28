// When an operator cancels (or turns down) a booking, offer the nearest free bay at a similar time
// for the same truck: one tap to rebook instead of starting over on the booking screen.
import type { BookingRow, NetworkSnapshot, Vehicle } from "../../shared/model";
import { findLocation, rankSites, siteKey, type Site, type SiteOption } from "./network";
import type { Suggestion } from "../../shared/booking/slots";

export interface Rebooking {
  site: Site;
  option: SiteOption;
  slot: Suggestion;
  /** Minutes from the original start (negative = earlier). */
  shiftMin: number;
  /** Straight-line distance from the cancelled site, km. */
  distanceKm: number | null;
  sameSite: boolean;
}

/** How far from the original time a suggestion may be, either way. */
const MAX_SHIFT_MIN = 3 * 60;
/** Lead time so the truck can still get there. */
const LEAD_MIN = 15;

/**
 * Up to `count` alternatives, best first: zero-touch bays the truck fits, closest to the original
 * time, then nearest to the cancelled site. The bay that was cancelled is left out.
 */
export function rebookOptions(net: NetworkSnapshot | null, b: BookingRow, vehicle: Vehicle | null, now: Date, count = 3): Rebooking[] {
  if (!net || !vehicle) return [];
  const original = new Date(b.start_at);
  const durationMin = Math.max(15, Math.round((new Date(b.end_at).getTime() - original.getTime()) / 60_000));
  const earliest = new Date(now.getTime() + LEAD_MIN * 60_000);
  const desired = original < earliest ? earliest : original;
  const loc = findLocation(net, b.cpo_country_code, b.cpo_party_id, b.location_id);
  const near = loc ? { lat: Number(loc.coordinates.latitude), lon: Number(loc.coordinates.longitude) } : null;
  const sites = rankSites(net, { vehicle, desired, durationMin, near, now });

  const out: Rebooking[] = [];
  for (const site of sites) {
    for (const option of site.options) {
      if (!option.assessment.ok) continue;
      if (option.bl.id === b.booking_location_id && option.bl.country_code === b.cpo_country_code && option.bl.party_id === b.cpo_party_id) continue;
      for (const slot of option.alternatives) {
        if (slot.start < earliest) continue;
        const shiftMin = Math.round((slot.start.getTime() - original.getTime()) / 60_000);
        if (Math.abs(slot.start.getTime() - desired.getTime()) > MAX_SHIFT_MIN * 60_000) continue;
        out.push({ site, option, slot, shiftMin, distanceKm: site.distanceKm, sameSite: site.key === siteKey(b.cpo_country_code, b.cpo_party_id, b.location_id) });
      }
    }
  }
  const score = (r: Rebooking) =>
    (r.option.assessment.zeroTouch ? 0 : 10_000)
    + Math.abs(r.slot.start.getTime() - desired.getTime()) / 60_000 // minutes off
    + (r.distanceKm ?? 0) * 0.75; // ~45 km ≈ 30 minutes off
  out.sort((x, y) => score(x) - score(y));
  // One suggestion per site: three different places beat three times at one.
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.site.key) ? false : (seen.add(r.site.key), true))).slice(0, count);
}

export function describeShift(min: number): string {
  if (Math.abs(min) < 5) return "same time";
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  const t = h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
  return min > 0 ? `${t} later` : `${t} earlier`;
}

export function bookingBody(r: Rebooking, b: BookingRow) {
  return {
    vehicle_id: b.vehicle_id, driver_id: b.driver_id, cpo_country_code: r.option.bl.country_code, cpo_party_id: r.option.bl.party_id,
    booking_location_id: r.option.bl.id, start_at: r.slot.start.toISOString(), end_at: r.slot.end.toISOString(),
    power_required_kw: b.power_required_kw, notes: `Rebooked after the operator cancelled ${b.authorization_reference}`.slice(0, 500),
  };
}
