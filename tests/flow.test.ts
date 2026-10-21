// End-to-end: eMSP (this app) ⇄ CPO simulator over real OCPI 2.3.0 + Bookings 1.1 messages, in-process.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingLocation, BookingRequest } from "../shared/ocpi/types";
import type { BookingEvent, BookingRow, NetworkSnapshot, Vehicle } from "../shared/model";
import { assess } from "../shared/booking/compat";
import { suggestSlots } from "../shared/booking/slots";
import { harness, type Harness } from "./helpers";

async function connect(h: Harness) {
  const r = await h.api<{ partner: Partner; counts: Record<string, number> }>("POST", "/api/admin/simulator/connect");
  assert.equal(r.status, 201, JSON.stringify(r.error));
  return r.data;
}

/** The token the simulated CPO presents to us (token C). We only store its hash, so read it from the CPO's side. */
async function cpoToken(h: Harness): Promise<string> {
  const state = await h.store.getSimState<{ reg: { emsp_token: string | null } }>("cpo");
  assert.ok(state?.reg.emsp_token, "simulator is registered");
  return state!.reg.emsp_token!;
}

async function snapshot(h: Harness) {
  return (await h.api<NetworkSnapshot>("GET", "/api/network")).data;
}

async function vehicles(h: Harness) {
  return (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
}

function pick(net: NetworkSnapshot, blId: string): BookingLocation {
  const o = net.booking_locations.find((b) => b.id === blId);
  assert.ok(o, `BookingLocation ${blId} missing`);
  return o.data;
}

async function book(h: Harness, v: Vehicle, bl: BookingLocation, desiredIso: string, minutes = 45) {
  const s = suggestSlots(bl, new Date(desiredIso), minutes, h.clock.now, { count: 1 })[0];
  assert.ok(s, "no slot available");
  const r = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings`, {
    vehicle_id: v.id, cpo_country_code: bl.country_code, cpo_party_id: bl.party_id, booking_location_id: bl.id,
    start_at: s.start.toISOString(), end_at: s.end.toISOString(), power_required_kw: 400,
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  await h.ctx.flush();
  return (await h.store.getBooking(r.data.id))!;
}

test("registration handshake + initial pull", async () => {
  const h = await harness();
  const { partner, counts } = await connect(h);
  assert.equal(partner.status, "CONNECTED");
  assert.deepEqual(partner.roles.map((r) => r.party_id).sort(), ["DSN", "KCH", "VHL"]);
  assert.equal(counts.locations, 12);
  assert.equal(counts.tariffs, 24);
  assert.equal(counts.booking_locations, 18);
  const net = await snapshot(h);
  assert.equal(net.operators.length, 3);
  const bl = pick(net, "VHL-DAV-MCS");
  assert.ok(bl.calendars && bl.calendars.length >= 5, "calendars for the coming days");
  assert.equal(bl.calendars[0].timeslot_increment, 15);
  // Log shows the outbound handshake without routing headers and the inbound version GETs.
  const log = await h.store.listLogs({ limit: 50 });
  assert.ok(log.some((l) => l.direction === "OUT" && l.module === "credentials" && l.method === "POST" && l.status_code === 1000));
  assert.ok(log.some((l) => l.direction === "IN" && l.module === "versions"));
});

test("book → PENDING → RESERVED, with a spec-shaped BookingRequest", async () => {
  const h = await harness();
  await connect(h);
  const net = await snapshot(h);
  const t1 = (await vehicles(h)).find((v) => v.name === "Tractor 01")!;
  const bl = pick(net, "VHL-DAV-MCS");
  const loc = net.locations.find((l) => l.id === bl.location_id)!.data;
  assert.ok(assess(t1, bl, loc).zeroTouch, "Tractor 01 is zero-touch at Daventry MCS");

  const row = await book(h, t1, bl, "2026-10-21T10:00:00Z");
  assert.equal(row.reservation_status, "RESERVED");
  assert.ok(row.ocpi_id?.startsWith("BK"));
  const req = row.last_request as BookingRequest;
  assert.equal(req.country_code, "GB");
  assert.equal(req.party_id, "DPC");
  assert.equal(req.booking_location_id, "VHL-DAV-MCS");
  assert.deepEqual(req.access_information, [{ method: "LICENSE_PLATE", value: "PN74EVH" }]);
  assert.equal(req.tokens?.[0].type, "EMAID");
  assert.equal(req.power_required, 400);
  const ev = (await h.store.listEvents(h.fleetId)).filter((e) => e.booking_id === row.id).map((e) => e.kind);
  assert.ok(ev.includes("REQUESTED") && ev.includes("RESERVED"), ev.join(","));

  // The CPO's calendar PATCH reached the receiver and Booking GET works on our receiver.
  const got = await h.ocpi("GET", `/ocpi/emsp/2.3.0/bookings/GB/VHL/${row.ocpi_id}`, await cpoToken(h));
  assert.equal(got.status, 200);
  assert.equal((got.json.data as { reservation_status: string }).reservation_status, "RESERVED");
  assert.equal(got.headers.get("X-Request-ID"), "r1");
  assert.equal(got.headers.get("OCPI-to-party-id"), "VHL");
});

test("change accepted, cancel with reason, CPO cancellation, no-show", async () => {
  const h = await harness();
  await connect(h);
  const net = await snapshot(h);
  const [t1, t2] = await vehicles(h);
  const lut = pick(net, "VHL-LUT-CCS");
  const a = await book(h, t1, lut, "2026-10-21T13:00:00Z", 60);
  assert.equal(a.reservation_status, "RESERVED");

  const newStart = new Date(new Date(a.start_at).getTime() + 30 * 60_000);
  const ch = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings/${a.id}/change`, {
    start_at: newStart.toISOString(), end_at: new Date(newStart.getTime() + 60 * 60_000).toISOString(),
  });
  assert.equal(ch.status, 200, JSON.stringify(ch.error));
  await h.ctx.flush();
  const changed = (await h.store.getBooking(a.id))!;
  assert.equal(changed.start_at, newStart.toISOString().replace(".000", ""));
  assert.equal(changed.pending_action, null);
  assert.ok((changed.booking?.booking_requests.length ?? 0) >= 2, "second request recorded");
  assert.equal((changed.last_request as BookingRequest).request_id, a.request_id, "same request_id for edits");

  const c = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings/${a.id}/cancel`, { reason: "TRAFFIC" });
  assert.equal(c.data.reservation_status, "CANCELED");
  assert.deepEqual(c.data.booking?.canceled, { cancellation_reason: "TRAFFIC", who_canceled: "EMSP" });

  const b = await book(h, t2, lut, "2026-10-21T16:00:00Z", 45);
  const r = await h.api("POST", "/api/admin/simulator/action", { action: "cpo_cancel", booking_id: b.id, reason: "BROKEN_CHARGER" });
  assert.equal(r.status, 200, JSON.stringify(r.error));
  await h.ctx.flush();
  const bc = (await h.store.getBooking(b.id))!;
  assert.equal(bc.reservation_status, "CANCELED");
  assert.equal(bc.booking?.canceled?.who_canceled, "CPO");
  const msgs = (await h.store.listEvents(h.fleetId)).filter((e: BookingEvent) => e.booking_id === b.id).map((e) => e.message);
  assert.ok(msgs.some((m) => m.includes("Charger fault")), msgs.join(" | "));

  const n = await book(h, t2, lut, "2026-10-21T18:00:00Z", 45);
  const nr = await h.api("POST", "/api/admin/simulator/action", { action: "no_show", booking_id: n.id });
  assert.equal(nr.status, 200);
  await h.ctx.flush();
  assert.equal((await h.store.getBooking(n.id))!.reservation_status, "NO_SHOW");
});

test("arrival: plate + Autocharge → real-time authorize → session → CDR", async () => {
  const h = await harness("2026-10-21T09:00:00Z");
  await connect(h);
  const net = await snapshot(h);
  const t2 = (await vehicles(h)).find((v) => v.start_method === "AUTOCHARGE" && v.vehicle_type === "TRUCK_WITH_TRAILER")!;
  const lym = pick(net, "KCH-LYM-CCS");
  const row = await book(h, t2, lym, "2026-10-21T09:15:00Z", 60);
  assert.equal(row.reservation_status, "RESERVED");
  assert.equal(row.token_type, "OTHER");

  h.clock.now = new Date(new Date(row.start_at).getTime() - 5 * 60_000); // 5 min early (allowed: 30)
  const ar = await h.api<{ result: string }>("POST", "/api/admin/simulator/action", { action: "arrive", booking_id: row.id });
  assert.equal(ar.status, 200, JSON.stringify(ar.error));
  await h.ctx.flush();
  let b = (await h.store.getBooking(row.id))!;
  assert.equal(b.reservation_status, "FULFILLED");
  assert.equal(b.session?.status, "ACTIVE");
  assert.ok(b.evse_uid?.startsWith("KCH-LYM-"));
  const log = await h.store.listLogs({ limit: 100 });
  const auth = log.find((l) => l.direction === "IN" && l.module === "tokens" && l.url.includes("/authorize"));
  assert.ok(auth, "real-time authorization request received");
  assert.equal((auth!.response_body as { data: { allowed: string; authorization_reference: string } }).data.allowed, "ALLOWED");
  assert.equal((auth!.response_body as { data: { authorization_reference: string } }).data.authorization_reference, row.authorization_reference);

  h.clock.now = new Date(h.clock.now.getTime() + 50 * 60_000);
  const fin = await h.api("POST", "/api/admin/simulator/action", { action: "finish", booking_id: row.id });
  assert.equal(fin.status, 200, JSON.stringify(fin.error));
  await h.ctx.flush();
  b = (await h.store.getBooking(row.id))!;
  assert.equal(b.session?.status, "COMPLETED");
  assert.ok(b.cdr && b.cdr.total_energy > 100, "CDR linked by booking_id");
  assert.ok(b.cdr!.total_reservation_cost! > 0);
});

test("OCPI receiver rules: credentials 405, PATCH needs last_updated, unknown token 404/2004, tokens pagination", async () => {
  const h = await harness();
  await connect(h);
  const t = await cpoToken(h);
  const post = await h.ocpi("POST", "/ocpi/emsp/2.3.0/credentials", t, { token: "x", url: "https://x", roles: [] });
  assert.equal(post.status, 405);
  const patch = await h.ocpi("PATCH", "/ocpi/emsp/2.3.0/bookings/GB/VHL/booking_locations/VHL-DAV-MCS", t, { policy: { reservation_required: true } });
  assert.equal(patch.json.status_code, 2001);
  const foreign = await h.ocpi("PUT", "/ocpi/emsp/2.3.0/tariffs/NL/XYZ/T1", t, { id: "T1", currency: "EUR", elements: [], last_updated: "2026-10-01T00:00:00Z" });
  assert.equal(foreign.status, 404);
  const unknown = await h.ocpi("POST", "/ocpi/emsp/2.3.0/tokens/NOPE/authorize?type=OTHER", t, { location_id: "KCH-LYM" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.status_code, 2004);
  const page = await h.ocpi<unknown[]>("GET", "/ocpi/emsp/2.3.0/tokens?limit=1", t);
  assert.equal(page.json.status_code, 1000);
  assert.equal(page.json.data!.length, 1);
  assert.equal(page.headers.get("X-Total-Count"), "5"); // every truck: Autocharge (OTHER) and Plug & Charge (EMAID)
  assert.match(page.headers.get("Link") ?? "", /offset=1/);
  const bad = await h.ocpi("GET", "/ocpi/versions", "not-a-token");
  assert.equal(bad.status, 401);
});

test("driver pass and compatibility filtering", async () => {
  const h = await harness();
  await connect(h);
  const net = await snapshot(h);
  const vs = await vehicles(h);
  const t1 = vs.find((v) => v.name === "Tractor 01")!;
  const rigid = vs.find((v) => v.vehicle_type === "RIGID")!;
  const reefer = vs.find((v) => v.needs_reefer_outlet)!;
  const L = (id: string) => net.locations.find((l) => l.id === id)!.data;
  // RFID site is not zero-touch; Autocharge-only site needs driver action for Plug & Charge trucks.
  assert.equal(assess(t1, pick(net, "KCH-CAR-CCS"), L("KCH-CAR")).zeroTouch, false);
  assert.equal(assess(t1, pick(net, "KCH-DON-CCS"), L("KCH-DON")).issues.some((i) => i.code === "start"), true);
  // Rigid-only bays refuse an articulated truck; a rigid fits.
  assert.equal(assess(t1, pick(net, "KCH-AVO-RIGID"), L("KCH-AVO")).ok, false);
  assert.equal(assess(rigid, pick(net, "KCH-AVO-RIGID"), L("KCH-AVO")).ok, true);
  // MCS needs an MCS inlet.
  assert.equal(assess(rigid, pick(net, "VHL-DAV-MCS"), L("VHL-DAV")).ok, false);
  assert.equal(assess(reefer, pick(net, "VHL-LUT-CCS"), L("VHL-LUT")).issues.some((i) => i.code === "reefer"), true);

  const row = await book(h, t1, pick(net, "VHL-SMM-CCS"), "2026-10-21T15:00:00Z");
  const pass = await h.api<{ plate: string; site: { name: string }; start_method: string }>("GET", `/api/pass/${row.pass_token}`);
  assert.equal(pass.status, 200);
  assert.equal(pass.data.plate, "PN74 EVH");
  assert.equal(pass.data.site.name, "VoltHaul South Mimms");
  assert.equal(pass.data.start_method, "PLUG_AND_CHARGE");
});
