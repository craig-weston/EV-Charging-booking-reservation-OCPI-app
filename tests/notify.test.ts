// Automatic driver messages: when they go out, what they say, and that nothing is sent twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingEvent, BookingRow, Driver, Fleet, NetworkSnapshot, Vehicle } from "../shared/model";
import { suggestSlots } from "../shared/booking/slots";
import { planNotification, toE164 } from "../server/notify";
import { harness, type Harness } from "./helpers";

test("UK phone numbers normalise to E.164", () => {
  assert.equal(toE164("07700 900123"), "+447700900123");
  assert.equal(toE164("+44 (0)7700 900123"), "+447700900123");
  assert.equal(toE164("0044 7700-900123"), "+447700900123");
  assert.equal(toE164("+353 87 123 4567"), "+353871234567");
  assert.equal(toE164("7700"), null);
  assert.equal(toE164(""), null);
  assert.equal(toE164("call the desk"), null);
});

test("planNotification: confirm once, change, then cancel only if told", () => {
  const base = { reservation_status: "RESERVED", driver_id: "d1", start_at: "2026-10-22T10:00:00Z", end_at: "2026-10-22T11:00:00Z", pass_token: "tok", driver_notified: null } as unknown as BookingRow;
  const first = planNotification(base)!;
  assert.equal(first.kind, "booked");
  assert.equal(planNotification({ ...base, driver_notified: first.sig }), null, "same state → nothing");
  assert.equal(planNotification({ ...base, driver_notified: first.sig, start_at: "2026-10-22T10:30:00Z" })!.kind, "changed");
  assert.equal(planNotification({ ...base, driver_notified: first.sig, driver_id: "d2" })!.kind, "booked", "new driver gets a fresh confirmation");
  assert.deepEqual(planNotification({ ...base, reservation_status: "CANCELED", driver_notified: first.sig }), { kind: "cancelled", driverId: "d1", sig: "C" });
  assert.equal(planNotification({ ...base, reservation_status: "CANCELED" }), null, "never told → no cancellation");
  assert.equal(planNotification({ ...base, driver_id: null }), null);
  assert.equal(planNotification({ ...base, reservation_status: "PENDING" }), null);
});

async function setup(live: boolean) {
  const h = await harness();
  const sent: URLSearchParams[] = [];
  const c = await h.api("POST", "/api/admin/simulator/connect");
  assert.equal(c.status, 201);
  if (live) {
    // Live mode with Twilio configured; capture what would go to Twilio instead of sending it.
    h.ctx.mode = "live";
    Object.assign(h.ctx.env, { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "secret", TWILIO_FROM: "+447700900000" });
    const inner = h.ctx.transport.bind(h.ctx);
    h.ctx.transport = async (req) => {
      if (new URL(req.url).hostname === "api.twilio.com") {
        assert.equal(req.headers.get("Authorization"), "Basic " + btoa("AC123:secret"));
        sent.push(new URLSearchParams(await req.text()));
        return Response.json({ sid: `SM${sent.length}` }, { status: 201 });
      }
      return inner(req);
    };
  }
  const fleet = await h.api<Fleet>("PATCH", `/api/fleets/${h.fleetId}`, { notify_drivers: "sms" });
  assert.equal(fleet.status, 200, JSON.stringify(fleet.error));
  assert.equal(fleet.data.notify_drivers, "sms");
  const net = (await h.api<NetworkSnapshot>("GET", "/api/network")).data;
  const bl = net.booking_locations.find((b) => b.id === "VHL-LUT-CCS")!.data;
  const [vehicle] = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  const drivers = (await h.api<Driver[]>("GET", `/api/fleets/${h.fleetId}/drivers`)).data;
  return { h, sent, bl, vehicle, drivers };
}

