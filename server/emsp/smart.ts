// Smart charging at public sites over OCPI ChargingProfiles. We act as the Sender (the smart
// charging service provider), the CPO as the Receiver:
//
//   PUT    {cpo chargingprofiles}/{session_id}   SetChargingProfile { charging_profile, response_url }
//   DELETE {cpo chargingprofiles}/{session_id}?response_url=…
//   POST   {our response_url}                     ChargingProfileResult / ClearProfileResult (async)
//   PUT    {our chargingprofiles}/{session_id}    ActiveChargingProfile (the CPO's updates)
//
// The synchronous answer (ACCEPTED / NOT_SUPPORTED / REJECTED / TOO_OFTEN / UNKNOWN_SESSION) only
// says whether the operator will try; the charger's own answer arrives at response_url.
import type { ActiveChargingProfile, ActiveChargingProfileResult, ChargingProfileResponse, ChargingProfileResult, ClearProfileResult, Location, Tariff } from "../../shared/ocpi/types";
import type { BookingRow, Partner, SmartCharging, SmartMode, SmartStatus, Vehicle } from "../../shared/model";
import { planSession } from "../../shared/energy/session";
import { iso, randomToken, upper } from "../../shared/util";
import { ocpiUrls, type Ctx } from "../context";
import { findEndpoint, ocpiCall } from "../ocpi/client";
import { carbonFor } from "../energy";
import { addEvents, ApiError } from "./service";

export const SMART_MODES: SmartMode[] = ["cheapest", "greenest", "cap"];
const DEFAULT_TARGET = 90;

function routing(ctx: Ctx, cc: string, pid: string) {
  return { from: { country_code: ctx.party.country_code, party_id: ctx.party.party_id }, to: { country_code: upper(cc), party_id: upper(pid) } };
}

/** The operator's ChargingProfiles endpoint, or null if they don't offer the module. */
export async function profilesEndpoint(ctx: Ctx, cc: string, pid: string): Promise<{ partner: Partner; url: string } | null> {
  const partner = await ctx.store.findPartnerByParty(cc, pid);
  if (!partner || partner.status !== "CONNECTED" || !partner.their_token) return null;
  const url = findEndpoint(partner, "chargingprofiles", "RECEIVER");
  return url ? { partner, url } : null;
}

async function save(ctx: Ctx, row: BookingRow, sc: SmartCharging, message?: string): Promise<BookingRow> {
  const saved = await ctx.store.updateBooking(row.id, { smart_charging: sc });
  if (message) await addEvents(ctx, row, [{ kind: "NOTE", message, data: { smart_charging: sc.status } }]);
  return saved;
}

/** Work out the profile for this booking now (energy still needed, booking end, prices, carbon). */
async function buildProfile(ctx: Ctx, row: BookingRow, vehicle: Vehicle | null, mode: SmartMode, capKw: number | null, target: number) {
  const now = ctx.now().getTime();
  const from = Math.max(now, new Date(row.session?.start_date_time ?? row.start_at).getTime());
  const to = new Date(row.end_at).getTime();
  if (to - from < 10 * 60_000) throw new ApiError(409, "Less than 10 minutes of the booking left");
  const battery = vehicle?.battery_kwh ?? 540;
  const socNow = row.session?.soc ?? row.session?.soc_start ?? 30;
  const need = Math.max(0, ((target - socNow) / 100) * battery);
  const loc = (await ctx.store.getObject<Location>("locations", row.cpo_country_code, row.cpo_party_id, row.location_id))?.data ?? null;
  const tariffs = await tariffsForBooking(ctx, row);
  const carbon = await carbonFor(ctx, loc?.postal_code ?? null, new Date(from - 30 * 60_000).toISOString(), new Date(to + 30 * 60_000).toISOString());
  const bayKw = (row.power_required_kw ?? vehicle?.max_charge_kw ?? 150);
  const maxKw = Math.max(1, Math.min(bayKw, vehicle?.max_charge_kw ?? bayKw));
  return planSession({ mode, capKw, from, to, needBatteryKwh: need, maxKw, tariffs, carbon });
}

async function tariffsForBooking(ctx: Ctx, row: BookingRow): Promise<Tariff[]> {
  const loc = (await ctx.store.getObject<Location>("locations", row.cpo_country_code, row.cpo_party_id, row.location_id))?.data;
  const ids = new Set<string>();
  for (const e of loc?.evses ?? []) for (const c of e.connectors ?? []) for (const t of c.tariff_ids ?? []) ids.add(t);
  const out: Tariff[] = [];
  for (const id of ids) {
    const t = await ctx.store.getObject<Tariff>("tariffs", row.cpo_country_code, row.cpo_party_id, id);
    if (t) out.push(t.data);
  }
  return out;
}

