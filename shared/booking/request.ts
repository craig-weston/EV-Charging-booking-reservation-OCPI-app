// Building BookingRequests (eMSP → CPO) and reconciling Booking objects pushed back by the CPO.
import type {
  Booking, BookingLocation, BookingOption, BookingRequest, BookingRequestStatus, CanceledReason, Period, TokenType,
} from "../ocpi/types";
import { NOT_AVAILABLE } from "../ocpi/types";
import type { BookingEventKind, BookingRow, Vehicle } from "../model";
import { iso, normalizePlate } from "../util";
import { CANCEL_REASON_LABEL } from "./labels";

export function tokenTypeFor(vehicle: Pick<Vehicle, "start_method">): TokenType {
  // Plug & Charge identifies the vehicle by its ISO 15118 contract (EMAID). Autocharge has no
  // dedicated OCPI token type, so the vehicle id (e.g. "VID:<EVCCID>") is sent as OTHER.
  return vehicle.start_method === "PLUG_AND_CHARGE" ? "EMAID" : "OTHER";
}

export interface BuildRequestInput {
  party: { country_code: string; party_id: string };
  requestId: string;
  authorizationReference: string;
  vehicle: Vehicle;
  bookingLocation: BookingLocation;
  period: Period;
  powerKw?: number | null;
  cancel?: CanceledReason | null;
}

export function buildBookingRequest(i: BuildRequestInput): BookingRequest {
  const bl = i.bookingLocation;
  const blOpt = bl.booking_option ?? {};
  const sharedConnectors = (blOpt.connector_types ?? []).filter((c) => i.vehicle.connector_types.includes(c));
  const option: BookingOption = {
    ...(blOpt.evse_uid ? { evse_uid: blOpt.evse_uid } : {}),
    ...(blOpt.connector_id ? { connector_id: blOpt.connector_id } : {}),
    ...(blOpt.parking_id ? { parking_id: blOpt.parking_id } : {}),
    vehicle_types: [i.vehicle.vehicle_type],
    connector_types: sharedConnectors.length ? sharedConnectors : i.vehicle.connector_types,
    ...(blOpt.power_types?.length ? { power_types: blOpt.power_types } : {}),
    ...(i.vehicle.dangerous_goods ? { dangerous_goods_allowed: true } : {}),
    ...(i.vehicle.needs_reefer_outlet ? { refrigeration_outlet: true } : {}),
  };
  const req: BookingRequest = {
    country_code: i.party.country_code,
    party_id: i.party.party_id,
    request_id: i.requestId,
    booking_option: option,
    location_id: bl.location_id,
    booking_location_id: bl.id,
    tokens: [{
      country_code: i.party.country_code,
      party_id: i.party.party_id,
      uid: i.vehicle.token_uid,
      type: tokenTypeFor(i.vehicle),
      contract_id: i.vehicle.contract_id,
    }],
    access_information: [{ method: "LICENSE_PLATE", value: normalizePlate(i.vehicle.plate) }],
    period: { start_date_time: iso(i.period.start_date_time), end_date_time: iso(i.period.end_date_time) },
    authorization_reference: i.authorizationReference,
  };
  if (i.powerKw) req.power_required = Math.round(i.powerKw);
  if (i.cancel) req.canceled = { cancellation_reason: i.cancel, who_canceled: "EMSP" };
  return req;
}

export function latestRequest(list: BookingRequestStatus[] | undefined): BookingRequestStatus | undefined {
  if (!list?.length) return undefined;
  return [...list].sort((a, b) => new Date(a.request_received).getTime() - new Date(b.request_received).getTime()).at(-1);
}

export interface NewEvent {
  kind: BookingEventKind;
  message: string;
  data?: Record<string, unknown>;
}

const FINAL = new Set(["CANCELED", "NO_SHOW", "REJECTED", "FAILED", "FULFILLED"]);

