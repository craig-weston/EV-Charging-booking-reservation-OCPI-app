// Pure booking logic: staleness, slots, terms, tariffs.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Booking, BookingLocation, Tariff } from "../shared/ocpi/types";
import type { BookingRow } from "../shared/model";
import { isStale, reconcileBooking } from "../shared/booking/request";
import { availableWindows, bookableDays, checkSlot, suggestSlots } from "../shared/booking/slots";
import { cancelTerms, canChange, deadlines } from "../shared/booking/terms";
import { estimateCost, summarizeTariffs } from "../shared/booking/tariffs";

const terms = { supported_access_methods: ["LICENSE_PLATE" as const], change_until_minutes: 60, cancel_until_minutes: 120, early_start_allowed: true, early_start_time: 20, noshow_timeout: 25, min_booking_duration: 30, max_booking_duration: 120 };
const booking = (status: Booking["reservation_status"], last: string, requests = 1): Booking => ({
  id: "BK1", country_code: "GB", party_id: "VHL", request_id: "R1", location_id: "L1",
  period: { start_date_time: "2026-10-21T10:00:00Z", end_date_time: "2026-10-21T11:00:00Z" },
  reservation_status: status, authorization_reference: "A1", booking_terms: terms, last_updated: last,
  booking_requests: Array.from({ length: requests }, (_, i) => ({ request_status: "ACCEPTED" as const, request_received: `2026-10-20T09:0${i}:00Z`, booking_request: {} as never })),
});
const row = (b: Booking | null, status: Booking["reservation_status"]): BookingRow => ({
  id: "x", fleet_id: "f", vehicle_id: null, driver_id: null, created_by: null, partner_id: null, cpo_country_code: "GB", cpo_party_id: "VHL",
  location_id: "L1", booking_location_id: "BL1", request_id: "R1", authorization_reference: "A1", ocpi_id: "BK1", reservation_status: status,
  start_at: "2026-10-21T10:00:00Z", end_at: "2026-10-21T11:00:00Z", power_required_kw: null, evse_uid: null, plate: "PN74 EVH",
  token_uid: "T", token_type: "EMAID", last_request: {} as never, booking: b, pending_action: null, session: null, cdr: null,
  pass_token: "p", notes: null, created_at: "", updated_at: "",
});

test("a late POST response cannot undo the CPO's confirmation", () => {
  const confirmed = booking("RESERVED", "2026-10-20T09:00:05Z");
  const r = row(confirmed, "RESERVED");
  assert.equal(isStale(r, booking("PENDING", "2026-10-20T09:00:05Z")), true); // same second, older shape
  assert.equal(isStale(r, booking("PENDING", "2026-10-20T09:00:01Z")), true); // older
  assert.equal(isStale(r, booking("PENDING", "2026-10-20T09:00:09Z")), false); // genuinely newer
  assert.equal(isStale(row(booking("CANCELED", "2026-10-20T09:00:05Z"), "CANCELED"), booking("RESERVED", "2026-10-20T09:00:05Z")), true);
  assert.deepEqual(reconcileBooking(r, booking("PENDING", "2026-10-20T09:00:01Z"), "Op").patch, {});
});

test("change request accepted moves the period and clears the pending action", () => {
  const r = { ...row(booking("RESERVED", "2026-10-20T09:00:00Z"), "RESERVED"), pending_action: { kind: "CHANGE" as const, requested_at: "2026-10-20T09:01:00Z" } };
  const inc = { ...booking("RESERVED", "2026-10-20T09:02:00Z", 2), period: { start_date_time: "2026-10-21T10:30:00Z", end_date_time: "2026-10-21T11:30:00Z" } };
  const { patch, events } = reconcileBooking(r, inc, "VoltHaul");
  assert.equal(patch.start_at, "2026-10-21T10:30:00Z");
  assert.equal(patch.pending_action, null);
  assert.ok(events.some((e) => e.kind === "CHANGE_ACCEPTED"));
});

