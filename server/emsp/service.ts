// eMSP-side booking logic: sending BookingRequests to CPOs and applying what they send back.
import type { Booking, BookingLocation, CDR, CanceledReason, CdrDimensionType, Location, Session } from "../../shared/ocpi/types";
import type { BookingEvent, BookingRow, CdrSummary, Partner, SessionSummary, Vehicle } from "../../shared/model";
import { assess } from "../../shared/booking/compat";
import { buildBookingRequest, reconcileBooking, tokenTypeFor, type NewEvent } from "../../shared/booking/request";
import { checkSlot } from "../../shared/booking/slots";
import { canChange } from "../../shared/booking/terms";
import { iso, normalizePlate, randomToken, shortId, upper, uuid, displayPlate } from "../../shared/util";
import type { Ctx } from "../context";
import { findEndpoint, ocpiCall } from "../ocpi/client";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function operatorName(partner: Partner | null, cc: string, pid: string, loc?: Location | null): string {
  const role = partner?.roles.find((r) => upper(r.country_code) === upper(cc) && upper(r.party_id) === upper(pid));
  return loc?.operator?.name ?? role?.business_details?.name ?? `${upper(cc)}*${upper(pid)}`;
}

export function bayLabel(loc: Location | null | undefined, evseUid: string): string {
  const e = loc?.evses?.find((x) => x.uid === evseUid);
  return e?.physical_reference ? `Bay ${e.physical_reference}` : e?.evse_id ?? evseUid;
}

export async function addEvents(ctx: Ctx, row: Pick<BookingRow, "id" | "fleet_id">, events: NewEvent[]) {
  if (!events.length) return;
  const now = ctx.now().getTime();
  const list: BookingEvent[] = events.map((e, i) => ({
    id: uuid(),
    booking_id: row.id,
    fleet_id: row.fleet_id,
    at: new Date(now + i).toISOString(),
    kind: e.kind,
    message: e.message,
    data: e.data ?? null,
  }));
  await ctx.store.addEvents(list);
}

/** Apply a Booking object received from the CPO (POST response, PUT or PATCH push). */
export async function applyBookingUpdate(ctx: Ctx, row: BookingRow, incoming: Booking, partner: Partner | null): Promise<BookingRow> {
  const loc = (await ctx.store.getObject<Location>("locations", row.cpo_country_code, row.cpo_party_id, row.location_id))?.data;
  const op = operatorName(partner, row.cpo_country_code, row.cpo_party_id, loc);
  const { patch, events } = reconcileBooking(row, incoming, op, (uid) => bayLabel(loc, uid));
  const updated = await ctx.store.updateBooking(row.id, patch);
  await addEvents(ctx, row, events);
  return updated;
}

function routingTo(ctx: Ctx, cc: string, pid: string) {
  return { from: { country_code: ctx.party.country_code, party_id: ctx.party.party_id }, to: { country_code: upper(cc), party_id: upper(pid) } };
}

async function cpoBookingsEndpoint(ctx: Ctx, cc: string, pid: string): Promise<{ partner: Partner; url: string }> {
  const partner = await ctx.store.findPartnerByParty(cc, pid);
  if (!partner || partner.status !== "CONNECTED" || !partner.their_token) throw new ApiError(409, "This operator isn't connected right now", "PARTNER_OFFLINE");
  const url = findEndpoint(partner, "bookings", "SENDER");
  if (!url) throw new ApiError(409, "This operator doesn't support bookings over OCPI", "NO_BOOKINGS_ENDPOINT");
  return { partner, url };
}

export interface CreateBookingInput {
  fleet_id: string;
  user_id: string | null;
  vehicle: Vehicle;
  driver_id: string | null;
  cpo_country_code: string;
  cpo_party_id: string;
  booking_location_id: string;
  start_at: string;
  end_at: string;
  power_required_kw?: number | null;
  notes?: string | null;
}