export function statusMessage(b: Booking, operator: string): string {
  switch (b.reservation_status) {
    case "PENDING": return `Received by ${operator}, awaiting confirmation`;
    case "RESERVED": return `Reserved by ${operator}`;
    case "REJECTED": return `${operator} rejected the request: slot not available`;
    case "FAILED": return `${operator} couldn't process the request`;
    case "NO_SHOW": return "No-show. The slot was released";
    case "FULFILLED": return "Vehicle recognised, charging started";
    case "CANCELED": {
      const c = b.canceled;
      if (c?.who_canceled === "CPO") return `Cancelled by ${operator}: ${CANCEL_REASON_LABEL[c.cancellation_reason] ?? c.cancellation_reason}`;
      return c ? `Cancelled (${CANCEL_REASON_LABEL[c.cancellation_reason]?.toLowerCase() ?? c.cancellation_reason})` : "Cancelled";
    }
    default: return `Status: ${b.reservation_status}`;
  }
}

/**
 * The CPO's asynchronous PUT can overtake the synchronous POST response (both carry a Booking).
 * Ignore an incoming Booking that is older than what we hold, and never move backwards from a
 * final status, or from RESERVED to PENDING unless the incoming object is genuinely newer.
 */
export function isStale(row: BookingRow, incoming: Booking): boolean {
  const cur = row.booking;
  if (!cur) return false;
  const a = Date.parse(incoming.last_updated ?? "");
  const b = Date.parse(cur.last_updated ?? "");
  if (Number.isFinite(a) && Number.isFinite(b) && a < b) return true;
  const newer = Number.isFinite(a) && Number.isFinite(b) && a > b;
  const moreRequests = (incoming.booking_requests?.length ?? 0) > (cur.booking_requests?.length ?? 0);
  if (FINAL.has(row.reservation_status) && !FINAL.has(incoming.reservation_status)) return !newer;
  if (row.reservation_status === "RESERVED" && incoming.reservation_status === "PENDING") return !(newer || moreRequests);
  return false;
}

/** Works out what changed when the CPO pushes (PUT/PATCH) or returns a Booking. */
export function reconcileBooking(row: BookingRow, incoming: Booking, operator: string, bayName?: (evseUid: string) => string): {
  patch: Partial<BookingRow>;
  events: NewEvent[];
} {
  if (isStale(row, incoming)) return { patch: {}, events: [] };
  const events: NewEvent[] = [];
  const patch: Partial<BookingRow> = { booking: incoming };
  if (incoming.id && incoming.id !== row.ocpi_id) patch.ocpi_id = incoming.id;

  const ns = incoming.period?.start_date_time;
  const ne = incoming.period?.end_date_time;
  const periodChanged = !!ns && !!ne && (iso(ns) !== iso(row.start_at) || iso(ne) !== iso(row.end_at));
  if (periodChanged) {
    patch.start_at = iso(ns!);
    patch.end_at = iso(ne!);
  }

  const evse = incoming.booking_option?.evse_uid;
  if (evse && evse !== NOT_AVAILABLE && evse !== row.evse_uid) {
    patch.evse_uid = evse;
    events.push({ kind: "BAY_ASSIGNED", message: `Bay assigned: ${bayName ? bayName(evse) : evse}`, data: { evse_uid: evse } });
  }

  const latest = latestRequest(incoming.booking_requests);
  const pa = row.pending_action;
  let clearPending = false;
  if (pa?.kind === "CHANGE") {
    if (latest?.request_status === "ACCEPTED" || periodChanged) {
      events.push({ kind: "CHANGE_ACCEPTED", message: `${operator} accepted the new time` });
      clearPending = true;
    } else if (latest?.request_status === "DECLINED" || latest?.request_status === "FAILED") {
      events.push({ kind: "CHANGE_DECLINED", message: `${operator} declined the change. Original time kept` });
      clearPending = true;
    }
  } else if (pa?.kind === "CANCEL") {
    if (incoming.reservation_status === "CANCELED") clearPending = true;
    else if (latest?.request_status === "DECLINED" || latest?.request_status === "FAILED") {
      events.push({ kind: "CANCEL_DECLINED", message: `${operator} declined the cancellation` });
      clearPending = true;
    }
  }

  if (incoming.reservation_status && incoming.reservation_status !== row.reservation_status) {
    patch.reservation_status = incoming.reservation_status;
    events.push({ kind: incoming.reservation_status as BookingEventKind, message: statusMessage(incoming, operator), data: { reservation_status: incoming.reservation_status } });
    if (FINAL.has(incoming.reservation_status)) clearPending = true;
  }
  if (clearPending) patch.pending_action = null;
  return { patch, events };
}
