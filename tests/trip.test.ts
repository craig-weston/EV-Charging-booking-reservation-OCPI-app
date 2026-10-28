// Trip planning: charging stops along a long route, each with a bookable slot.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingRow, NetworkSnapshot, Vehicle } from "../shared/model";
import { CITIES } from "../src/map/ukmap";
import { MAX_DRIVE_MIN, planTrip } from "../src/app/trip";
import { harness } from "./helpers";

const city = (n: string) => CITIES.find((c) => c.name === n)!;

async function setup() {
  const h = await harness("2026-10-28T06:00:00Z");
  await h.api("POST", "/api/admin/simulator/connect");
  const net = (await h.api<NetworkSnapshot>("GET", "/api/network")).data;
  const vehicles = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  const tractor = vehicles.find((v) => v.vehicle_type === "TRUCK_WITH_TRAILER" || v.vehicle_type === "SEMI_TRACTOR")!;
  return { h, net, tractor };
}

test("London to Glasgow: stops in order, within range and drivers' hours, each with a slot", async () => {
  const { h, net, tractor } = await setup();
  const now = new Date("2026-10-28T06:00:00Z");
  const plan = planTrip({ net, vehicle: tractor, from: city("London"), to: city("Glasgow"), depart: new Date("2026-10-29T05:00:00Z"), now, startSoc: 0.9 });
  assert.equal(plan.ok, true, plan.problem ?? "");
  assert.ok(plan.stops.length >= 1, "needs at least one charge");
  let last = new Date("2026-10-29T05:00:00Z").getTime();
  for (const s of plan.stops) {
    assert.ok(s.socArrive >= 0.1 - 1e-9, `arrives with ${s.socArrive}`);
    assert.ok(s.socLeave > s.socArrive);
    assert.ok(s.slot.start.getTime() >= s.arriveAt.getTime(), "slot not before arrival");
    assert.ok(s.slot.start.getTime() >= last, "in time order");
    assert.ok((s.legKm / plan.assumptions.speedKmh) * 60 <= MAX_DRIVE_MIN + 1, "drivers' hours");
    assert.ok(s.assessment.ok);
    last = s.slot.end.getTime();
  }
  assert.ok(plan.arriveAt.getTime() > last);
  assert.ok(plan.arriveSoc >= 0.15 - 1e-9);
  assert.ok(plan.totalKm > 600 && plan.totalKm < 760, String(plan.totalKm));

  // Every stop books through the normal API.
  for (const s of plan.stops) {
    const r = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings`, {
      vehicle_id: tractor.id, cpo_country_code: s.bl.country_code, cpo_party_id: s.bl.party_id, booking_location_id: s.bl.id,
      start_at: s.slot.start.toISOString(), end_at: s.slot.end.toISOString(),
    });
    assert.equal(r.status, 201, r.error?.message);
  }
});

test("a short trip needs no stops; an impossible one says why", async () => {
  const { net, tractor } = await setup();
  const now = new Date("2026-10-28T06:00:00Z");
  const short = planTrip({ net, vehicle: tractor, from: city("Northampton"), to: city("Daventry"), depart: now, now, startSoc: 0.8 });
  assert.equal(short.ok, true);
  assert.equal(short.stops.length, 0);
  const flat = planTrip({ net, vehicle: tractor, from: city("Plymouth"), to: city("Inverness"), depart: now, now, startSoc: 0.12 });
  assert.equal(flat.ok, false);
  assert.match(flat.problem!, /No bookable stop/);
});