export async function createBooking(ctx: Ctx, i: CreateBookingInput): Promise<BookingRow> {
  const blObj = await ctx.store.getObject<BookingLocation>("booking_locations", i.cpo_country_code, i.cpo_party_id, i.booking_location_id);
  if (!blObj) throw new ApiError(404, "Bookable site not found. Refresh and try again");
  const bl = blObj.data;
  const loc = (await ctx.store.getObject<Location>("locations", i.cpo_country_code, i.cpo_party_id, bl.location_id))?.data ?? null;
  const a = assess(i.vehicle, bl, loc);
  if (!a.ok) throw new ApiError(422, a.issues.find((x) => x.level === "block")?.text ?? "Vehicle not compatible with this bay");
  const start = new Date(i.start_at);
  const end = new Date(i.end_at);
  const slot = checkSlot(bl, start, end, ctx.now());
  if (!slot.ok) throw new ApiError(409, slot.reason ?? "Slot not available", "SLOT_UNAVAILABLE");

  const { partner, url } = await cpoBookingsEndpoint(ctx, i.cpo_country_code, i.cpo_party_id);
  const requestId = uuid();
  const authRef = shortId("HS-", 16);
  const request = buildBookingRequest({
    party: ctx.party, requestId, authorizationReference: authRef, vehicle: i.vehicle, bookingLocation: bl,
    period: { start_date_time: iso(start), end_date_time: iso(end) }, powerKw: i.power_required_kw ?? null,
  });
  const now = iso(ctx.now());
  let row: BookingRow = {
    id: uuid(), fleet_id: i.fleet_id, vehicle_id: i.vehicle.id, driver_id: i.driver_id, created_by: i.user_id,
    partner_id: partner.id, cpo_country_code: upper(i.cpo_country_code), cpo_party_id: upper(i.cpo_party_id),
    location_id: bl.location_id, booking_location_id: bl.id, request_id: requestId, authorization_reference: authRef,
    ocpi_id: null, reservation_status: "PENDING", start_at: iso(start), end_at: iso(end),
    power_required_kw: i.power_required_kw ?? null, evse_uid: null, plate: displayPlate(i.vehicle.plate),
    token_uid: i.vehicle.token_uid, token_type: tokenTypeFor(i.vehicle), last_request: request, booking: null,
    pending_action: null, session: null, cdr: null, pass_token: randomToken(18), notes: i.notes ?? null,
    created_at: now, updated_at: now,
  };
  // Insert first: the CPO may push the confirmation before its POST response reaches us.
  row = await ctx.store.insertBooking(row);
  const op = operatorName(partner, row.cpo_country_code, row.cpo_party_id, loc);
  await addEvents(ctx, row, [{ kind: "REQUESTED", message: `Booking request sent to ${op}`, data: { request_id: requestId } }]);

  const res = await ocpiCall<Booking>(ctx, {
    method: "POST", url, token: partner.their_token!, body: request, module: "bookings",
    routing: routingTo(ctx, row.cpo_country_code, row.cpo_party_id), partner, bookingId: row.id,
  });
  const fresh = (await ctx.store.getBooking(row.id))!;
  if (res.ok && res.data) return applyBookingUpdate(ctx, fresh, res.data, partner);

  const failed = await ctx.store.updateBooking(row.id, { reservation_status: "FAILED" });
  await addEvents(ctx, row, [{ kind: "FAILED", message: `${op} didn't accept the request (${res.error ?? "no response"})` }]);
  return failed;
}