/**
 * Set up smart charging for a booking. Before the charge starts it's remembered ("waiting") and
 * sent when the session begins; during a charge it's sent straight away.
 */
export async function requestSmartCharging(ctx: Ctx, row: BookingRow, vehicle: Vehicle | null, mode: SmartMode, capKw: number | null, target = DEFAULT_TARGET): Promise<BookingRow> {
  if (row.reservation_status !== "RESERVED" && row.reservation_status !== "FULFILLED" && row.session?.status !== "ACTIVE") throw new ApiError(409, "Smart charging is for confirmed bookings");
  if (row.session && row.session.status !== "ACTIVE" && row.session.status !== "PENDING") throw new ApiError(409, "This charge has finished");
  if (mode === "cap" && !(capKw && capKw > 0)) throw new ApiError(400, "Give a power limit in kW");
  const ep = await profilesEndpoint(ctx, row.cpo_country_code, row.cpo_party_id);
  const base: SmartCharging = { mode, cap_kw: mode === "cap" ? capKw : null, target_soc: target, status: "waiting", message: "", updated_at: iso(ctx.now()), profile: null, active: null, estimate: null };
  if (!ep) {
    return save(ctx, row, { ...base, status: "not_supported", message: "This operator doesn't offer smart charging over OCPI yet. The truck will charge at full power." }, "Smart charging not available at this operator");
  }
  const plan = await buildProfile(ctx, row, vehicle, mode, capKw, target);
  const estimate = { ready_at: plan.readyAt ? new Date(plan.readyAt).toISOString() : null, kwh: plan.kwh, cost: plan.cost, kg: plan.kg, baseline_cost: plan.baselineCost, baseline_kg: plan.baselineKg, short_kwh: plan.shortKwh };
  if (row.session?.status !== "ACTIVE") {
    return save(ctx, row, { ...base, status: "waiting", message: "Will be sent to the charger when charging starts", profile: plan.profile, estimate }, `Smart charging set up (${label(mode, capKw)}), sent when charging starts`);
  }
  return sendProfile(ctx, row, ep, { ...base, profile: plan.profile, estimate });
}

function label(mode: SmartMode, cap: number | null) {
  return mode === "cheapest" ? "cheapest times" : mode === "greenest" ? "greenest times" : `limit ${cap} kW`;
}

async function sendProfile(ctx: Ctx, row: BookingRow, ep: { partner: Partner; url: string }, sc: SmartCharging): Promise<BookingRow> {
  const sessionId = row.session!.id;
  const nonce = randomToken(10);
  const responseUrl = `${ocpiUrls(ctx.baseUrl).module("chargingprofiles")}/results/${encodeURIComponent(row.id)}/${nonce}`;
  const res = await ocpiCall<ChargingProfileResponse>(ctx, {
    method: "PUT", url: `${ep.url}/${encodeURIComponent(sessionId)}`, token: ep.partner.their_token!, module: "chargingprofiles",
    body: { charging_profile: sc.profile, response_url: responseUrl }, routing: routing(ctx, row.cpo_country_code, row.cpo_party_id), partner: ep.partner, bookingId: row.id,
  });
  const result = res.ok ? res.data?.result : undefined;
  const map: Record<string, [SmartStatus, string]> = {
    ACCEPTED: ["sent", "Sent: waiting for the charger to confirm"],
    NOT_SUPPORTED: ["not_supported", "The operator doesn't support smart charging on this charger"],
    REJECTED: ["rejected", "The operator turned the schedule down"],
    TOO_OFTEN: ["too_often", "Sent too often: try again in a few minutes"],
    UNKNOWN_SESSION: ["unknown_session", "The operator doesn't recognise this charging session"],
  };
  const [status, message] = result && map[result] ? map[result] : ["failed", `Couldn't send the schedule (${res.error ?? "no response"})`] as [SmartStatus, string];
  return save(ctx, row, { ...sc, status, message, updated_at: iso(ctx.now()) }, `Smart charging: ${message.toLowerCase()}`);
}

