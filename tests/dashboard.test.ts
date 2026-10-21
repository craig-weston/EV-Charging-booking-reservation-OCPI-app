// Dashboard figures and live battery data: SoC from OCPI charging periods, KPIs, fleet overview.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../shared/ocpi/types";
import type { BookingRow, SessionSummary, Vehicle } from "../shared/model";
import { sessionSummary } from "../server/emsp/service";
import { batteryEta, computeKpis, fleetOverview, keptRate, pricePerKwh, recentCharges } from "../src/app/kpis";

const session = (periods: Session["charging_periods"], status: Session["status"] = "ACTIVE"): Session => ({
  country_code: "GB", party_id: "VHL", id: "S1", start_date_time: "2026-10-21T08:00:00Z", kwh: 120,
  cdr_token: { country_code: "GB", party_id: "DPC", uid: "U", type: "EMAID", contract_id: "C" }, auth_method: "AUTH_REQUEST",
  location_id: "L", evse_uid: "E", connector_id: "1", currency: "GBP", charging_periods: periods, status, last_updated: "2026-10-21T08:30:00Z",
});

test("state of charge and power come from the session's charging periods", () => {
  const s = session([
    { start_date_time: "2026-10-21T08:20:00Z", dimensions: [{ type: "ENERGY", volume: 60 }, { type: "POWER", volume: 344.6 }, { type: "STATE_OF_CHARGE", volume: 41.24 }] },
    { start_date_time: "2026-10-21T08:00:00Z", dimensions: [{ type: "STATE_OF_CHARGE", volume: 18 }, { type: "POWER", volume: 0 }] },
    { start_date_time: "2026-10-21T08:30:00Z", dimensions: [{ type: "ENERGY", volume: 60 }, { type: "POWER", volume: 345 }, { type: "STATE_OF_CHARGE", volume: 52.6 }] },
  ]);
  const sum = sessionSummary(s);
  assert.equal(sum.soc_start, 18); // earliest period, whatever order they arrive in
  assert.equal(sum.soc, 52.6); // latest period
  assert.equal(sum.power_kw, 345);
  // No readings: nulls, never a guess. Power is only reported while charging.
  assert.equal(sessionSummary(session([])).soc, null);
  assert.equal(sessionSummary(session([{ start_date_time: "2026-10-21T08:30:00Z", dimensions: [{ type: "POWER", volume: 300 }] }], "COMPLETED")).power_kw, null);
  // Out-of-range readings are clamped.
  assert.equal(sessionSummary(session([{ start_date_time: "2026-10-21T08:30:00Z", dimensions: [{ type: "STATE_OF_CHARGE", volume: 104 }] }])).soc, 100);
});

let n = 0;
function row(over: Partial<BookingRow> & { start_at: string; end_at: string }): BookingRow {
  n++;
  return {
    id: `b${n}`, fleet_id: "f", vehicle_id: "v1", driver_id: null, created_by: null, partner_id: null, cpo_country_code: "GB", cpo_party_id: "VHL",
    location_id: "L1", booking_location_id: "BL1", request_id: `R${n}`, authorization_reference: `A${n}`, ocpi_id: `BK${n}`, reservation_status: "FULFILLED",
    power_required_kw: null, evse_uid: null, plate: "PN74 EVH", token_uid: "T", token_type: "EMAID", last_request: {} as never, booking: null,
    pending_action: null, session: null, cdr: null, pass_token: `p${n}`, notes: null, created_at: over.start_at, updated_at: over.end_at, ...over,
  };
}
const done = (start: string, end: string, kwh: number, cost: number, soc?: [number, number]): Partial<BookingRow> => ({
  session: { id: "s", status: "COMPLETED", kwh, start_date_time: start, end_date_time: end, evse_uid: "E", currency: "GBP", last_updated: end, soc: soc?.[1] ?? null, soc_start: soc?.[0] ?? null, power_kw: null } satisfies SessionSummary,
  cdr: { id: "c", total_energy: kwh, total_time: 1, total_cost: cost, currency: "GBP", start_date_time: start, end_date_time: end },
});

