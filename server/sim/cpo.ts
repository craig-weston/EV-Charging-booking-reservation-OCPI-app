// CPO simulator — a fictional platform hosting three CPO roles that speaks real OCPI 2.3.0 +
// Bookings 1.1 to the eMSP side of this app. Enable with ENABLE_CPO_SIMULATOR=true.
//
//   /sim/cpo/versions, /sim/cpo/2.3.0                      versions
//   /sim/cpo/2.3.0/credentials                              credentials (we are the Receiver)
//   /sim/cpo/2.3.0/locations | tariffs                      Sender interfaces (GET, paginated)
//   /sim/cpo/2.3.0/bookings/booking_locations[/{id}[/{cal}]] Bookings Sender: BookingLocations & Calendars
//   /sim/cpo/2.3.0/bookings                                 Bookings Sender: GET list, POST BookingRequest
import type {
  AuthorizationInfo, Booking, BookingLocation, BookingRequest, BookingRequestStatus, CDR, Calendar, CanceledReason,
  ChargingPeriod, Credentials, Endpoint, Session, Timeslot, Version, VersionDetails,
} from "../../shared/ocpi/types";
import { OCPI_STATUS } from "../../shared/ocpi/types";
import {
  MINUTE, addLocalDays, ceilToStep, iso, localDateKey, localHourWeekday, randomToken, shortId, startOfLocalDay, tzOffsetMinutes, upper,
} from "../../shared/util";
import { OCPI_VERSION, simUrls, type Ctx } from "../context";
import { findEndpoint, ocpiCall } from "../ocpi/client";
import { OcpiHttpError, ocpiError, ocpiResponse, pageHeaders, pageParams, requestFrom, segmentsAfter, tokenCandidates, type Routing } from "../ocpi/http";
import { SIM_PARTIES, buildLocation, buildOptions, buildTariffs, SITES, type SimOption } from "./seed";

const TZ = "Europe/London";
const STEP = 15; // minutes
const DAYS = 14; // calendars published ahead; more days means more CPU per request
const KEY = "cpo";

interface SimRegistration {
  token_a: string | null;
  our_token: string | null; // token the eMSP presents to us
  emsp_token: string | null; // token we present to the eMSP
  emsp_versions_url: string | null;
  emsp_endpoints: Endpoint[];
  emsp_party: { country_code: string; party_id: string } | null;
}

interface SimBooking {
  booking: Booking;
  bl_id: string;
  arrived_at?: string;
  session?: Session;
  session_pushed_kwh?: number;
  cdr_sent?: boolean;
  /** The truck's battery as the charger sees it over ISO 15118 / Autocharge: start SoC % and size. */
  soc_start?: number;
  cap_kwh?: number;
  full_at?: string;
}

export interface SimState {
  reg: SimRegistration;
  bookings: SimBooking[];
  seq: number;
}

const emptyState = (): SimState => ({
  reg: { token_a: null, our_token: null, emsp_token: null, emsp_versions_url: null, emsp_endpoints: [], emsp_party: null },
  bookings: [],
  seq: 1,
});

async function load(ctx: Ctx): Promise<SimState> {
  return (await ctx.store.getSimState<SimState>(KEY)) ?? emptyState();
}
async function save(ctx: Ctx, s: SimState) {
  await ctx.store.putSimState(KEY, s);
}

let OPTIONS: SimOption[] | null = null;
const options = () => (OPTIONS ??= buildOptions());
const optionById = (id: string) => options().find((o) => o.bl.id === id);

// ------------------------------------------------------------------ availability model

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Share of bays used by other fleets, by local hour.
const DEMAND = [0.15, 0.12, 0.1, 0.1, 0.18, 0.32, 0.45, 0.55, 0.6, 0.55, 0.5, 0.6, 0.72, 0.68, 0.55, 0.5, 0.55, 0.62, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15];

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Per local day: key, weekday and a cheap UTC→local-hour mapping (formatters only on DST days). */
interface DayInfo {
  key: string;
  weekday: number;
  start: number;
  end: number;
  hourOf(t: number): number;
  background: Map<string, number[]>;
}
const dayCache = new Map<number, DayInfo>();

function dayInfo(dayStartMs: number): DayInfo {
  let d = dayCache.get(dayStartMs);
  if (d) return d;
  const end = addLocalDays(new Date(dayStartMs), 1, TZ).getTime();
  const off1 = tzOffsetMinutes(TZ, new Date(dayStartMs));
  const off2 = tzOffsetMinutes(TZ, new Date(end - 1));
  const noon = new Date(dayStartMs + 12 * HOUR);
  d = {
    key: localDateKey(noon, TZ),
    weekday: localHourWeekday(noon, TZ).weekday,
    start: dayStartMs,
    end,
    hourOf: off1 === off2
      ? (t) => Math.floor(((((t + off1 * MINUTE) % DAY) + DAY) % DAY) / HOUR)
      : (t) => localHourWeekday(new Date(t), TZ).hour,
    background: new Map(),
  };
  if (dayCache.size > 64) dayCache.clear();
  dayCache.set(dayStartMs, d);
  return d;
}
const dayOf = (t: number) => dayInfo(startOfLocalDay(new Date(t), TZ).getTime());

