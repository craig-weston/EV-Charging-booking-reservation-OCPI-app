// Our OCPI 2.3.0 interface as an eMSP:
//   /ocpi/versions, /ocpi/2.3.0                                   versions
//   /ocpi/emsp/2.3.0/credentials                                    credentials & registration
//   /ocpi/emsp/2.3.0/bookings/{cc}/{pid}/booking_locations/{id}[/{calendar_id}]   Bookings receiver
//   /ocpi/emsp/2.3.0/bookings/{cc}/{pid}/{booking_id}                              Bookings receiver
//   /ocpi/emsp/2.3.0/locations|tariffs|sessions/{cc}/{pid}/{id}…    receivers
//   /ocpi/emsp/2.3.0/cdrs                                           CDR receiver (POST) + GET by URL
//   /ocpi/emsp/2.3.0/tokens[/{uid}/authorize]                       Tokens sender + real-time authorization
import type {
  AuthorizationInfo, Booking, BookingLocation, CDR, Calendar, Connector, Credentials, EVSE, Location,
  LocationReferences, Session, Tariff, Token, TokenType,
} from "../../shared/ocpi/types";
import { OCPI_STATUS } from "../../shared/ocpi/types";
import type { Fleet, OcpiLogEntry, OcpiModule, Partner, StoredObject, Vehicle } from "../../shared/model";
import { tokenTypeFor } from "../../shared/booking/request";
import { deepMerge, iso, partyKey, shortId, upper, uuid } from "../../shared/util";
import { OCPI_VERSION, ocpiUrls, type Ctx } from "../context";
import { BODY_LIMITS, BodyTooLarge, readLimited, sha256Hex } from "../security";
import { addEvents, applyBookingUpdate, bookingForArrival, linkCdr, linkSession } from "../emsp/service";
import { logBody } from "./client";
import { OcpiHttpError, ocpiError, ocpiResponse, pageHeaders, pageParams, requestFrom, segmentsAfter, tokenCandidates, type Routing } from "./http";
import { acceptRegistration, ourCredentials, ourEndpoints, updateRegistration } from "./registration";

interface Call {
  req: Request;
  url: URL;
  ctx: Ctx;
  partner: Partner;
  /** The credentials token the partner presented (we only store its hash). */
  token: string;
  viaRegistration: boolean;
  body: unknown;
  routing: Routing;
}

const MODULE_PREFIX = `/ocpi/emsp/${OCPI_VERSION}/`;

export async function handleOcpi(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const started = Date.now();
  let body: unknown;
  let module: string | null = moduleOf(url.pathname);
  let partner: Partner | null = null;
  let res: Response;
  try {
    let text = "";
    try {
      text = ["POST", "PUT", "PATCH"].includes(req.method) ? await readLimited(req, BODY_LIMITS.ocpi) : "";
    } catch (e) {
      throw new OcpiHttpError(413, OCPI_STATUS.INVALID_PARAMS, e instanceof BodyTooLarge ? e.message : "Couldn't read the request body");
    }
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { throw new OcpiHttpError(400, OCPI_STATUS.INVALID_PARAMS, "Request body is not valid JSON"); }
    }
    let viaRegistration = false;
    let presented = "";
    // Tokens are matched by their SHA-256: we never store the credentials tokens we issue.
    const candidates = await Promise.all(tokenCandidates(req).map(async (t) => ({ t, h: await sha256Hex(t) })));
    for (const c of candidates) {
      partner = await ctx.store.findPartnerByTokenHash(c.h);
      if (partner) { presented = c.t; break; }
    }
    if (!partner) {
      for (const c of candidates) {
        const p = await ctx.store.findPartnerByRegistrationHash(c.h);
        if (p) { partner = p; viaRegistration = true; presented = c.t; break; }
      }
    }
    if (!partner) {
      res = ocpiError(req, 401, OCPI_STATUS.CLIENT_ERROR, "Unknown or missing credentials token");
    } else {
      const from = requestFrom(req) ?? (partner.roles[0] ? { country_code: partner.roles[0].country_code, party_id: partner.roles[0].party_id } : null);
      const routing: Routing = { from: { country_code: ctx.party.country_code, party_id: ctx.party.party_id }, to: from };
      res = await route({ req, url, ctx, partner, token: presented, viaRegistration, body, routing });
    }
  } catch (e) {
    if (e instanceof OcpiHttpError) res = ocpiError(req, e.http, e.statusCode, e.message);
    else {
      console.error("OCPI handler error", e);
      res = ocpiError(req, 500, OCPI_STATUS.SERVER_ERROR, "Internal error");
    }
  }
  // message log (inbound)
  try {
    const resText = await res.clone().text();
    let resBody: unknown = null;
    try { resBody = resText ? JSON.parse(resText) : null; } catch { resBody = resText; }
    const from = requestFrom(req);
    const entry: OcpiLogEntry = {
      id: uuid(), at: iso(new Date(started)), direction: "IN", partner_id: partner?.id ?? null,
      party: from ? partyKey(from.country_code, from.party_id) : partner?.roles[0] ? partyKey(partner.roles[0].country_code, partner.roles[0].party_id) : null,
      module, method: req.method, url: url.pathname + url.search, http_status: res.status,
      status_code: (resBody as { status_code?: number } | null)?.status_code ?? null,
      request_id: req.headers.get("X-Request-ID"), correlation_id: req.headers.get("X-Correlation-ID"),
      request_body: logBody(body ?? null), response_body: logBody(resBody), duration_ms: Date.now() - started,
      booking_id: (ctx.cache.get("log:booking") as string | undefined) ?? null,
    };
    ctx.cache.delete("log:booking");
    ctx.waitUntil(ctx.store.addLogs([entry]).catch(() => undefined));
  } catch { /* logging must never break OCPI */ }
  return res;
}

