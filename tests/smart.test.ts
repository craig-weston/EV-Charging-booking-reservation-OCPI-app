// Smart charging at public sites: OCPI ChargingProfiles end to end against the CPO simulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingLocation, Tariff } from "../shared/ocpi/types";
import type { BookingRow, NetworkSnapshot, Partner, Vehicle } from "../shared/model";
import { suggestSlots } from "../shared/booking/slots";
import { planSession } from "../shared/energy/session";
import { harness, type Harness } from "./helpers";

const night: Tariff = { country_code: "GB", party_id: "VHL", id: "T", currency: "GBP", tax_included: "NO", last_updated: "2026-01-01T00:00:00Z",
  elements: [{ price_components: [{ type: "ENERGY", price: 0.45, step_size: 1 }], restrictions: { start_time: "22:00", end_time: "06:00" } }, { price_components: [{ type: "ENERGY", price: 0.59, step_size: 1 }] }] } as Tariff;

test("session plan: cheapest waits for the night rate and still finishes by the end of the booking", () => {
  const from = Date.parse("2026-10-29T21:00:00Z"), to = Date.parse("2026-10-29T23:00:00Z");
  const p = planSession({ mode: "cheapest", from, to, needBatteryKwh: 186, maxKw: 300, tariffs: [night], carbon: null });
  const periods = p.profile.charging_profile_period!;
  assert.equal(periods[0].start_period, 0);
  assert.equal(periods[0].limit, 0, "nothing before 22:00");
  assert.equal(periods[1].start_period, 3600);
  assert.ok(periods[1].limit > 0);
  assert.equal(p.shortKwh, 0);
  assert.ok(p.cost < p.baselineCost, "cheaper than charging straight away");
  assert.equal(p.profile.charging_rate_unit, "W");
  assert.equal(p.profile.duration, 7200);
});

test("session plan: a power cap charges as soon as possible within the cap", () => {
  const from = Date.parse("2026-10-29T12:00:00Z");
  const p = planSession({ mode: "cap", capKw: 100, from, to: from + 2 * 3_600_000, needBatteryKwh: 93, maxKw: 300, tariffs: [night], carbon: null });
  assert.equal(p.profile.charging_profile_period![0].limit, 100000);
  assert.ok(Math.abs(p.kwh - 100) < 0.5);
});

async function setup(h: Harness) {
  const r = await h.api("POST", "/api/admin/simulator/connect");
  assert.equal(r.status, 201, JSON.stringify(r.error));
  const net = (await h.api<NetworkSnapshot>("GET", "/api/network")).data;
  const vehicles = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  return { net, vehicles };
}

async function book(h: Harness, net: NetworkSnapshot, v: Vehicle, blId: string, desiredIso: string, minutes: number) {
  const bl = net.booking_locations.find((b) => b.id === blId)!.data as BookingLocation;
  const s = suggestSlots(bl, new Date(desiredIso), minutes, h.clock.now, { count: 1 })[0];
  assert.ok(s, "no slot");
  const r = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings`, {
    vehicle_id: v.id, cpo_country_code: bl.country_code, cpo_party_id: bl.party_id, booking_location_id: bl.id,
    start_at: s.start.toISOString(), end_at: s.end.toISOString(), power_required_kw: 300,
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  await h.ctx.flush();
  return (await h.store.getBooking(r.data.id))!;
}

test("set up before the charge, sent when it starts, confirmed by the charger, and the charger follows it", async () => {
  const h = await harness("2026-10-29T18:00:00Z");
  const { net, vehicles } = await setup(h);
  const truck = vehicles.find((v) => v.name === "Tractor 02")!; // Autocharge, MCS, 621 kWh
  const row = await book(h, net, truck, "VHL-DAV-MCS", "2026-10-29T21:00:00Z", 120);
  assert.equal(row.reservation_status, "RESERVED");

  const set = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings/${row.id}/smart-charging`, { mode: "cheapest", target_soc: 50 });
  assert.equal(set.status, 200, JSON.stringify(set.error));
  assert.equal(set.data.smart_charging?.status, "waiting");
  assert.ok(set.data.smart_charging?.estimate?.cost != null);

  h.clock.now = new Date(new Date(row.start_at).getTime() - 2 * 60_000);
  const ar = await h.api("POST", "/api/admin/simulator/action", { action: "arrive", booking_id: row.id });
  assert.equal(ar.status, 200, JSON.stringify(ar.error));
  await h.ctx.flush();
  await h.ctx.flush();
  let b = (await h.store.getBooking(row.id))!;
  assert.equal(b.session?.status, "ACTIVE");
  assert.equal(b.smart_charging?.status, "active", b.smart_charging?.message);
  const log = await h.store.listLogs({ limit: 200 });
  assert.ok(log.some((l) => l.direction === "OUT" && l.module === "chargingprofiles" && l.method === "PUT"), "profile PUT to the CPO");

  // Up to 50% fits in the night-rate hour (22:00–23:00) whatever the starting charge, so before
  // 22:00 the charger holds off and almost nothing flows in the first 45 minutes.
  h.clock.now = new Date(new Date(row.start_at).getTime() + 45 * 60_000);
  const fin = await h.api("POST", "/api/admin/simulator/action", { action: "finish", booking_id: row.id });
  assert.equal(fin.status, 200, JSON.stringify(fin.error));
  await h.ctx.flush();
  b = (await h.store.getBooking(row.id))!;
  assert.ok(b.cdr, "CDR received");
  assert.ok(b.cdr!.total_energy < 25, `held off before the night rate, got ${b.cdr!.total_energy} kWh`);
});