/** Stop smart charging: the charger goes back to full power. */
export async function clearSmartCharging(ctx: Ctx, row: BookingRow): Promise<BookingRow> {
  const sc = row.smart_charging;
  if (!sc) return row;
  const cleared = { ...sc, status: "cleared" as const, message: "Smart charging switched off", updated_at: iso(ctx.now()), active: null };
  if (row.session?.status === "ACTIVE" && (sc.status === "sent" || sc.status === "active")) {
    const ep = await profilesEndpoint(ctx, row.cpo_country_code, row.cpo_party_id);
    if (ep) {
      const responseUrl = `${ocpiUrls(ctx.baseUrl).module("chargingprofiles")}/results/${encodeURIComponent(row.id)}/${randomToken(10)}`;
      await ocpiCall(ctx, {
        method: "DELETE", url: `${ep.url}/${encodeURIComponent(row.session.id)}?response_url=${encodeURIComponent(responseUrl)}`, token: ep.partner.their_token!, module: "chargingprofiles",
        routing: routing(ctx, row.cpo_country_code, row.cpo_party_id), partner: ep.partner, bookingId: row.id,
      });
    }
  }
  return save(ctx, row, cleared, "Smart charging switched off");
}

/** Called when a session for this booking starts: send a waiting profile. */
export async function onSessionStarted(ctx: Ctx, bookingId: string, vehicle: Vehicle | null): Promise<void> {
  const row = await ctx.store.getBooking(bookingId);
  const sc = row?.smart_charging;
  if (!row || !sc || sc.status !== "waiting" || row.session?.status !== "ACTIVE") return;
  const ep = await profilesEndpoint(ctx, row.cpo_country_code, row.cpo_party_id);
  if (!ep) { await save(ctx, row, { ...sc, status: "not_supported", message: "This operator doesn't offer smart charging over OCPI", updated_at: iso(ctx.now()) }); return; }
  // Re-plan from the real start and state of charge.
  const plan = await buildProfile(ctx, row, vehicle, sc.mode, sc.cap_kw ?? null, sc.target_soc);
  await sendProfile(ctx, row, ep, { ...sc, profile: plan.profile, estimate: { ready_at: plan.readyAt ? new Date(plan.readyAt).toISOString() : null, kwh: plan.kwh, cost: plan.cost, kg: plan.kg, baseline_cost: plan.baselineCost, baseline_kg: plan.baselineKg, short_kwh: plan.shortKwh } });
}

/** POST to our response_url: the charger's answer to a set, clear or get. */
export async function receiveProfileResult(ctx: Ctx, partner: Partner, bookingId: string, nonce: string, body: ChargingProfileResult | ClearProfileResult | ActiveChargingProfileResult): Promise<boolean> {
  const row = await ctx.store.getBooking(bookingId);
  if (!row || !partner.roles.some((r) => upper(r.country_code) === upper(row.cpo_country_code) && upper(r.party_id) === upper(row.cpo_party_id))) return false;
  const sc = row.smart_charging;
  if (!sc) return true;
  if (sc.status === "cleared") return true; // a late answer to something we've since switched off
  const r = body?.result;
  const active = (body as ActiveChargingProfileResult).profile ?? null;
  if (r === "ACCEPTED") await save(ctx, row, { ...sc, status: "active", message: "The charger is following the schedule", updated_at: iso(ctx.now()), ...(active ? { active } : {}) }, "Smart charging confirmed by the charger");
  else if (r === "REJECTED") await save(ctx, row, { ...sc, status: "rejected", message: "The charger turned the schedule down. It will charge at full power.", updated_at: iso(ctx.now()) }, "Smart charging rejected by the charger");
  else if (r === "UNKNOWN") await save(ctx, row, { ...sc, status: "unknown_session", message: "The charger didn't recognise the session", updated_at: iso(ctx.now()) });
  void nonce;
  return true;
}

/** PUT {our chargingprofiles}/{session_id}: the CPO tells us the profile the charger now uses. */
export async function receiveActiveProfile(ctx: Ctx, partner: Partner, sessionId: string, body: ActiveChargingProfile): Promise<boolean> {
  for (const role of partner.roles) {
    const row = await ctx.store.findBookingBySession(role.country_code, role.party_id, sessionId);
    if (!row) continue;
    const sc = row.smart_charging ?? { mode: "cap" as const, cap_kw: null, target_soc: DEFAULT_TARGET, status: "active" as const, message: "Set by the operator", updated_at: iso(ctx.now()) };
    await save(ctx, row, { ...sc, active: body, updated_at: iso(ctx.now()) });
    return true;
  }
  return false;
}