function moduleOf(pathname: string): string | null {
  if (pathname.startsWith("/ocpi/versions") || pathname.replace(/\/+$/, "") === `/ocpi/${OCPI_VERSION}`) return "versions";
  const segs = segmentsAfter(pathname, MODULE_PREFIX);
  return segs?.[0] ?? null;
}

async function route(c: Call): Promise<Response> {
  const path = c.url.pathname.replace(/\/+$/, "");
  const u = ocpiUrls(c.ctx.baseUrl);
  if (path === "/ocpi/versions") {
    if (c.req.method !== "GET") return methodNotAllowed(c);
    return ocpiResponse(c.req, [{ version: OCPI_VERSION, url: u.details }]);
  }
  if (path === `/ocpi/${OCPI_VERSION}`) {
    if (c.req.method !== "GET") return methodNotAllowed(c);
    return ocpiResponse(c.req, { version: OCPI_VERSION, endpoints: ourEndpoints(c.ctx) });
  }
  const segs = segmentsAfter(path + "/", MODULE_PREFIX);
  if (!segs?.length) return ocpiError(c.req, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown endpoint");
  const [mod, ...rest] = segs;
  if (mod === "credentials") return credentials(c);
  // Functional modules need a completed registration.
  if (c.viaRegistration || c.partner.status !== "CONNECTED") {
    return ocpiError(c.req, 401, OCPI_STATUS.CLIENT_ERROR, "Credentials token A can only be used for registration");
  }
  switch (mod) {
    case "bookings": return bookings(c, rest);
    case "locations": return locations(c, rest);
    case "tariffs": return tariffs(c, rest);
    case "sessions": return sessions(c, rest);
    case "cdrs": return cdrs(c, rest);
    case "tokens": return tokens(c, rest);
    default: return ocpiError(c.req, 404, OCPI_STATUS.CLIENT_ERROR, `Module '${mod}' not implemented`);
  }
}

// OCPI §5: once a request reaches the OCPI layer (valid JSON), errors are reported in status_code with HTTP 200;
// unknown resources get HTTP 404; PUT answers 201 when it created the object.
const ok = <T>(c: Call, data?: T, headers?: Record<string, string>, http = 200) => ocpiResponse(c.req, data, { routing: c.routing, headers, http });
const created = (c: Call, existed: boolean) => ok(c, undefined, undefined, existed ? 200 : 201);
const fail = (c: Call, http: number, code: number, msg: string) => ocpiError(c.req, http, code, msg, c.routing);
const methodNotAllowed = (c: Call) => ocpiError(c.req, 405, OCPI_STATUS.CLIENT_ERROR, `${c.req.method} not supported here`);

function ownsParty(p: Partner, cc: string, pid: string) {
  return p.roles.some((r) => upper(r.country_code) === upper(cc) && upper(r.party_id) === upper(pid));
}

function requireParty(c: Call, cc?: string, pid?: string) {
  if (!cc || !pid) throw new OcpiHttpError(400, OCPI_STATUS.INVALID_PARAMS, "country_code and party_id are required URL segments");
  if (!ownsParty(c.partner, cc, pid)) throw new OcpiHttpError(404, OCPI_STATUS.CLIENT_ERROR, `Party ${partyKey(cc, pid)} does not belong to these credentials`);
}

function requireBody<T>(c: Call): T {
  if (!c.body || typeof c.body !== "object" || Array.isArray(c.body)) throw new OcpiHttpError(200, OCPI_STATUS.INVALID_PARAMS, "JSON object body required");
  return c.body as T;
}

function requireLastUpdated(c: Call) {
  const b = requireBody<{ last_updated?: string }>(c);
  if (!b.last_updated) throw new OcpiHttpError(200, OCPI_STATUS.INVALID_PARAMS, "PATCH requests must contain last_updated");
  return b;
}

function stored<T>(module: OcpiModule, cc: string, pid: string, id: string, data: T, last: string | undefined, partner: Partner): StoredObject<T> {
  return { module, country_code: upper(cc), party_id: upper(pid), id, data, last_updated: last ?? iso(new Date()), partner_id: partner.id };
}

// ------------------------------------------------------------------ credentials
async function credentials(c: Call): Promise<Response> {
  const registered = !c.viaRegistration && c.partner.status === "CONNECTED";
  switch (c.req.method) {
    case "GET":
      if (!registered) return ocpiError(c.req, 405, OCPI_STATUS.CLIENT_ERROR, "Not registered yet");
      // We keep only a hash of token C, so echo the one the partner authenticated with.
      return ocpiResponse(c.req, ourCredentials(c.ctx, c.token));
    case "POST":
      if (registered) return ocpiError(c.req, 405, OCPI_STATUS.CLIENT_ERROR, "Already registered, use PUT to update");
      if (!c.viaRegistration) return ocpiError(c.req, 401, OCPI_STATUS.CLIENT_ERROR, "Use the registration token (CREDENTIALS_TOKEN_A)");
      try {
        return ocpiResponse(c.req, await acceptRegistration(c.ctx, c.partner, requireBody<Credentials>(c)));
      } catch (e) {
        if (e instanceof OcpiHttpError) return ocpiError(c.req, e.http, e.statusCode, e.message);
        throw e;
      }
    case "PUT":
      if (!registered) return ocpiError(c.req, 405, OCPI_STATUS.CLIENT_ERROR, "Not registered yet");
      try {
        return ocpiResponse(c.req, await updateRegistration(c.ctx, c.partner, requireBody<Credentials>(c)));
      } catch (e) {
        if (e instanceof OcpiHttpError) return ocpiError(c.req, e.http, e.statusCode, e.message);
        throw e;
      }
    case "DELETE":
      if (!registered) return ocpiError(c.req, 405, OCPI_STATUS.CLIENT_ERROR, "Not registered");
      await c.ctx.store.upsertPartner({ ...c.partner, status: "REMOVED", our_token_hash: null, their_token: null, registration_token_hash: null, updated_at: iso(c.ctx.now()) });
      return ocpiResponse(c.req, undefined);
    default:
      return methodNotAllowed(c);
  }
}

// ------------------------------------------------------------------ bookings receiver
async function bookings(c: Call, rest: string[]): Promise<Response> {
  // Canonical: {cc}/{pid}/booking_locations/{id}[/{cal}]  and  {cc}/{pid}/{booking_id}
  // Also accepted (spec example variants): booking_locations|bookinglocations/{cc}/{pid}/{id}[/{cal}]
  let segs = rest;
  if (segs[0] === "booking_locations" || segs[0] === "bookinglocations") segs = [segs[1], segs[2], "booking_locations", ...segs.slice(3)];
  const [cc, pid, third, ...more] = segs;
  requireParty(c, cc, pid);
  if (third === "booking_locations" || third === "bookinglocations") return bookingLocations(c, cc, pid, more[0], more[1]);
  if (!third) return fail(c, 400, OCPI_STATUS.INVALID_PARAMS, "booking_id missing");
  return booking(c, cc, pid, third);
}

async function bookingLocations(c: Call, cc: string, pid: string, id?: string, calendarId?: string): Promise<Response> {
  if (!id) return fail(c, 400, OCPI_STATUS.INVALID_PARAMS, "booking_location_id missing");
  const store = c.ctx.store;
  const existing = await store.getObject<BookingLocation>("booking_locations", cc, pid, id);
  switch (c.req.method) {
    case "GET": {
      if (!existing) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown BookingLocation");
      if (!calendarId) return ok(c, existing.data);
      const cal = existing.data.calendars?.find((x) => x.id === calendarId);
      return cal ? ok(c, cal) : fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown Calendar");
    }
    case "PUT": {
      if (!calendarId) {
        const bl = requireBody<BookingLocation>(c);
        if (bl.id && bl.id !== id) return fail(c, 200, OCPI_STATUS.INVALID_PARAMS, "BookingLocation.id does not match the URL");
        if (!bl.location_id) return fail(c, 200, OCPI_STATUS.INVALID_PARAMS, "location_id is required");
        const data = { ...bl, id, country_code: upper(cc), party_id: upper(pid) };
        await store.putObject(stored("booking_locations", cc, pid, id, data, bl.last_updated, c.partner));
        return created(c, !!existing);
      }
      if (!existing) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown BookingLocation");
      const cal = requireBody<Calendar>(c);
      const hadCalendar = (existing.data.calendars ?? []).some((x) => x.id === calendarId);
      const calendars = [...(existing.data.calendars ?? []).filter((x) => x.id !== calendarId), { ...cal, id: calendarId }];
      const last = cal.last_updated ?? iso(c.ctx.now());
      await store.putObject(stored("booking_locations", cc, pid, id, { ...existing.data, calendars, last_updated: last }, last, c.partner));
      return created(c, hadCalendar);
    }
    case "PATCH": {
      const patch = requireLastUpdated(c) as Partial<BookingLocation> & Partial<Calendar> & { status?: string };
      if (!existing) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown BookingLocation");
      if (calendarId) {
        const cals = existing.data.calendars ?? [];
        const idx = cals.findIndex((x) => x.id === calendarId);
        if (idx < 0) return fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown Calendar");
        cals[idx] = { ...cals[idx], ...(patch as Partial<Calendar>), id: calendarId };
        // Spec: a PATCH on a Calendar also sets last_updated on the parent BookingLocation.
        await store.putObject(stored("booking_locations", cc, pid, id, { ...existing.data, calendars: cals, last_updated: patch.last_updated! }, patch.last_updated, c.partner));
        return ok(c);
      }
      const merged = deepMerge(existing.data, patch as Partial<BookingLocation>);
      await store.putObject(stored("booking_locations", cc, pid, id, { ...merged, id }, patch.last_updated, c.partner));
      if (patch.status === "REMOVED") await store.deleteObject("booking_locations", cc, pid, id);
      return ok(c);
    }
    default:
      return methodNotAllowed(c);
  }
}

async function booking(c: Call, cc: string, pid: string, ref: string): Promise<Response> {
  const store = c.ctx.store;
  switch (c.req.method) {
    case "GET": {
      const row = await store.findBookingByCpoRef(cc, pid, ref);
      return row?.booking ? ok(c, row.booking) : fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown Booking");
    }
    case "PUT": {
      const b = requireBody<Booking>(c);
      if (!b.reservation_status || !b.period) return fail(c, 200, OCPI_STATUS.INVALID_PARAMS, "Booking requires reservation_status and period");
      const row = (b.request_id ? await store.findBookingByRequestId(b.request_id) : null) ?? (await store.findBookingByCpoRef(cc, pid, ref));
      if (!row || upper(row.cpo_country_code) !== upper(cc) || upper(row.cpo_party_id) !== upper(pid)) {
        return fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "No booking request with this request_id was sent by us");
      }
      c.ctx.cache.set("log:booking", row.id);
      await applyBookingUpdate(c.ctx, row, { ...b, id: b.id || row.ocpi_id || ref }, c.partner);
      return ok(c);
    }
    case "PATCH": {
      const patch = requireLastUpdated(c) as Partial<Booking> & { evse_uid?: string; connector_id?: string; parking_id?: string };
      const row = (patch.request_id ? await store.findBookingByRequestId(patch.request_id) : null) ?? (await store.findBookingByCpoRef(cc, pid, ref));
      if (!row?.booking) return fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown Booking");
      c.ctx.cache.set("log:booking", row.id);
      // Tolerate the 1.0-style top-level evse_uid/connector_id/parking_id (moved into booking_option in 1.1).
      const { evse_uid, connector_id, parking_id, ...restPatch } = patch;
      const option = { ...(row.booking.booking_option ?? {}), ...(restPatch.booking_option ?? {}) };
      if (evse_uid) option.evse_uid = evse_uid;
      if (connector_id) option.connector_id = connector_id;
      if (parking_id) option.parking_id = parking_id;
      const merged: Booking = { ...deepMerge(row.booking, restPatch), booking_option: option };
      await applyBookingUpdate(c.ctx, row, merged, c.partner);
      return ok(c);
    }
    default:
      return methodNotAllowed(c);
  }
}