/** Bays used by other (simulated) fleets in each local hour — deterministic per site and day. */
function background(o: SimOption, d: DayInfo): number[] {
  let b = d.background.get(o.bl.id);
  if (!b) {
    const cap = o.evseUids.length;
    b = DEMAND.map((p, h) => {
      let busy = 0;
      for (let i = 0; i < cap; i++) if (hash01(`${o.bl.id}|${d.key}|${i}|${h}`) < p * 0.85) busy++;
      return busy;
    });
    d.background.set(o.bl.id, b);
  }
  return b;
}

function inHours(h: number, hours?: [number, number]) {
  if (!hours) return true;
  const [a, b] = hours;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

type Interval = [number, number];
function activeIntervals(state: SimState, blId: string, excludeId?: string): Interval[] {
  return state.bookings
    .filter((b) => b.bl_id === blId && b.booking.id !== excludeId && ["RESERVED", "PENDING", "FULFILLED"].includes(b.booking.reservation_status))
    .map((b) => [new Date(b.booking.period.start_date_time).getTime(), new Date(b.booking.period.end_date_time).getTime()]);
}

/** Free bays for the 15-minute slot starting at `t`. */
function freeAt(o: SimOption, t: number, d: DayInfo, booked: Interval[]): number {
  const h = d.hourOf(t);
  if (!inHours(h, o.bay.hours)) return 0;
  const m = o.bay.maintenance;
  if (m && d.weekday === m.weekday && h >= m.from && h < m.to) return 0;
  let busy = background(o, d)[h];
  const end = t + STEP * MINUTE;
  for (const [s, e] of booked) if (s < end && e > t) busy++;
  return Math.max(0, o.evseUids.length - busy);
}

function powerFor(o: SimOption, free: number) {
  const max = o.bay.kw * 1000;
  return { max_power: max, min_power: Math.round(max * (free >= 2 ? 0.75 : 0.5)) };
}

function isGreen(o: SimOption, t: number, d: DayInfo) {
  const g = o.bay.green;
  if (!g) return false;
  const h = d.hourOf(t);
  return h >= g[0] && h < g[1];
}

function calendarFor(o: SimOption, dayStart: Date, now: Date, state: SimState, booked = activeIntervals(state, o.bl.id)): Calendar {
  const d = dayInfo(dayStart.getTime());
  const slots: Timeslot[] = [];
  let t = Math.max(d.start, ceilToStep(now, STEP, dayStart).getTime());
  let cur: Timeslot | null = null;
  let curEnd = 0;
  const close = () => { if (cur) cur.end_date_time = iso(curEnd); };
  while (t < d.end) {
    const free = freeAt(o, t, d, booked);
    // Background demand is hourly: step a whole hour when no booking touches it (4× fewer evaluations).
    const hourAligned = (t - d.start) % HOUR === 0 && t + HOUR <= d.end;
    const next = hourAligned && !booked.some(([s, e]) => s < t + HOUR && e > t) ? t + HOUR : t + STEP * MINUTE;
    if (free > 0) {
      const p = powerFor(o, free);
      const green = isGreen(o, t, d);
      if (cur && curEnd === t && cur.min_power === p.min_power && cur.green_energy_support === green) {
        curEnd = next;
      } else {
        close();
        cur = { start_date_time: iso(t), end_date_time: "", ...p, green_energy_support: green };
        curEnd = next;
        slots.push(cur);
      }
    } else {
      close();
      cur = null;
    }
    t = next;
  }
  close();
  return {
    id: `${o.bl.id}-${d.key.replace(/-/g, "")}`,
    begin_from: iso(d.start), end_before: iso(d.end), timeslot_increment: STEP,
    available_timeslots: slots, last_updated: iso(now),
  };
}

function bookingLocation(o: SimOption, now: Date, state: SimState): BookingLocation {
  const calendars: Calendar[] = [];
  const booked = activeIntervals(state, o.bl.id);
  let day = startOfLocalDay(now, TZ);
  for (let i = 0; i < DAYS; i++) {
    const cal = calendarFor(o, day, now, state, booked);
    if (cal.available_timeslots.length) calendars.push(cal);
    day = new Date(dayInfo(day.getTime()).end);
  }
  return { ...o.bl, calendars, last_updated: iso(now) };
}

function feasible(o: SimOption, start: Date, end: Date, now: Date, state: SimState, excludeId?: string): { ok: boolean; reason?: string; minFree: number } {
  if (start < new Date(now.getTime() - 2 * MINUTE)) return { ok: false, reason: "start in the past", minFree: 0 };
  const dur = (end.getTime() - start.getTime()) / MINUTE;
  const t = o.bl.booking_terms!;
  if (t.min_booking_duration && dur < t.min_booking_duration) return { ok: false, reason: "too short", minFree: 0 };
  if (t.max_booking_duration && dur > t.max_booking_duration) return { ok: false, reason: "too long", minFree: 0 };
  const booked = activeIntervals(state, o.bl.id, excludeId);
  let minFree = Infinity;
  for (let x = start.getTime() - (((start.getTime() / MINUTE) % STEP) * MINUTE); x < end.getTime(); x += STEP * MINUTE) {
    minFree = Math.min(minFree, freeAt(o, x, dayOf(x), booked));
    if (minFree <= 0) return { ok: false, reason: "no bay free for the whole period", minFree: 0 };
  }
  return { ok: true, minFree };
}

// ------------------------------------------------------------------ OCPI plumbing

function credentialsBody(ctx: Ctx, token: string): Credentials {
  return {
    token,
    url: simUrls(ctx.baseUrl).versions,
    roles: SIM_PARTIES.map((p) => ({ role: "CPO" as const, business_details: { name: p.name, website: p.website }, party_id: p.party_id, country_code: p.country_code })),
  };
}

function simEndpoints(ctx: Ctx): Endpoint[] {
  const u = simUrls(ctx.baseUrl);
  return [
    { identifier: "credentials", role: "RECEIVER", url: u.module("credentials") },
    { identifier: "locations", role: "SENDER", url: u.module("locations") },
    { identifier: "tariffs", role: "SENDER", url: u.module("tariffs") },
    { identifier: "bookings", role: "SENDER", url: u.module("bookings") },
  ];
}

function routingFor(state: SimState, cpo: { country_code: string; party_id: string }): Routing {
  return { from: cpo, to: state.reg.emsp_party };
}

async function push<T>(ctx: Ctx, state: SimState, method: "PUT" | "PATCH" | "POST", url: string, body: unknown, cpo: { country_code: string; party_id: string }) {
  if (!state.reg.emsp_token) return null;
  return ocpiCall<T>(ctx, { method, url, token: state.reg.emsp_token, body, routing: routingFor(state, cpo), log: false });
}

function emspUrl(state: SimState, module: string) {
  return findEndpoint({ endpoints: state.reg.emsp_endpoints }, module, "RECEIVER") ?? findEndpoint({ endpoints: state.reg.emsp_endpoints }, module, "SENDER");
}

async function pushBooking(ctx: Ctx, state: SimState, b: Booking, method: "PUT" | "PATCH" = "PUT", patch?: Partial<Booking>) {
  const base = emspUrl(state, "bookings");
  if (!base) return;
  const url = `${base}/${b.country_code}/${b.party_id}/${encodeURIComponent(b.id)}`;
  await push(ctx, state, method, url, method === "PUT" ? b : { ...patch, last_updated: b.last_updated }, b);
}

async function pushCalendarFor(ctx: Ctx, state: SimState, blId: string, at: Date) {
  const o = optionById(blId);
  const base = emspUrl(state, "bookings");
  if (!o || !base) return;
  const cal = calendarFor(o, startOfLocalDay(at, TZ), ctx.now(), state);
  const url = `${base}/${o.bl.country_code}/${o.bl.party_id}/booking_locations/${encodeURIComponent(o.bl.id)}/${encodeURIComponent(cal.id)}`;
  await push(ctx, state, "PATCH", url, { timeslot_increment: cal.timeslot_increment, available_timeslots: cal.available_timeslots, last_updated: cal.last_updated }, o.bl);
}

// ------------------------------------------------------------------ request handling

export async function handleSim(req: Request, ctx: Ctx): Promise<Response> {
  if (!ctx.simulatorEnabled) return new Response("CPO simulator disabled", { status: 404 });
  const url = new URL(req.url);
  try {
    let state = await load(ctx);
    const tokens = tokenCandidates(req);
    const isRegistered = !!state.reg.our_token && tokens.includes(state.reg.our_token);
    const isTokenA = !!state.reg.token_a && tokens.includes(state.reg.token_a);
    if (!isRegistered && !isTokenA) return ocpiError(req, 401, OCPI_STATUS.CLIENT_ERROR, "Unknown credentials token");
    const path = url.pathname.replace(/\/+$/, "");
    const u = simUrls(ctx.baseUrl);
    if (path === "/sim/cpo/versions") return ocpiResponse<Version[]>(req, [{ version: OCPI_VERSION, url: u.details }]);
    if (path === `/sim/cpo/${OCPI_VERSION}`) return ocpiResponse<VersionDetails>(req, { version: OCPI_VERSION, endpoints: simEndpoints(ctx) });
    const segs = segmentsAfter(path + "/", `/sim/cpo/${OCPI_VERSION}/`) ?? [];
    const [mod, ...rest] = segs;
    if (mod === "credentials") return await simCredentials(req, ctx, state, isRegistered);
    if (!isRegistered) return ocpiError(req, 401, OCPI_STATUS.CLIENT_ERROR, "Register first");
    // Let simulated time pass (no-shows, session progress), then work on fresh state.
    await tick(ctx);
    state = await load(ctx);
    const routing: Routing = { from: { country_code: SIM_PARTIES[0].country_code, party_id: SIM_PARTIES[0].party_id }, to: requestFrom(req) };
    if (req.method === "GET" && mod === "locations" && !rest.length) return paged(req, url, SITES.map(buildLocation), routing);
    if (req.method === "GET" && mod === "tariffs" && !rest.length) return paged(req, url, SITES.flatMap(buildTariffs), routing);
    if (mod === "bookings") {
      if (req.method === "GET" && rest[0] === "booking_locations") {
        const now = ctx.now();
        if (!rest[1]) return paged(req, url, options().map((o) => bookingLocation(o, now, state)), routing);
        const o = optionById(rest[1]);
        if (!o) return ocpiError(req, 404, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown BookingLocation", routing);
        const bl = bookingLocation(o, now, state);
        if (!rest[2]) return ocpiResponse(req, bl, { routing });
        const cal = bl.calendars?.find((c) => c.id === rest[2]);
        return cal ? ocpiResponse(req, cal, { routing }) : ocpiError(req, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown Calendar", routing);
      }
      if (req.method === "GET" && !rest.length) return paged(req, url, state.bookings.map((b) => b.booking), routing);
      if (req.method === "POST" && !rest.length) {
        let body: BookingRequest;
        try { body = JSON.parse(await req.text()); } catch { return ocpiError(req, 400, OCPI_STATUS.INVALID_PARAMS, "Invalid JSON", routing); }
        return ocpiResponse(req, await receiveBookingRequest(ctx, state, body), { routing });
      }
    }
    return ocpiError(req, 404, OCPI_STATUS.CLIENT_ERROR, "Unknown endpoint");
  } catch (e) {
    if (e instanceof OcpiHttpError) return ocpiError(req, e.http, e.statusCode, e.message);
    console.error("simulator error", e);
    return ocpiError(req, 500, OCPI_STATUS.SERVER_ERROR, "Simulator error");
  }
}

function paged<T>(req: Request, url: URL, all: T[], routing: Routing) {
  const p = pageParams(url, 50);
  return ocpiResponse(req, all.slice(p.offset, p.offset + p.limit), { routing, headers: pageHeaders(url, p, all.length, 50) });
}

async function simCredentials(req: Request, ctx: Ctx, state: SimState, isRegistered: boolean): Promise<Response> {
  if (req.method === "GET") {
    return isRegistered ? ocpiResponse(req, credentialsBody(ctx, state.reg.our_token!)) : ocpiError(req, 405, OCPI_STATUS.CLIENT_ERROR, "Not registered");
  }
  if (req.method === "DELETE") {
    if (!isRegistered) return ocpiError(req, 405, OCPI_STATUS.CLIENT_ERROR, "Not registered");
    state.reg = { ...emptyState().reg };
    await save(ctx, state);
    return ocpiResponse(req, undefined);
  }
  if (req.method !== "POST" && req.method !== "PUT") return ocpiError(req, 405, OCPI_STATUS.CLIENT_ERROR, "Method not allowed");
  if (req.method === "POST" && isRegistered) return ocpiError(req, 405, OCPI_STATUS.CLIENT_ERROR, "Already registered");
  if (req.method === "PUT" && !isRegistered) return ocpiError(req, 405, OCPI_STATUS.CLIENT_ERROR, "Not registered");
  const body = JSON.parse(await req.text()) as Credentials;
  // Receiver behaviour: fetch the client's versions + details with the token it gave us.
  const v = await ocpiCall<Version[]>(ctx, { method: "GET", url: body.url, token: body.token, log: false });
  const ver = v.data?.find((x) => x.version === OCPI_VERSION);
  if (!ver) return ocpiError(req, 200, OCPI_STATUS.UNSUPPORTED_VERSION, "No mutual version");
  const d = await ocpiCall<VersionDetails>(ctx, { method: "GET", url: ver.url, token: body.token, log: false });
  if (!d.ok || !d.data) return ocpiError(req, 200, OCPI_STATUS.UNABLE_TO_USE_CLIENT_API, "Could not read version details");
  const emsp = body.roles.find((r) => r.role === "EMSP") ?? body.roles[0];
  state.reg = {
    token_a: null, our_token: randomToken(32), emsp_token: body.token, emsp_versions_url: body.url,
    emsp_endpoints: d.data.endpoints, emsp_party: emsp ? { country_code: upper(emsp.country_code), party_id: upper(emsp.party_id) } : null,
  };
  await save(ctx, state);
  return ocpiResponse(req, credentialsBody(ctx, state.reg.our_token!));
}

function bookingFromRequest(state: SimState, o: SimOption, r: BookingRequest, now: Date): Booking {
  return {
    id: `BK${String(state.seq++).padStart(5, "0")}${shortId("", 3)}`,
    country_code: o.bl.country_code, party_id: o.bl.party_id, request_id: r.request_id,
    booking_option: { ...(r.booking_option ?? {}), evse_uid: "#NA", parking_id: o.bl.booking_option?.parking_id },
    location_id: o.bl.location_id, booking_tokens: r.tokens ?? [], tariff_ids: o.bl.tariff_ids,
    period: { start_date_time: r.period.start_date_time, end_date_time: r.period.end_date_time },
    reservation_status: "PENDING", access_information: r.access_information ?? [],
    authorization_reference: r.authorization_reference, booking_terms: o.bl.booking_terms!,
    booking_requests: [{ request_status: "PENDING", booking_request: r, request_received: iso(now) }],
    last_updated: iso(now),
  };
}

async function receiveBookingRequest(ctx: Ctx, state: SimState, r: BookingRequest): Promise<Booking> {
  const now = ctx.now();
  if (!r?.request_id || !r.period?.start_date_time || !r.period?.end_date_time || !r.booking_location_id) {
    throw new OcpiHttpError(200, OCPI_STATUS.INVALID_PARAMS, "BookingRequest requires request_id, booking_location_id and period");
  }
  const o = optionById(r.booking_location_id);
  if (!o) throw new OcpiHttpError(200, OCPI_STATUS.UNKNOWN_LOCATION, "Unknown booking_location_id");
  const existing = state.bookings.find((b) => b.booking.request_id === r.request_id);

  if (existing) {
    const b = existing.booking;
    const entry: BookingRequestStatus = { request_status: "PENDING", booking_request: r, request_received: iso(now) };
    if (r.canceled) {
      // Cancellations are processed synchronously.
      if (["PENDING", "RESERVED"].includes(b.reservation_status)) {
        entry.request_status = "ACCEPTED";
        b.reservation_status = "CANCELED";
        b.canceled = r.canceled;
      } else entry.request_status = "DECLINED";
      b.booking_requests.push(entry);
      b.last_updated = iso(now);
      await save(ctx, state);
      ctx.waitUntil(pushCalendarFor(ctx, state, existing.bl_id, new Date(b.period.start_date_time)).catch(() => undefined));
      return b;
    }
    b.booking_requests.push(entry);
    b.last_updated = iso(now);
    await save(ctx, state);
    schedule(ctx);
    return b;
  }
  const b = bookingFromRequest(state, o, r, now);
  state.bookings.push({ booking: b, bl_id: o.bl.id });
  await save(ctx, state);
  schedule(ctx);
  return b;
}

function schedule(ctx: Ctx) {
  ctx.waitUntil((async () => {
    if (ctx.simDelayMs > 0) await new Promise((r) => setTimeout(r, ctx.simDelayMs));
    await processPending(ctx);
  })().catch((e) => console.error("simulator processing failed", e)));
}

/** Decide on every request still PENDING, then push the results to the eMSP. */
export async function processPending(ctx: Ctx) {
  const state = await load(ctx);
  const now = ctx.now();
  const pushes: { b: Booking; bl: string; days: Date[] }[] = [];
  for (const sb of state.bookings) {
    const b = sb.booking;
    const o = optionById(sb.bl_id);
    const pending = b.booking_requests.filter((x) => x.request_status === "PENDING");
    if (!pending.length || !o) continue;
    for (const p of pending) {
      const r = p.booking_request;
      const start = new Date(r.period.start_date_time);
      const end = new Date(r.period.end_date_time);
      const vtOk = !r.booking_option?.vehicle_types?.length || r.booking_option.vehicle_types.some((v) => o.bay.vehicleTypes.includes(v));
      const isNew = b.reservation_status === "PENDING";
      const changeDeadline = new Date(new Date(b.period.start_date_time).getTime() - (b.booking_terms.change_until_minutes ?? 0) * MINUTE);
      const f = feasible(o, start, end, now, state, b.id);
      const accepted = vtOk && f.ok && (isNew || (!b.booking_terms.change_not_allowed && now <= changeDeadline));
      const oldStart = new Date(b.period.start_date_time);
      p.request_status = accepted ? "ACCEPTED" : "DECLINED";
      if (accepted) {
        b.period = { start_date_time: r.period.start_date_time, end_date_time: r.period.end_date_time, ...powerFor(o, f.minFree), green_energy_support: isGreen(o, start.getTime(), dayOf(start.getTime())) };
        if (isNew) b.reservation_status = "RESERVED";
        if (r.power_required) b.period.max_power = Math.min(b.period.max_power ?? Infinity, r.power_required * 1000);
        // DepotShare depots allocate a fixed bay when confirming.
        if (o.bl.party_id === "DSN" && (!b.booking_option?.evse_uid || b.booking_option.evse_uid === "#NA")) {
          b.booking_option = { ...b.booking_option, evse_uid: pickBay(o, state, b) };
        }
      } else if (isNew) b.reservation_status = "REJECTED";
      b.last_updated = iso(now);
      pushes.push({ b, bl: sb.bl_id, days: [oldStart, start] });
    }
  }
  if (!pushes.length) return;
  await save(ctx, state);
  for (const p of pushes) {
    await pushBooking(ctx, state, p.b);
    const seen = new Set<string>();
    for (const d of p.days) {
      const k = localDateKey(d, TZ);
      if (seen.has(k)) continue;
      seen.add(k);
      await pushCalendarFor(ctx, state, p.bl, d);
    }
  }
}

function pickBay(o: SimOption, state: SimState, b: Booking): string {
  const s = new Date(b.period.start_date_time).getTime();
  const e = new Date(b.period.end_date_time).getTime();
  const taken = new Set(state.bookings.filter((x) => x.bl_id === o.bl.id && x.booking.id !== b.id && ["RESERVED", "FULFILLED"].includes(x.booking.reservation_status))
    .filter((x) => new Date(x.booking.period.start_date_time).getTime() < e && new Date(x.booking.period.end_date_time).getTime() > s)
    .map((x) => x.booking.booking_option?.evse_uid));
  return o.evseUids.find((u) => !taken.has(u)) ?? o.evseUids[0];
}

// ------------------------------------------------------------------ time passing

/** Releases no-shows and advances active sessions. Called lazily on simulator traffic. */
export async function tick(ctx: Ctx) {
  const state = await load(ctx);
  const now = ctx.now();
  let dirty = false;
  const work: (() => Promise<unknown>)[] = [];
  for (const sb of state.bookings) {
    const b = sb.booking;
    if (b.reservation_status === "RESERVED" && b.booking_terms.noshow_timeout != null) {
      const deadline = new Date(b.period.start_date_time).getTime() + b.booking_terms.noshow_timeout * MINUTE;
      if (now.getTime() > deadline) {
        b.reservation_status = "NO_SHOW";
        b.last_updated = iso(now);
        dirty = true;
        work.push(() => pushBooking(ctx, state, b), () => pushCalendarFor(ctx, state, sb.bl_id, new Date(b.period.start_date_time)));
      }
    }
    if (sb.session?.status === "ACTIVE") {
      const e = sessionEnergy(sb, now);
      const last = sb.session_pushed_kwh ?? 0;
      // Trucks leave when their slot ends (or a quarter of an hour after the battery is full).
      const slotOver = now.getTime() >= new Date(b.period.end_date_time).getTime();
      if (e.kw === 0 && e.soc >= 100 && !sb.full_at) { sb.full_at = iso(now); dirty = true; }
      const fullLongEnough = !!sb.full_at && now.getTime() - new Date(sb.full_at).getTime() >= 15 * MINUTE;
      if (slotOver || fullLongEnough) {
        work.push(() => finishSession(ctx, state, sb, now));
        continue;
      }
      if (e.kwh - last >= 3 || (e.kw === 0 && e.kwh > last)) {
        // Each update adds a charging period: energy since the last one, current power and state of charge.
        const period: ChargingPeriod = { start_date_time: iso(now), dimensions: [
          { type: "ENERGY", volume: Math.round((e.kwh - last) * 10) / 10 },
          { type: "POWER", volume: e.kw },
          { type: "STATE_OF_CHARGE", volume: e.soc },
        ] };
        sb.session = { ...sb.session, kwh: e.kwh, charging_periods: [...(sb.session.charging_periods ?? []), period], last_updated: iso(now) };
        sb.session_pushed_kwh = e.kwh;
        dirty = true;
        const s = sb.session;
        work.push(() => pushSession(ctx, state, s, "PATCH", [period]));
      }
    }
  }
  if (dirty) await save(ctx, state);
  for (const w of work) await w().catch(() => undefined);
  if (state.bookings.some((b) => b.booking.booking_requests.some((r) => r.request_status === "PENDING"))) await processPending(ctx);
}

/**
 * Energy so far on a simple charge curve: full power up to 80% state of charge, then 45% of it
 * until the battery is full (power drops to 0).
 */
export function sessionEnergy(sb: Pick<SimBooking, "bl_id" | "booking" | "session" | "soc_start" | "cap_kwh">, now: Date): { kwh: number; soc: number; kw: number } {
  const o = optionById(sb.bl_id);
  const s0 = Math.min(1, Math.max(0, (sb.soc_start ?? 25) / 100));
  if (!sb.session || !o) return { kwh: 0, soc: Math.round(s0 * 1000) / 10, kw: 0 };
  const hours = Math.max(0, (now.getTime() - new Date(sb.session.start_date_time).getTime()) / 3_600_000);
  const req = sb.booking.booking_requests[0]?.booking_request.power_required;
  const p = Math.max(1, Math.min(o.bay.kw, req ?? 375) * 0.92);
  const cap = sb.cap_kwh ?? 540;
  const e1 = Math.max(0, (0.8 - s0) * cap);
  const t1 = e1 / p;
  let kwh: number;
  let kw: number;
  if (hours <= t1) {
    kwh = p * hours;
    kw = p;
  } else {
    const p2 = p * 0.45;
    const e2max = (1 - Math.max(s0, 0.8)) * cap;
    const e2 = Math.min(e2max, p2 * (hours - t1));
    kwh = e1 + e2;
    kw = e2 >= e2max ? 0 : p2;
  }
  return { kwh: Math.round(kwh * 10) / 10, soc: Math.round(Math.min(100, (s0 + kwh / cap) * 100) * 10) / 10, kw: Math.round(kw) };
}

async function pushSession(ctx: Ctx, state: SimState, s: Session, method: "PUT" | "PATCH", periods?: ChargingPeriod[]) {
  const base = emspUrl(state, "sessions");
  if (!base) return;
  const url = `${base}/${s.country_code}/${s.party_id}/${encodeURIComponent(s.id)}`;
  const patch = {
    kwh: s.kwh, status: s.status, last_updated: s.last_updated,
    ...(s.end_date_time ? { end_date_time: s.end_date_time } : {}),
    ...(periods?.length ? { charging_periods: periods } : {}),
  };
  await push(ctx, state, method, url, method === "PUT" ? s : patch, s);
}

// ------------------------------------------------------------------ admin controls (in-process)

export async function simPrepareRegistration(ctx: Ctx): Promise<{ versionsUrl: string; tokenA: string }> {
  const state = await load(ctx);
  state.reg.token_a = randomToken(24);
  await save(ctx, state);
  return { versionsUrl: simUrls(ctx.baseUrl).versions, tokenA: state.reg.token_a };
}

async function findSim(ctx: Ctx, bookingRef: string): Promise<{ state: SimState; sb: SimBooking }> {
  const state = await load(ctx);
  const sb = state.bookings.find((x) => x.booking.id === bookingRef || x.booking.request_id === bookingRef);
  if (!sb) throw new Error("The simulator has no record of this booking");
  return { state, sb };
}

export type SimAction = "arrive" | "finish" | "no_show" | "cpo_cancel" | "process";

export async function simControl(ctx: Ctx, action: SimAction, bookingRef: string | null, reason?: CanceledReason): Promise<string> {
  if (action === "process") {
    await processPending(ctx);
    return "processed";
  }
  if (!bookingRef) throw new Error("booking reference required");
  const { state, sb } = await findSim(ctx, bookingRef);
  const b = sb.booking;
  const now = ctx.now();
  const o = optionById(sb.bl_id)!;
  if (action === "cpo_cancel") {
    if (!["RESERVED", "PENDING"].includes(b.reservation_status)) throw new Error("Only open bookings can be cancelled");
    b.reservation_status = "CANCELED";
    b.canceled = { cancellation_reason: reason ?? "BROKEN_CHARGER", who_canceled: "CPO" };
    b.last_updated = iso(now);
    await save(ctx, state);
    // Spec diagram "Cancel booking by CPO": PATCH with status and canceled.
    await pushBooking(ctx, state, b, "PATCH", { reservation_status: "CANCELED", canceled: b.canceled });
    await pushCalendarFor(ctx, state, sb.bl_id, new Date(b.period.start_date_time));
    return "cancelled";
  }
  if (action === "no_show") {
    if (b.reservation_status !== "RESERVED") throw new Error("Only reserved bookings can become no-shows");
    b.reservation_status = "NO_SHOW";
    b.last_updated = iso(now);
    await save(ctx, state);
    await pushBooking(ctx, state, b, "PATCH", { reservation_status: "NO_SHOW" });
    await pushCalendarFor(ctx, state, sb.bl_id, new Date(b.period.start_date_time));
    return "no_show";
  }
  if (action === "arrive") {
    if (b.reservation_status !== "RESERVED") throw new Error("Vehicle can only arrive for a reserved booking");
    const token = b.booking_tokens?.[0];
    const plate = b.access_information?.find((a) => a.method === "LICENSE_PLATE")?.value;
    if (!token) throw new Error("Booking has no vehicle token");
    const evse = b.booking_option?.evse_uid && b.booking_option.evse_uid !== "#NA" ? b.booking_option.evse_uid : pickBay(o, state, b);
    // 1) ANPR reads the plate, 2) the charger reads the vehicle id (Autocharge EVCCID / ISO 15118 EMAID),
    // 3) real-time authorisation with the eMSP.
    const tokensUrl = emspUrl(state, "tokens");
    let authRef = b.authorization_reference;
    if (tokensUrl) {
      const r = await push<AuthorizationInfo>(ctx, state, "POST", `${tokensUrl}/${encodeURIComponent(token.uid)}/authorize?type=${encodeURIComponent(String(token.type))}`, { location_id: b.location_id, evse_uids: [evse] }, b);
      if (r && !r.ok) throw new Error(`eMSP did not authorise the vehicle (${r.error ?? "no response"})`);
      if (r?.data && r.data.allowed !== "ALLOWED") throw new Error(`eMSP refused authorisation (${r.data.allowed})`);
      if (r?.data?.authorization_reference) authRef = r.data.authorization_reference;
    }
    b.reservation_status = "FULFILLED";
    b.booking_option = { ...b.booking_option, evse_uid: evse, connector_id: "1" };
    b.last_updated = iso(now);
    sb.arrived_at = iso(now);
    // What the charger learns from the truck at hand-shake: battery level now and pack size.
    const rigid = (b.booking_option.vehicle_types ?? []).includes("RIGID");
    sb.soc_start = Math.round(14 + hash01(`${b.id}:${iso(now)}:soc`) * 26);
    sb.cap_kwh = Math.round((rigid ? 315 : 540) * (0.95 + hash01(token.uid) * 0.1));
    sb.session = {
      country_code: b.country_code, party_id: b.party_id, id: `S${shortId("", 9)}`, start_date_time: iso(now), kwh: 0,
      cdr_token: { country_code: token.country_code, party_id: token.party_id, uid: token.uid, type: token.type, contract_id: token.contract_id },
      auth_method: tokensUrl ? "AUTH_REQUEST" : "WHITELIST", authorization_reference: authRef,
      location_id: b.location_id, evse_uid: evse, connector_id: "1", meter_id: `MTR-${evse}`, currency: "GBP",
      charging_periods: [{ start_date_time: iso(now), dimensions: [{ type: "STATE_OF_CHARGE", volume: sb.soc_start }, { type: "POWER", volume: 0 }] }],
      status: "ACTIVE", last_updated: iso(now),
    };
    sb.session_pushed_kwh = 0;
    await save(ctx, state);
    await pushSession(ctx, state, sb.session, "PUT");
    await pushBooking(ctx, state, b);
    return `arrived (plate ${plate ?? "?"}) → ${evse}`;
  }
  if (action === "finish") {
    const kwh = await finishSession(ctx, state, sb, now);
    return `finished: ${kwh} kWh`;
  }
  throw new Error(`Unknown action ${action}`);
}

/** Ends an active session: final Session PUT (with the last state of charge) and the CDR POST. */
async function finishSession(ctx: Ctx, state: SimState, sb: SimBooking, now: Date): Promise<number> {
  if (!sb.session || sb.session.status !== "ACTIVE") throw new Error("No active charging session");
  const b = sb.booking;
  const o = optionById(sb.bl_id)!;
  const cap = sb.cap_kwh ?? 540;
  const s0 = sb.soc_start ?? 25;
  // A real stay delivers what the charge curve gave; finishing by hand right after arrival still
  // gives a believable charge (within the battery's room).
  const room = Math.round((1 - s0 / 100) * cap * 10) / 10;
  const delivered = sessionEnergy(sb, now).kwh;
  const stayedMin = (now.getTime() - new Date(sb.session.start_date_time).getTime()) / 60_000;
  const kwh = Math.min(room, stayedMin >= 10 ? delivered : Math.max(delivered, 40 + Math.round(hash01(b.id) * 260)));
  const socEnd = Math.round(Math.min(100, s0 + (kwh / cap) * 100) * 10) / 10;
  const start = new Date(sb.session.start_date_time);
  const hours = Math.max(0.1, (now.getTime() - start.getTime()) / 3_600_000);
  const tariffs = buildTariffs(o.site);
  const energyPrice = tariffs[0].elements[0].price_components[0].price;
  const bookingEl = tariffs[1].elements.find((e) => e.restrictions?.booking === "BOOKING")!;
  const bookedH = (new Date(b.period.end_date_time).getTime() - new Date(b.period.start_date_time).getTime()) / 3_600_000;
  const bookingCost = bookingEl.price_components.reduce((s, p) => s + (p.type === "FLAT" ? p.price : p.price * bookedH), 0);
  const energyCost = Math.round(kwh * energyPrice * 100) / 100;
  const total = Math.round((energyCost + bookingCost) * 100) / 100;
  const vat = Math.round(total * 0.2 * 100) / 100;
  const lastPeriod: ChargingPeriod = { start_date_time: iso(now), dimensions: [
    { type: "ENERGY", volume: Math.max(0, Math.round((kwh - (sb.session_pushed_kwh ?? 0)) * 10) / 10) },
    { type: "POWER", volume: 0 },
    { type: "STATE_OF_CHARGE", volume: socEnd },
  ] };
  sb.session = {
    ...sb.session, kwh, status: "COMPLETED", end_date_time: iso(now),
    charging_periods: [...(sb.session.charging_periods ?? []), lastPeriod],
    total_cost: { before_taxes: total, taxes: [{ name: "VAT", percentage: 20, amount: vat }] }, last_updated: iso(now),
  };
  const loc = buildLocation(o.site);
  const evse = loc.evses!.find((e) => e.uid === sb.session!.evse_uid) ?? loc.evses![0];
  const conn = evse.connectors[0];
  const cdr: CDR = {
    country_code: b.country_code, party_id: b.party_id, id: `CDR${shortId("", 10)}`,
    start_date_time: sb.session.start_date_time, end_date_time: iso(now), booking_id: b.id, session_id: sb.session.id,
    cdr_token: sb.session.cdr_token, auth_method: sb.session.auth_method, authorization_reference: sb.session.authorization_reference,
    cdr_location: {
      id: loc.id, name: loc.name, address: loc.address, city: loc.city, postal_code: loc.postal_code, country: loc.country,
      coordinates: loc.coordinates, evse_uid: evse.uid, evse_id: evse.evse_id ?? evse.uid, connector_id: conn.id,
      connector_standard: conn.standard, connector_format: conn.format, connector_power_type: conn.power_type,
    },
    currency: "GBP", tariffs,
    charging_periods: [{ start_date_time: sb.session.start_date_time, dimensions: [{ type: "ENERGY", volume: kwh }, { type: "TIME", volume: Math.round(hours * 1000) / 1000 }, { type: "STATE_OF_CHARGE", volume: socEnd }], tariff_id: tariffs[0].id }],
    total_cost: { before_taxes: total, taxes: [{ name: "VAT", percentage: 20, amount: vat }] },
    total_energy: kwh, total_energy_cost: { before_taxes: energyCost }, total_time: Math.round(hours * 1000) / 1000,
    total_reservation_cost: { before_taxes: Math.round(bookingCost * 100) / 100 }, last_updated: iso(now),
  };
  sb.cdr_sent = true;
  await save(ctx, state);
  await pushSession(ctx, state, sb.session, "PUT");
  const cdrsUrl = emspUrl(state, "cdrs");
  if (cdrsUrl) await push(ctx, state, "POST", cdrsUrl, cdr, b);
  return kwh;
}

/** Summary used by the admin console. */
export async function simStatus(ctx: Ctx) {
  const state = await load(ctx);
  return {
    registered: !!state.reg.our_token,
    emsp_party: state.reg.emsp_party,
    bookings: state.bookings.length,
    active_sessions: state.bookings.filter((b) => b.session?.status === "ACTIVE").length,
    sites: SITES.length,
  };
}