export async function changeBooking(ctx: Ctx, row: BookingRow, vehicle: Vehicle, startAt: string, endAt: string, powerKw?: number | null): Promise<BookingRow> {
  if (row.reservation_status !== "RESERVED") throw new ApiError(409, "Only reserved bookings can be changed");
  if (row.pending_action) throw new ApiError(409, "A previous request is still being processed");
  const ok = canChange(row.booking?.booking_terms, row.start_at, ctx.now());
  if (!ok.ok) throw new ApiError(409, ok.reason!);
  const blObj = await ctx.store.getObject<BookingLocation>("booking_locations", row.cpo_country_code, row.cpo_party_id, row.booking_location_id);
  if (!blObj) throw new ApiError(404, "Bookable site no longer published");
  const { partner, url } = await cpoBookingsEndpoint(ctx, row.cpo_country_code, row.cpo_party_id);
  const request = buildBookingRequest({
    party: ctx.party, requestId: row.request_id, authorizationReference: row.authorization_reference, vehicle,
    bookingLocation: blObj.data, period: { start_date_time: iso(startAt), end_date_time: iso(endAt) },
    powerKw: powerKw ?? row.power_required_kw,
  });
  let updated = await ctx.store.updateBooking(row.id, {
    last_request: request,
    pending_action: { kind: "CHANGE", requested_at: iso(ctx.now()), start_at: iso(startAt), end_at: iso(endAt) },
  });
  await addEvents(ctx, row, [{ kind: "CHANGE_REQUESTED", message: "Change requested", data: { start_at: iso(startAt), end_at: iso(endAt) } }]);
  const res = await ocpiCall<Booking>(ctx, {
    method: "POST", url, token: partner.their_token!, body: request, module: "bookings",
    routing: routingTo(ctx, row.cpo_country_code, row.cpo_party_id), partner, bookingId: row.id,
  });
  updated = (await ctx.store.getBooking(row.id))!;
  if (res.ok && res.data) return applyBookingUpdate(ctx, updated, res.data, partner);
  await addEvents(ctx, row, [{ kind: "CHANGE_DECLINED", message: `Change not sent (${res.error ?? "no response"})` }]);
  return ctx.store.updateBooking(row.id, { pending_action: null });
}

export async function cancelBooking(ctx: Ctx, row: BookingRow, vehicle: Vehicle, reason: CanceledReason): Promise<BookingRow> {
  if (!["PENDING", "RESERVED"].includes(row.reservation_status)) throw new ApiError(409, "This booking can no longer be cancelled");
  const blObj = await ctx.store.getObject<BookingLocation>("booking_locations", row.cpo_country_code, row.cpo_party_id, row.booking_location_id);
  const { partner, url } = await cpoBookingsEndpoint(ctx, row.cpo_country_code, row.cpo_party_id);
  // Same request_id as the original request, with `canceled` set (Bookings module: one request id per booking).
  const request = blObj
    ? buildBookingRequest({
      party: ctx.party, requestId: row.request_id, authorizationReference: row.authorization_reference, vehicle,
      bookingLocation: blObj.data, period: { start_date_time: row.start_at, end_date_time: row.end_at },
      powerKw: row.power_required_kw, cancel: reason,
    })
    : { ...row.last_request, canceled: { cancellation_reason: reason, who_canceled: "EMSP" as const } };
  await ctx.store.updateBooking(row.id, {
    last_request: request,
    pending_action: { kind: "CANCEL", requested_at: iso(ctx.now()), reason },
  });
  await addEvents(ctx, row, [{ kind: "CANCEL_REQUESTED", message: "Cancellation requested", data: { reason } }]);
  const res = await ocpiCall<Booking>(ctx, {
    method: "POST", url, token: partner.their_token!, body: request, module: "bookings",
    routing: routingTo(ctx, row.cpo_country_code, row.cpo_party_id), partner, bookingId: row.id,
  });
  const fresh = (await ctx.store.getBooking(row.id))!;
  if (res.ok && res.data) return applyBookingUpdate(ctx, fresh, res.data, partner);
  await addEvents(ctx, row, [{ kind: "CANCEL_DECLINED", message: `Cancellation not sent (${res.error ?? "no response"})` }]);
  return ctx.store.updateBooking(row.id, { pending_action: null });
}

// ------------------------------------------------------------------ Sessions & CDRs → bookings

/** First or last value of a charging-period dimension (periods sorted by start time). */
function dimension(s: Session, type: CdrDimensionType, which: "first" | "last"): number | null {
  const periods = [...(s.charging_periods ?? [])].sort((a, b) => a.start_date_time.localeCompare(b.start_date_time));
  if (which === "last") periods.reverse();
  for (const p of periods) {
    const d = p.dimensions?.find((x) => x.type === type);
    if (d && Number.isFinite(d.volume)) return d.volume;
  }
  return null;
}