async function book(h: Harness, s: Awaited<ReturnType<typeof setup>>, driverId: string | null) {
  const slot = suggestSlots(s.bl, new Date("2026-10-21T13:00:00Z"), 60, h.clock.now, { count: 1 })[0];
  const r = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings`, {
    vehicle_id: s.vehicle.id, driver_id: driverId, cpo_country_code: s.bl.country_code, cpo_party_id: s.bl.party_id,
    booking_location_id: s.bl.id, start_at: slot.start.toISOString(), end_at: slot.end.toISOString(),
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  await h.ctx.flush();
  return (await h.store.getBooking(r.data.id))!;
}

const events = async (h: Harness, id: string): Promise<BookingEvent[]> => (await h.store.listEvents(h.fleetId, { limit: 500 })).filter((e) => e.booking_id === id);

test("live: text on confirmation, change and cancellation, never twice", async () => {
  const s = await setup(true);
  const { h, sent } = s;
  const driver = s.drivers.find((d) => d.phone)!;
  const row = await book(h, s, driver.id);
  assert.equal(row.reservation_status, "RESERVED");
  assert.equal(sent.length, 1, "one text on confirmation");
  assert.equal(sent[0].get("To"), toE164(driver.phone));
  assert.equal(sent[0].get("From"), "+447700900000");
  assert.match(sent[0].get("Body")!, /^Charging booked: .+ for .+\. Just drive in and plug in\. Details: .+#\/pass\//);
  assert.ok(sent[0].get("Body")!.includes(row.pass_token));

  // A repeated push of the same booking from the operator doesn't send again.
  const { notifyDriver } = await import("../server/notify");
  await notifyDriver(h.ctx, row.id);
  assert.equal(sent.length, 1);

  // Change the time → "changed".
  const newStart = new Date(new Date(row.start_at).getTime() + 30 * 60_000);
  const ch = await h.api("POST", `/api/fleets/${h.fleetId}/bookings/${row.id}/change`, { start_at: newStart.toISOString(), end_at: new Date(newStart.getTime() + 60 * 60_000).toISOString() });
  assert.equal(ch.status, 200, JSON.stringify(ch.error));
  await h.ctx.flush();
  assert.equal(sent.length, 2);
  assert.match(sent[1].get("Body")!, /^Charging booking changed: /);

  // Cancel → the driver is told not to go.
  const c = await h.api("POST", `/api/fleets/${h.fleetId}/bookings/${row.id}/cancel`, { reason: "TRAFFIC" });
  assert.equal(c.status, 200, JSON.stringify(c.error));
  await h.ctx.flush();
  assert.equal(sent.length, 3);
  assert.match(sent[2].get("Body")!, /^Charging booking cancelled: .+Don't go to this site/);
  assert.equal(sent[2].get("Body")!.includes("#/pass/"), false, "no live link in a cancellation");

  const ev = await events(h, row.id);
  assert.equal(ev.filter((e) => e.kind === "NOTE" && /^Text sent to /.test(e.message)).length, 3);
  assert.ok(ev.every((e) => !e.message.includes(toE164(driver.phone)!)), "timeline masks the number");
});

test("live: assigning a driver later sends the pass; a failure is recorded, not thrown", async () => {
  const s = await setup(true);
  const { h, sent } = s;
  const row = await book(h, s, null);
  assert.equal(sent.length, 0, "no driver → nothing to send");
  const driver = s.drivers.find((d) => d.phone)!;
  const p = await h.api("PATCH", `/api/fleets/${h.fleetId}/bookings/${row.id}`, { driver_id: driver.id });
  assert.equal(p.status, 200);
  await h.ctx.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].get("Body")!, /^Charging booked: /);

  // Twilio rejects the next one: the booking timeline says so.
  h.ctx.transport = async () => Response.json({ message: "The 'To' number is not a valid phone number.", code: 21211 }, { status: 400 });
  const r = await h.api("POST", `/api/fleets/${h.fleetId}/bookings/${row.id}/pass`);
  assert.equal(r.status, 200);
  await h.ctx.flush();
  const ev = await events(h, row.id);
  assert.ok(ev.some((e) => /^Text to .+ failed: The 'To' number is not a valid phone number\. \(21211\)/.test(e.message)));
});

test("can't turn messages on without Twilio; demo mode records instead of sending", async () => {
  const h = await harness();
  h.ctx.mode = "live";
  const r = await h.api("PATCH", `/api/fleets/${h.fleetId}`, { notify_drivers: "whatsapp" });
  assert.equal(r.status, 400);
  const cfg = (await h.api<{ notifications: { sms: boolean; whatsapp: boolean } }>("GET", "/api/config")).data;
  assert.deepEqual(cfg.notifications, { sms: false, whatsapp: false });

  const s = await setup(false); // demo mode
  const driver = s.drivers.find((d) => d.phone)!;
  const row = await book(s.h, s, driver.id);
  const ev = await events(s.h, row.id);
  assert.ok(ev.some((e) => /^Text to .+ \(demo, not actually sent\): Charging booked: /.test(e.message)));
});