// ------------------------------------------------------------------ locations receiver
async function locations(c: Call, rest: string[]): Promise<Response> {
  const [cc, pid, locId, evseUid, connId] = rest;
  requireParty(c, cc, pid);
  if (!locId) return fail(c, 400, OCPI_STATUS.INVALID_PARAMS, "location_id missing");
  const store = c.ctx.store;
  const existing = await store.getObject<Location>("locations", cc, pid, locId);
  const save = (loc: Location) => store.putObject(stored("locations", cc, pid, locId, loc, loc.last_updated, c.partner));

  if (c.req.method === "GET") {
    if (!existing) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown Location");
    if (!evseUid) return ok(c, existing.data);
    const evse = existing.data.evses?.find((e) => e.uid === evseUid);
    if (!evse) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown EVSE");
    if (!connId) return ok(c, evse);
    const conn = evse.connectors.find((x) => x.id === connId);
    return conn ? ok(c, conn) : fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown Connector");
  }
  if (c.req.method !== "PUT" && c.req.method !== "PATCH") return methodNotAllowed(c);
  const isPatch = c.req.method === "PATCH";
  const body = (isPatch ? requireLastUpdated(c) : requireBody(c)) as Record<string, unknown> & { last_updated?: string };

  if (!evseUid) {
    if (isPatch) {
      if (!existing) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown Location");
      await save({ ...deepMerge(existing.data, body as Partial<Location>), id: locId });
    } else {
      const loc = body as unknown as Location;
      if (loc.id && loc.id !== locId) return fail(c, 200, OCPI_STATUS.INVALID_PARAMS, "Location.id does not match the URL");
      await save({ ...loc, id: locId, country_code: upper(cc), party_id: upper(pid) });
      return created(c, !!existing);
    }
    return ok(c);
  }
  if (!existing) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown Location");
  const loc = existing.data;
  const evses = loc.evses ?? [];
  const ei = evses.findIndex((e) => e.uid === evseUid);
  if (!connId) {
    if (isPatch) {
      if (ei < 0) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown EVSE");
      evses[ei] = { ...deepMerge(evses[ei], body as Partial<EVSE>), uid: evseUid };
    } else {
      const evse = { ...(body as unknown as EVSE), uid: evseUid };
      if (ei >= 0) evses[ei] = evse; else evses.push(evse);
    }
  } else {
    if (ei < 0) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown EVSE");
    const conns = evses[ei].connectors ?? [];
    const ci = conns.findIndex((x) => x.id === connId);
    if (isPatch) {
      if (ci < 0) return fail(c, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown Connector");
      conns[ci] = { ...conns[ci], ...(body as Partial<Connector>), id: connId };
    } else {
      const conn = { ...(body as unknown as Connector), id: connId };
      if (ci >= 0) conns[ci] = conn; else conns.push(conn);
    }
    evses[ei] = { ...evses[ei], connectors: conns, last_updated: body.last_updated ?? evses[ei].last_updated };
  }
  // Location.last_updated tracks changes to its EVSEs and Connectors too.
  await save({ ...loc, evses, last_updated: body.last_updated ?? iso(c.ctx.now()) });
  return isPatch ? ok(c) : created(c, connId ? true : ei >= 0);
}

// ------------------------------------------------------------------ tariffs receiver
async function tariffs(c: Call, rest: string[]): Promise<Response> {
  const [cc, pid, id] = rest;
  requireParty(c, cc, pid);
  if (!id) return fail(c, 400, OCPI_STATUS.INVALID_PARAMS, "tariff_id missing");
  const store = c.ctx.store;
  switch (c.req.method) {
    case "GET": {
      const t = await store.getObject<Tariff>("tariffs", cc, pid, id);
      return t ? ok(c, t.data) : fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown Tariff");
    }
    case "PUT": {
      const t = requireBody<Tariff>(c);
      if (t.id && t.id !== id) return fail(c, 200, OCPI_STATUS.INVALID_PARAMS, "Tariff.id does not match the URL");
      if (!Array.isArray(t.elements) || !t.currency) return fail(c, 200, OCPI_STATUS.INVALID_PARAMS, "Tariff requires currency and elements");
      const had = await store.getObject("tariffs", cc, pid, id);
      await store.putObject(stored("tariffs", cc, pid, id, { ...t, id, country_code: upper(cc), party_id: upper(pid) }, t.last_updated, c.partner));
      return created(c, !!had);
    }
    case "DELETE":
      await store.deleteObject("tariffs", cc, pid, id);
      return ok(c);
    default:
      return methodNotAllowed(c);
  }
}

// ------------------------------------------------------------------ sessions receiver
async function sessions(c: Call, rest: string[]): Promise<Response> {
  const [cc, pid, id] = rest;
  requireParty(c, cc, pid);
  if (!id) return fail(c, 400, OCPI_STATUS.INVALID_PARAMS, "session_id missing");
  const store = c.ctx.store;
  const existing = await store.getObject<Session>("sessions", cc, pid, id);
  switch (c.req.method) {
    case "GET":
      return existing ? ok(c, existing.data) : fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown Session");
    case "PUT":
    case "PATCH": {
      let s: Session;
      if (c.req.method === "PATCH") {
        const patch = requireLastUpdated(c) as Partial<Session>;
        if (!existing) return fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown Session");
        // A PATCH with charging_periods adds periods (Sessions module).
        const periods = patch.charging_periods ? [...(existing.data.charging_periods ?? []), ...patch.charging_periods] : existing.data.charging_periods;
        s = { ...existing.data, ...patch, charging_periods: periods };
      } else {
        s = { ...requireBody<Session>(c), id };
      }
      await store.putObject(stored("sessions", cc, pid, id, s, s.last_updated, c.partner));
      const row = s.authorization_reference ? await store.findBookingByAuthRef(s.authorization_reference) : null;
      if (row) c.ctx.cache.set("log:booking", row.id);
      await linkSession(c.ctx, s);
      return c.req.method === "PUT" ? created(c, !!existing) : ok(c);
    }
    default:
      return methodNotAllowed(c);
  }
}

// ------------------------------------------------------------------ CDR receiver
async function cdrs(c: Call, rest: string[]): Promise<Response> {
  const store = c.ctx.store;
  if (c.req.method === "POST" && rest.length === 0) {
    const cdr = requireBody<CDR>(c);
    if (!cdr.id || !cdr.country_code || !cdr.party_id) return fail(c, 200, OCPI_STATUS.INVALID_PARAMS, "CDR requires id, country_code and party_id");
    requireParty(c, cdr.country_code, cdr.party_id);
    await store.putObject(stored("cdrs", cdr.country_code, cdr.party_id, cdr.id, cdr, cdr.last_updated, c.partner));
    await linkCdr(c.ctx, cdr);
    const location = `${ocpiUrls(c.ctx.baseUrl).module("cdrs")}/${upper(cdr.country_code)}/${upper(cdr.party_id)}/${encodeURIComponent(cdr.id)}`;
    return ocpiResponse(c.req, undefined, { routing: c.routing, headers: { Location: location }, http: 201 });
  }
  if (c.req.method === "GET" && rest.length === 3) {
    const [cc, pid, id] = rest;
    requireParty(c, cc, pid);
    const o = await store.getObject<CDR>("cdrs", cc, pid, id);
    return o ? ok(c, o.data) : fail(c, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown CDR");
  }
  return methodNotAllowed(c);
}

// ------------------------------------------------------------------ tokens sender
/**
 * The Token we publish for a vehicle. Operators must ask us in real time whenever they can
 * (ALLOWED_OFFLINE), and never whitelist trucks of fleets that only pay for booked sessions (NEVER).
 * The number plate is not included: operators receive it only with a booking that needs it.
 */
export function vehicleToken(ctx: Ctx, v: Vehicle, fleet?: Pick<Fleet, "allow_unbooked_charging"> | null): Token {
  return {
    country_code: ctx.party.country_code,
    party_id: ctx.party.party_id,
    uid: v.token_uid,
    type: tokenTypeFor(v),
    contract_id: v.contract_id,
    issuer: ctx.party.name,
    valid: v.active,
    whitelist: fleet && !fleet.allow_unbooked_charging ? "NEVER" : "ALLOWED_OFFLINE",
    last_updated: v.updated_at,
  };
}

async function tokens(c: Call, rest: string[]): Promise<Response> {
  const store = c.ctx.store;
  if (rest.length === 0 && c.req.method === "GET") {
    const p = pageParams(c.url, 100);
    const page = await store.listTokenVehicles(p);
    const fleets = new Map<string, Fleet | null>();
    for (const v of page.items) if (!fleets.has(v.fleet_id)) fleets.set(v.fleet_id, await store.getFleet(v.fleet_id));
    return ok(c, page.items.map((v) => vehicleToken(c.ctx, v, fleets.get(v.fleet_id))), pageHeaders(c.url, p, page.total, 100));
  }
  if (rest.length === 2 && rest[1] === "authorize" && c.req.method === "POST") {
    const uid = rest[0];
    const type = (c.url.searchParams.get("type") ?? "") as TokenType;
    const vehicle = await store.findVehicleByToken(uid);
    if (!vehicle || (type && type !== "RFID" && tokenTypeFor(vehicle) !== type)) {
      return fail(c, 404, OCPI_STATUS.UNKNOWN_TOKEN, "Unknown Token");
    }
    const refs = c.body as LocationReferences | undefined;
    const fleet = await store.getFleet(vehicle.fleet_id);
    const token = vehicleToken(c.ctx, vehicle, fleet);
    if (!vehicle.active) return ok(c, { allowed: "BLOCKED", token } satisfies AuthorizationInfo);
    const booking = await bookingForArrival(c.ctx, vehicle, refs?.location_id ?? null);
    if (booking) {
      c.ctx.cache.set("log:booking", booking.id);
      await addEvents(c.ctx, booking, [{ kind: "AUTHORIZED", message: "Vehicle authorised by the fleet platform (real-time)" }]);
      const info: AuthorizationInfo = {
        allowed: "ALLOWED", token, authorization_reference: booking.authorization_reference,
        ...(refs ? { location: refs } : {}),
        info: { language: "en", text: "Booked slot, enjoy your charge" },
      };
      return ok(c, info);
    }
    if (fleet && !fleet.allow_unbooked_charging) {
      if (!refs) return fail(c, 200, OCPI_STATUS.NOT_ENOUGH_INFO, "LocationReferences required to match a booking");
      return ok(c, { allowed: "NOT_ALLOWED", token, location: refs, info: { language: "en", text: "No booking for this vehicle here" } } satisfies AuthorizationInfo);
    }
    return ok(c, { allowed: "ALLOWED", token, authorization_reference: shortId("HA-", 16), ...(refs ? { location: refs } : {}) } satisfies AuthorizationInfo);
  }
  return methodNotAllowed(c);
}