const bl: BookingLocation = {
  country_code: "GB", party_id: "VHL", id: "BL1", location_id: "L1", booking_terms: terms, last_updated: "2026-10-20T00:00:00Z",
  calendars: [{ id: "C1", begin_from: "2026-10-20T23:00:00Z", end_before: "2026-10-21T23:00:00Z", timeslot_increment: 15, last_updated: "2026-10-20T00:00:00Z",
    available_timeslots: [
      { start_date_time: "2026-10-21T08:00:00Z", end_date_time: "2026-10-21T09:00:00Z", max_power: 400000 },
      { start_date_time: "2026-10-21T09:00:00Z", end_date_time: "2026-10-21T10:00:00Z", max_power: 300000 },
      { start_date_time: "2026-10-21T12:00:00Z", end_date_time: "2026-10-21T13:00:00Z" },
    ] }],
};

test("contiguous timeslots merge; slots respect increments, limits and availability", () => {
  const now = new Date("2026-10-21T07:00:00Z");
  const w = availableWindows(bl, now, new Date("2026-10-22T00:00:00Z"));
  assert.equal(w.length, 2);
  assert.equal(w[0].maxPowerW, 300000);
  assert.equal(checkSlot(bl, new Date("2026-10-21T08:30:00Z"), new Date("2026-10-21T09:30:00Z"), now).ok, true);
  assert.equal(checkSlot(bl, new Date("2026-10-21T08:10:00Z"), new Date("2026-10-21T08:55:00Z"), now).ok, false); // off-step
  assert.equal(checkSlot(bl, new Date("2026-10-21T09:30:00Z"), new Date("2026-10-21T10:30:00Z"), now).ok, false); // runs into busy time
  assert.equal(checkSlot(bl, new Date("2026-10-21T08:00:00Z"), new Date("2026-10-21T08:15:00Z"), now).ok, false); // shorter than 30 min
  const s = suggestSlots(bl, new Date("2026-10-21T11:00:00Z"), 45, now, { count: 2 });
  assert.deepEqual(s.map((x) => x.start.toISOString()), ["2026-10-21T09:15:00.000Z", "2026-10-21T12:00:00.000Z"]);
});

test("terms: arrival window, release time and cancellation deadline", () => {
  const d = deadlines(terms, "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z");
  assert.equal(d.arriveFrom.toISOString(), "2026-10-21T09:40:00.000Z");
  assert.equal(d.noShowAt?.toISOString(), "2026-10-21T10:25:00.000Z");
  assert.equal(canChange(terms, "2026-10-21T10:00:00Z", new Date("2026-10-21T09:30:00Z")).ok, false);
  assert.equal(cancelTerms(terms, "2026-10-21T10:00:00Z", new Date("2026-10-21T07:00:00Z")).free, true);
  assert.equal(cancelTerms(terms, "2026-10-21T10:00:00Z", new Date("2026-10-21T08:30:00Z")).free, false);
});

test("tariff summary reads the Bookings-module restrictions", () => {
  const t: Tariff = {
    country_code: "GB", party_id: "VHL", id: "T", currency: "GBP", tax_included: "NO", last_updated: "2026-10-20T00:00:00Z",
    elements: [
      { price_components: [{ type: "ENERGY", price: 0.6, step_size: 1, vat: 20 }] },
      { price_components: [{ type: "FLAT", price: 4, step_size: 1 }, { type: "TIME", price: 6, step_size: 900 }], restrictions: { booking: "BOOKING" } },
      { price_components: [{ type: "FLAT", price: 35, step_size: 1 }], restrictions: { booking: "BOOKING_EXPIRES" } },
      { price_components: [{ type: "FLAT", price: 15, step_size: 1 }], restrictions: { booking: "BOOKING_CANCELLATION_FEES" } },
    ],
  };
  const s = summarizeTariffs([t])!;
  assert.equal(s.energyPerKwh, 0.6);
  assert.equal(s.bookingFlat, 4);
  assert.equal(s.noShowFee, 35);
  assert.equal(s.cancelFee, 15);
  assert.deepEqual(estimateCost(s, 60, 400, 540), { booking: 10, energy: 204, total: 214, kwh: 340 });
});