test("KPIs compare this week with the previous one and count reliability", () => {
  const now = new Date("2026-10-21T09:00:00Z"); // Wednesday, 10:00 in London
  const bookings = [
    row({ start_at: "2026-10-20T11:00:00Z", end_at: "2026-10-20T12:00:00Z", ...done("2026-10-20T11:05:00Z", "2026-10-20T11:55:00Z", 200, 120) }),
    row({ start_at: "2026-10-16T11:00:00Z", end_at: "2026-10-16T12:00:00Z", ...done("2026-10-16T11:05:00Z", "2026-10-16T11:55:00Z", 100, 70) }),
    row({ start_at: "2026-10-17T06:00:00Z", end_at: "2026-10-17T07:00:00Z", reservation_status: "NO_SHOW" }),
    row({ start_at: "2026-10-18T06:00:00Z", end_at: "2026-10-18T07:00:00Z", reservation_status: "CANCELED", booking: { canceled: { who_canceled: "CPO", cancellation_reason: "BROKEN_CHARGER" } } as never }),
    // previous week
    row({ start_at: "2026-10-10T11:00:00Z", end_at: "2026-10-10T12:00:00Z", ...done("2026-10-10T11:05:00Z", "2026-10-10T11:55:00Z", 150, 105) }),
    // in the future: not history
    row({ start_at: "2026-10-21T15:00:00Z", end_at: "2026-10-21T16:00:00Z", reservation_status: "RESERVED" }),
    // charging now
    row({ start_at: "2026-10-21T08:00:00Z", end_at: "2026-10-21T09:30:00Z", session: { id: "s2", status: "ACTIVE", kwh: 50, start_date_time: "2026-10-21T08:05:00Z", evse_uid: "E", currency: "GBP", last_updated: "2026-10-21T08:55:00Z", soc: 60, soc_start: 30, power_kw: 340 } }),
  ];
  const k = computeKpis(bookings, now, 7);
  assert.equal(k.daily.length, 14);
  assert.equal(k.daily[13].key, "2026-10-21");
  assert.equal(k.current.kwh, 350); // 200 + 100 + 50 live
  assert.equal(k.current.sessions, 3);
  assert.equal(k.current.cost, 190);
  assert.equal(Math.round(pricePerKwh(k.current)! * 100) / 100, 0.63); // 190 / 300 kWh with a CDR
  assert.equal(k.current.noShows, 1);
  assert.equal(k.current.operatorCancels, 1);
  assert.equal(keptRate(k.current), 3 / 4); // three kept (incl. the one charging now), one no-show
  assert.equal(k.previous.kwh, 150);
  assert.equal(k.chargingNow, 1);
  assert.equal(k.liveKw, 340);
  assert.equal(k.daily.find((d) => d.key === "2026-10-20")!.kwh, 200);
  assert.deepEqual(recentCharges(bookings, 2).map((b) => b.start_at), ["2026-10-20T11:00:00Z", "2026-10-16T11:00:00Z"]);
});

test("live battery: estimated time to 80% and whether it lands inside the slot", () => {
  const b = row({
    start_at: "2026-10-21T08:00:00Z", end_at: "2026-10-21T09:00:00Z",
    session: { id: "s", status: "ACTIVE", kwh: 100, start_date_time: "2026-10-21T08:00:00Z", evse_uid: "E", currency: "GBP", last_updated: "2026-10-21T08:30:00Z", soc: 50, soc_start: 20, power_kw: 340 },
  });
  const e = batteryEta(b); // +30% in 30 min → 60%/h → 80% at 09:00
  assert.equal(e.target, 80);
  assert.equal(e.eta!.toISOString(), "2026-10-21T09:00:00.000Z");
  assert.equal(e.inTime, true);
  const slow = batteryEta({ ...b, end_at: "2026-10-21T08:45:00Z" });
  assert.equal(slow.inTime, false);
  // Above 80% the estimate allows for the slower end of the charge.
  const top = batteryEta({ ...b, session: { ...b.session!, soc: 85 } });
  assert.equal(top.target, 100);
  // Too early to tell: no estimate rather than a wild one.
  assert.equal(batteryEta({ ...b, session: { ...b.session!, last_updated: "2026-10-21T08:01:00Z" } }).eta, null);
});

test("fleet overview: who is charging, who is due, last known battery", () => {
  const now = new Date("2026-10-21T09:00:00Z");
  const v = (id: string, name: string, active = true) => ({ id, name, active, plate: name, vehicle_type: "TRUCK_WITH_TRAILER" } as Vehicle);
  const vehicles = [v("v1", "Tractor 01"), v("v2", "Tractor 02"), v("v3", "Rigid 03"), v("v4", "Old 04", false)];
  const bookings = [
    row({ vehicle_id: "v1", start_at: "2026-10-20T11:00:00Z", end_at: "2026-10-20T12:00:00Z", ...done("2026-10-20T11:05:00Z", "2026-10-20T11:55:00Z", 200, 120, [30, 77]) }),
    row({ vehicle_id: "v1", start_at: "2026-10-21T15:00:00Z", end_at: "2026-10-21T16:00:00Z", reservation_status: "RESERVED" }),
    row({ vehicle_id: "v2", start_at: "2026-10-21T08:30:00Z", end_at: "2026-10-21T09:30:00Z", session: { id: "s", status: "ACTIVE", kwh: 80, start_date_time: "2026-10-21T08:35:00Z", evse_uid: "E", currency: "GBP", last_updated: "2026-10-21T08:58:00Z", soc: 55, soc_start: 25, power_kw: 345 } }),
    row({ vehicle_id: "v3", start_at: "2026-10-21T09:15:00Z", end_at: "2026-10-21T10:00:00Z", reservation_status: "RESERVED" }),
  ];
  const o = fleetOverview(vehicles, bookings, now);
  assert.deepEqual(o.map((t) => [t.vehicle.name, t.state]), [["Tractor 02", "charging"], ["Rigid 03", "due"], ["Tractor 01", "booked"], ["Old 04", "inactive"]]);
  const t2 = o[0];
  assert.equal(t2.battery?.live, true);
  assert.equal(t2.battery?.soc, 55);
  const t1 = o.find((t) => t.vehicle.id === "v1")!;
  assert.deepEqual([t1.battery?.soc, t1.battery?.live, t1.battery?.at], [77, false, "2026-10-20T11:55:00Z"]);
  assert.equal(t1.next?.start_at, "2026-10-21T15:00:00Z");
  assert.equal(o.find((t) => t.vehicle.id === "v4")!.battery, null);
});
