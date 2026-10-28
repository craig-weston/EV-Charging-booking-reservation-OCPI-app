// Rebooking after an operator cancels: nearest free bay at a similar time, never the cancelled one.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingRow, NetworkSnapshot, Vehicle } from "../shared/model";
import { assess } from "../shared/booking/compat";
import { bookingBody, describeShift, rebookOptions } from "../src/app/rebook";
import { harness } from "./helpers";

test("rebook: up to three nearby sites, close to the original time, excluding the cancelled bay", async () => {
  const h = await harness("2026-10-28T08:00:00Z");
  await h.api("POST", "/api/admin/simulator/connect");
  const net = (await h.api<NetworkSnapshot>("GET", "/api/network")).data;
  const vehicles = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  const v = vehicles[0];
  const target = net.booking_locations.find((o) => assess(v, o.data, net.locations.find((l) => l.id === o.data.location_id && l.party_id === o.party_id)?.data).ok)!;
  assert.ok(target, "a bay the truck fits");
  const start = new Date("2026-10-28T11:00:00Z");
  const cancelled = {
    id: "b1", fleet_id: h.fleetId, vehicle_id: v.id, driver_id: null, cpo_country_code: target.country_code, cpo_party_id: target.party_id,
    location_id: target.data.location_id, booking_location_id: target.data.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + 45 * 60_000).toISOString(),
    power_required_kw: null, authorization_reference: "AUTH1", reservation_status: "CANCELED", plate: v.plate,
  } as unknown as BookingRow;
  const now = new Date("2026-10-28T08:00:00Z");
  const opts = rebookOptions(net, cancelled, v, now);
  assert.ok(opts.length > 0 && opts.length <= 3, `got ${opts.length}`);
  assert.equal(new Set(opts.map((o) => o.site.key)).size, opts.length, "one per site");
  for (const o of opts) {
    assert.ok(!(o.option.bl.id === target.data.id && o.option.bl.party_id === target.party_id), "not the cancelled bay");
    assert.ok(o.option.assessment.ok, "the truck fits");
    assert.ok(Math.abs(o.shiftMin) <= 180, `within 3 hours (${o.shiftMin})`);
    assert.equal(Math.round((o.slot.end.getTime() - o.slot.start.getTime()) / 60_000), 45, "same length");
  }
  const body = bookingBody(opts[0], cancelled);
  assert.equal(body.vehicle_id, v.id);
  assert.equal(body.booking_location_id, opts[0].option.bl.id);
  assert.match(body.notes, /AUTH1/);
  // The suggestion books through the normal API.
  const r = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings`, body);
  assert.equal(r.status, 201, r.error?.message);

  // A slot that has already started moves to at least 15 minutes from now.
  const late = rebookOptions(net, cancelled, v, new Date("2026-10-28T11:30:00Z"));
  for (const o of late) assert.ok(o.slot.start.getTime() >= Date.parse("2026-10-28T11:45:00Z"));
  assert.deepEqual(rebookOptions(null, cancelled, v, now), []);
});

test("describeShift", () => {
  assert.equal(describeShift(0), "same time");
  assert.equal(describeShift(30), "30 min later");
  assert.equal(describeShift(-90), "1 h 30 min earlier");
  assert.equal(describeShift(120), "2 h later");
});