test("a bay type only offers the chargers in its own parking place", async () => {
  const { SITES, buildLocation, buildOptions } = await import("../server/sim/seed");
  const { describeOption } = await import("../shared/booking/compat");
  // Avonmouth: artic bays (400 kW) and rigid bays (180 kW) both use CCS2, told apart by parking_id.
  const site = SITES.find((s) => s.id === "KCH-AVO")!;
  const loc = buildLocation(site);
  const kws = buildOptions()
    .filter((o) => o.site.id === site.id)
    .map((o) => describeOption({ ...o.bl, calendars: [] } as BookingLocation, loc))
    .map((spec) => [spec.maxKw, spec.evses.length]);
  assert.deepEqual(kws, [[400, 4], [180, 2]]);
});

test("display formatting for sizes, power and operator marks", async () => {
  const { fmtMetres, fmtKw, initials, fmtDateTime } = await import("../src/app/format");
  assert.equal(fmtMetres(1000), "10 m");
  assert.equal(fmtMetres(1650), "16.5 m");
  assert.equal(fmtKw(1000), "1 MW");
  assert.equal(fmtKw(400), "400 kW");
  assert.equal(initials("VoltHaul (demo)"), "VH");
  assert.equal(initials("Kestrel Charge (demo)"), "KC");
  const now = new Date("2026-10-21T07:00:00Z");
  assert.equal(fmtDateTime(new Date("2026-10-21T15:45:00Z"), now), "16:45 today");
  assert.equal(fmtDateTime(new Date("2026-10-22T06:00:00Z"), now), "07:00 tomorrow");
});

test("charging story timeline: the truck only plugs in while parked, and every frame is finite", async () => {
  const { frameAt, stepAt, STEPS, DURATION, PARK_FRONT, TRUCKS } = await import("../src/components/art/scene");
  for (const kind of ["artic", "rigid"] as const) {
    for (let t = 0; t < DURATION; t += 0.05) {
      const f = frameAt(t, { length: TRUCKS[kind].length, maxKw: 350 });
      for (const [k, v] of Object.entries(f)) if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} at ${t}`);
      if (f.connector > 0) assert.equal(f.front, PARK_FRONT, `plugged in while moving at ${t}`);
      if (f.energy) assert.equal(f.connector, 1, `energy without a plug at ${t}`);
      assert.ok(f.power >= 0 && f.power <= 350 * 1.02);
    }
  }
  for (const [i, s] of STEPS.entries()) {
    assert.ok(s.settle >= s.start && s.settle < s.end);
    assert.equal(stepAt(s.settle), i);
  }
});

test("bookable days follow the operators' calendars: at least a week, at most four", () => {
  const now = new Date("2026-10-21T09:00:00Z");
  const cal = (end: string, slots = 1): BookingLocation => ({
    calendars: [{ id: "c", begin_from: "2026-10-21T00:00:00Z", end_before: end, timeslot_increment: 15,
      available_timeslots: Array.from({ length: slots }, () => ({ start_date_time: "2026-10-21T10:00:00Z", end_date_time: "2026-10-21T11:00:00Z" })) }],
  } as unknown as BookingLocation);
  assert.equal(bookableDays([], now, "Europe/London").length, 7);
  assert.equal(bookableDays([cal("2026-10-24T00:00:00Z")], now, "Europe/London").length, 7);
  // 14 days published (21 Oct to 3 Nov local; the clocks go back on 25 Oct) -> 14 days offered
  const two = bookableDays([cal("2026-11-04T00:00:00Z")], now, "Europe/London");
  assert.equal(two.length, 14);
  assert.equal(two[13].toISOString(), "2026-11-03T00:00:00.000Z");
  assert.equal(bookableDays([cal("2027-03-01T00:00:00Z")], now, "Europe/London").length, 28);
  // a calendar with no free slots doesn't extend the horizon
  assert.equal(bookableDays([cal("2027-03-01T00:00:00Z", 0)], now, "Europe/London").length, 7);
});