test("switching it off clears the profile at the operator", async () => {
  const h = await harness("2026-10-29T18:00:00Z");
  const { net, vehicles } = await setup(h);
  const truck = vehicles.find((v) => v.name === "Tractor 02")!;
  const row = await book(h, net, truck, "VHL-DAV-MCS", "2026-10-29T20:00:00Z", 120);
  h.clock.now = new Date(new Date(row.start_at).getTime() - 2 * 60_000);
  await h.api("POST", "/api/admin/simulator/action", { action: "arrive", booking_id: row.id });
  await h.ctx.flush();
  const on = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings/${row.id}/smart-charging`, { mode: "cap", cap_kw: 120 });
  assert.equal(on.data.smart_charging?.status, "sent");
  await h.ctx.flush();
  assert.equal((await h.store.getBooking(row.id))!.smart_charging?.status, "active");
  const off = await h.api<BookingRow>("DELETE", `/api/fleets/${h.fleetId}/bookings/${row.id}/smart-charging`);
  assert.equal(off.data.smart_charging?.status, "cleared");
  const log = await h.store.listLogs({ limit: 200 });
  assert.ok(log.some((l) => l.direction === "OUT" && l.module === "chargingprofiles" && l.method === "DELETE"));
});

test("operators that don't support it say so: NOT_SUPPORTED from Kestrel, no endpoint at all", async () => {
  const h = await harness("2026-10-29T09:00:00Z");
  const { net, vehicles } = await setup(h);
  const truck = vehicles.find((v) => v.name === "Tractor 02")!;
  const row = await book(h, net, truck, "KCH-LYM-CCS", "2026-10-29T09:30:00Z", 60);
  h.clock.now = new Date(new Date(row.start_at).getTime() - 2 * 60_000);
  await h.api("POST", "/api/admin/simulator/action", { action: "arrive", booking_id: row.id });
  await h.ctx.flush();
  const r = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings/${row.id}/smart-charging`, { mode: "greenest" });
  assert.equal(r.data.smart_charging?.status, "not_supported");

  // A partner whose endpoint list has no chargingprofiles module: we don't even try.
  const p = (await h.store.listPartners())[0] as Partner;
  await h.store.upsertPartner({ ...p, endpoints: p.endpoints.filter((e) => e.identifier !== "chargingprofiles") });
  const row2 = await book(h, net, vehicles.find((v) => v.name === "Rigid 03")!, "VHL-LUT-CCS", "2026-10-29T12:00:00Z", 60);
  const r2 = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings/${row2.id}/smart-charging`, { mode: "cheapest" });
  assert.equal(r2.data.smart_charging?.status, "not_supported");
  assert.match(r2.data.smart_charging!.message, /doesn't offer smart charging/);
});

test("our versions endpoint lists chargingprofiles as SENDER", async () => {
  const h = await harness();
  const { ourEndpoints } = await import("../server/ocpi/registration");
  assert.ok(ourEndpoints(h.ctx).some((e) => e.identifier === "chargingprofiles" && e.role === "SENDER"));
});