export function sessionSummary(s: Session): SessionSummary {
  const clampSoc = (v: number | null) => (v == null ? null : Math.max(0, Math.min(100, Math.round(v * 10) / 10)));
  const power = s.status === "ACTIVE" ? dimension(s, "POWER", "last") : null;
  return {
    id: s.id, status: s.status, kwh: s.kwh, start_date_time: s.start_date_time, end_date_time: s.end_date_time,
    evse_uid: s.evse_uid, total_cost: s.total_cost?.before_taxes, currency: s.currency, last_updated: s.last_updated,
    soc: clampSoc(dimension(s, "STATE_OF_CHARGE", "last")),
    soc_start: clampSoc(dimension(s, "STATE_OF_CHARGE", "first")),
    power_kw: power == null ? null : Math.max(0, Math.round(power)),
  };
}

/** A session or CDR may only update a booking made with the operator that sent it. */
const sameOperator = (row: BookingRow, cc: string, pid: string) => upper(row.cpo_country_code) === upper(cc) && upper(row.cpo_party_id) === upper(pid);

export async function linkSession(ctx: Ctx, s: Session) {
  if (!s.authorization_reference) return;
  const row = await ctx.store.findBookingByAuthRef(s.authorization_reference);
  if (!row || !sameOperator(row, s.country_code, s.party_id)) return;
  const prev = row.session;
  const events: NewEvent[] = [];
  if (s.status === "ACTIVE" && prev?.status !== "ACTIVE") events.push({ kind: "SESSION_STARTED", message: "Charging session started", data: { session_id: s.id } });
  if (s.status === "COMPLETED" && prev?.status !== "COMPLETED") events.push({ kind: "SESSION_COMPLETED", message: `Charging finished, ${s.kwh.toFixed(1)} kWh`, data: { session_id: s.id, kwh: s.kwh } });
  await ctx.store.updateBooking(row.id, {
    session: sessionSummary(s),
    ...(s.evse_uid && s.evse_uid !== "#NA" && !row.evse_uid ? { evse_uid: s.evse_uid } : {}),
  });
  await addEvents(ctx, row, events);
}

export async function linkCdr(ctx: Ctx, cdr: CDR) {
  let row: BookingRow | null = null;
  if (cdr.booking_id) row = await ctx.store.findBookingByCpoRef(cdr.country_code, cdr.party_id, cdr.booking_id);
  if (!row && cdr.authorization_reference) row = await ctx.store.findBookingByAuthRef(cdr.authorization_reference);
  if (!row || !sameOperator(row, cdr.country_code, cdr.party_id)) return;
  const taxes = (cdr.total_cost.taxes ?? []).reduce((s, t) => s + t.amount, 0);
  const summary: CdrSummary = {
    id: cdr.id, total_energy: cdr.total_energy, total_time: cdr.total_time, total_cost: cdr.total_cost.before_taxes,
    total_cost_incl_tax: taxes ? Math.round((cdr.total_cost.before_taxes + taxes) * 100) / 100 : undefined,
    total_reservation_cost: cdr.total_reservation_cost?.before_taxes, currency: cdr.currency,
    start_date_time: cdr.start_date_time, end_date_time: cdr.end_date_time,
  };
  await ctx.store.updateBooking(row.id, { cdr: summary });
  await addEvents(ctx, row, [{ kind: "CDR_RECEIVED", message: `Charge record received: ${cdr.total_energy.toFixed(1)} kWh, ${cdr.currency} ${cdr.total_cost.before_taxes.toFixed(2)} ex. VAT`, data: { cdr_id: cdr.id } }]);
}

/** Is there a booking that this arriving vehicle is using right now at this location? */
export async function bookingForArrival(ctx: Ctx, vehicle: Vehicle, locationId: string | null): Promise<BookingRow | null> {
  if (!locationId) return null;
  const now = ctx.now().getTime();
  const rows = await ctx.store.listVehicleBookings(vehicle.id, locationId);
  const match = rows
    .filter((b) => b.reservation_status === "RESERVED" || b.reservation_status === "FULFILLED")
    .filter((b) => {
      const t = b.booking?.booking_terms;
      const from = new Date(b.start_at).getTime() - (t?.early_start_allowed ? (t.early_start_time ?? 0) : 0) * 60_000;
      const to = new Date(b.end_at).getTime();
      return now >= from && now <= to;
    })
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  return match[0] ?? null;
}

export { normalizePlate };
