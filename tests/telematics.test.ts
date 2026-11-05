// Battery levels from the trucks themselves: rFMS polling, the push API, and the depot plan using them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vehicle } from "../shared/model";
import { cleanEnergy, type DepotVisit } from "../shared/energy/depot";
import { cleanReading, cleanTelematics, mergeTelemetry, parseRfmsStatuses, socFromTruck, type Telemetry } from "../shared/energy/telematics";
import { runTelematics } from "../server/telematics";
import type { DepotPlanView } from "../server/depot";
import { dispatch } from "../server/dispatch";
import { fleetOverview } from "../src/app/kpis";
import { harness, type Harness } from "./helpers";

const VOLVO = "YV2RT40A0NB123456";
const MAN = "WMA06XZZ1NM654321";
const STRANGER = "YV2RT40A0NB999999";

/** One rFMS vehicle status, as Volvo Connect and MAN RIO send them. */
const status = (vin: string, at: string, snapshot: Record<string, unknown>) => ({ vin, createdDateTime: at, receivedDateTime: at, snapshotData: snapshot });

test("rFMS: battery, range, charging and position from v4 and v2.1 statuses; diesels skipped", () => {
  const got = parseRfmsStatuses({
    vehicleStatusResponse: {
      vehicleStatuses: [
        status(VOLVO, "2026-10-29T14:40:00Z", { hybridBatteryPackRemainingCharge: 41.26, estimatedDistanceToEmpty: { total: 182400, batteryPack: 180600 }, batteryPackChargingStatus: "CHARGING_AC", gnssPosition: { latitude: 52.2, longitude: -0.9 } }),
        status(VOLVO, "2026-10-29T14:10:00Z", { hybridBatteryPackRemainingCharge: 35 }),
        status(MAN, "2026-10-29T14:30:00Z", { batteryPackRemainingCharge: "77", estimatedDistanceToEmpty: 250000, batteryPackChargingConnectionStatus: "CONNECTED" }),
        status("XLRTE47MS0E123456", "2026-10-29T14:30:00Z", { fuelLevel1: 60 }), // diesel: no battery level
        status("YV2RT40A0NB000001", "not a date", { hybridBatteryPackRemainingCharge: 50 }),
      ],
    },
    moreDataAvailable: false,
  });
  const by = Object.fromEntries(got.map((g) => [g.vin, g.t]));
  assert.deepEqual(Object.keys(by).sort(), [VOLVO, MAN].sort());
  assert.deepEqual(by[VOLVO], { soc_pct: 41.3, at: "2026-10-29T14:40:00.000Z", source: "rfms", range_km: 181, charging: "charging", lat: 52.2, lon: -0.9 }, "the latest status wins; range in km");
  assert.equal(by[MAN].soc_pct, 77);
  assert.equal(by[MAN].range_km, 250);
  assert.equal(by[MAN].charging, "connected");
});

test("pushed readings are checked: 0–100%, not from the future, sensible range", () => {
  const now = new Date("2026-10-29T15:00:00Z");
  assert.deepEqual(cleanReading({ soc: "62.44", range_km: 210, charging: "idle", at: "2026-10-29T14:58:00Z" }, now), { soc_pct: 62.4, at: "2026-10-29T14:58:00.000Z", source: "api", range_km: 210, charging: "idle" });
  assert.equal(cleanReading({ soc_pct: 101 }, now), null);
  assert.equal(cleanReading({ soc_pct: -1 }, now), null);
  assert.equal(cleanReading({ soc_pct: 50, at: "2026-10-29T16:00:00Z" }, now), null, "an hour in the future");
  assert.equal(cleanReading({ soc_pct: 50, at: "yesterday-ish" }, now), null);
  const odd = cleanReading({ soc_pct: 50, range_km: 99999, charging: "flying", lat: 95, lon: 0 }, now)!;
  assert.deepEqual(odd, { soc_pct: 50, at: now.toISOString(), source: "api" }, "nonsense extras are dropped, the reading is kept");
});

test("the plan uses a truck's reading only when it is recent and the truck is here or nearly here", () => {
  const now = Date.parse("2026-10-29T15:00:00Z");
  const t: Telemetry = { soc_pct: 48, at: "2026-10-29T14:20:00Z", source: "rfms" };
  const visit = (arrive: string, status = "planned") => ({ arrive_at: arrive, status });
  assert.equal(socFromTruck(t, visit("2026-10-29T15:20:00Z"), now), t, "due in 20 minutes");
  assert.equal(socFromTruck(t, visit("2026-10-29T13:00:00Z"), now), t, "already arrived");
  assert.equal(socFromTruck(t, visit("2026-10-29T18:00:00Z"), now), null, "still on the road for hours: it will use more charge");
  assert.equal(socFromTruck(t, visit("2026-10-29T18:00:00Z", "plugged_in"), now), t, "plugged in early");
  assert.equal(socFromTruck({ ...t, at: "2026-10-29T11:00:00Z" }, visit("2026-10-29T15:20:00Z"), now), null, "four hours old");
  assert.equal(socFromTruck(undefined, visit("2026-10-29T15:20:00Z"), now), null);
  // Newer readings replace older ones, truck by truck.
  const merged = mergeTelemetry({ a: t, b: t }, { a: { ...t, soc_pct: 50, at: "2026-10-29T14:50:00Z" }, b: { ...t, soc_pct: 10, at: "2026-10-29T13:00:00Z" } });
  assert.equal(merged.a.soc_pct, 50);
  assert.equal(merged.b.soc_pct, 48);
});

test("settings are validated: https only, the /vehiclestatuses suffix trimmed, bad VINs dropped", () => {
  assert.deepEqual(cleanTelematics({ kind: "rfms", rfms: { base_url: "http://rfms.example.com" } }), { kind: "none" });
  const c = cleanTelematics({ kind: "rfms", rfms: { base_url: "https://rfms.example.com/rfms/vehiclestatuses/", auth: "oauth2", username: "client-1", token_url: "https://auth.example.com/token", vins: { v1: VOLVO.toLowerCase(), v2: "NOT-A-VIN", v3: "IOQ00000000000000" } } });
  assert.equal(c.kind, "rfms");
  assert.equal(c.rfms!.base_url, "https://rfms.example.com/rfms");
  assert.deepEqual(c.rfms!.vins, { v1: VOLVO });
  assert.equal(c.rfms!.token_url, "https://auth.example.com/token");
  assert.deepEqual(cleanTelematics({ kind: "simulated", rfms: { base_url: "https://x.example" } }), { kind: "simulated" });
  // Secrets are stored by depot id next to "flex" and "telematics", so depots can't take those ids.
  const d = cleanEnergy({ depots: [{ id: "telematics", name: "Yard" }, { id: "flex", name: "Hub" }, { id: "yard", name: "Main" }] }).depots;
  assert.notEqual(d[0].id, "telematics");
  assert.notEqual(d[1].id, "flex");
  assert.equal(d[2].id, "yard");
});

/** A depot with two chargers, and the fleet's vehicles. */
async function depotFleet(h: Harness) {
  const vehicles = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data;
  const put = await h.api("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { depots: [{ id: "yard", name: "Yard", import_limit_kw: 400, site_load_kw: 50, tariff: { kind: "tou", standard: 0.25, rates: [{ price: 0.12, start: "00:30", end: "07:30" }] }, chargers: [{ id: "b1", name: "Bay 1", max_kw: 150 }, { id: "b2", name: "Bay 2", max_kw: 150 }] }] } });
  assert.equal(put.status, 200);
  return vehicles;
}

test("API: readings pushed by plate, VIN or id; the depot plan uses them instead of the typed-in charge", async () => {
  const h = await harness("2026-10-29T15:00:00Z");
  const vehicles = await depotFleet(h);
  const [a, b, c] = vehicles.filter((v) => v.active);
  // Link one truck's VIN through the rFMS settings.
  const rfms = { kind: "rfms", rfms: { base_url: "https://rfms.example.com/rfms", auth: "basic", username: "fleet", vins: { [c.id]: VOLVO } } };
  const energy = (await h.api<{ config: object }>("GET", `/api/fleets/${h.fleetId}/energy`)).data.config;
  assert.equal((await h.api("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { ...energy, telematics: rfms } })).status, 200);

  const visit = await h.api<DepotVisit>("POST", `/api/fleets/${h.fleetId}/depot-visits`, { depot_id: "yard", vehicle_id: a.id, charger_id: "b1", arrive_at: "2026-10-29T15:20:00Z", depart_at: "2026-10-30T05:00:00Z", soc_start: 20, soc_target: 90 });
  assert.equal(visit.status, 201);
  const later = await h.api<DepotVisit>("POST", `/api/fleets/${h.fleetId}/depot-visits`, { depot_id: "yard", vehicle_id: b.id, charger_id: "b2", arrive_at: "2026-10-29T19:00:00Z", depart_at: "2026-10-30T05:00:00Z", soc_start: 30, soc_target: 90 });
  const plan = async () => (await h.api<DepotPlanView>("GET", `/api/fleets/${h.fleetId}/depots/yard/plan`)).data;
  const before = await plan();
  const need = (p: DepotPlanView, id: string) => p.visits.find((x) => x.visit.id === id)!;
  assert.ok(!need(before, visit.data.id).soc_from);

  const sent = await h.api<{ accepted: number; rejected: { index: number; reason: string }[] }>("POST", `/api/fleets/${h.fleetId}/telemetry`, {
    readings: [
      { plate: a.plate.toLowerCase().replace(/\s/g, ""), soc_pct: 55, range_km: 160, at: "2026-10-29T14:55:00Z" },
      { vehicle_id: b.id, soc_pct: 70, at: "2026-10-29T14:50:00Z" },
      { vin: VOLVO, soc_pct: 12, charging: "idle" },
      { plate: "NOPE 123", soc_pct: 40 },
      { vehicle_id: a.id, soc_pct: 140 },
    ],
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.accepted, 3);
  assert.deepEqual(sent.data.rejected.map((r) => r.index), [3, 4]);
  const stored = (await h.api<Record<string, Telemetry>>("GET", `/api/fleets/${h.fleetId}/telemetry`)).data;
  assert.equal(stored[a.id].soc_pct, 55);
  assert.equal(stored[c.id].soc_pct, 12);
  assert.equal(stored[c.id].at, "2026-10-29T15:00:00.000Z", "no time sent: now");

  const after = await plan();
  const arriving = need(after, visit.data.id);
  assert.equal(arriving.soc_from?.soc_pct, 55, "due in 20 minutes: the truck's own reading");
  assert.ok(arriving.need_kwh < need(before, visit.data.id).need_kwh, "55% needs less than the typed-in 20%");
  assert.ok(!need(after, later.data.id).soc_from, "due at 19:00: still the typed-in figure");

  // An older reading never replaces a newer one.
  await h.api("POST", `/api/fleets/${h.fleetId}/telemetry`, { readings: [{ vehicle_id: a.id, soc_pct: 10, at: "2026-10-29T13:00:00Z" }] });
  assert.equal((await h.api<Record<string, Telemetry>>("GET", `/api/fleets/${h.fleetId}/telemetry`)).data[a.id].soc_pct, 55);
  assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/telemetry`, { readings: [] })).status, 400);
  assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/telemetry`, { readings: [{ plate: "NOPE", soc_pct: 1 }] })).status, 400, "nothing accepted");
});

test("API: a planning system sends each trip with its own id, and again when times change", async () => {
  const h = await harness("2026-10-29T15:00:00Z");
  const vehicles = await depotFleet(h);
  const trip = "5B0E7C1E-2F4A-4C11-9E59-0D3A3B1F2A77";
  const send = (depart: string) => h.api<DepotVisit>("PUT", `/api/fleets/${h.fleetId}/depot-visits/${trip}`, { depot_id: "yard", vehicle_id: vehicles[0].id, arrive_at: "2026-10-29T17:30:00Z", depart_at: depart, soc_start: 25, soc_target: 90 });
  const first = await send("2026-10-30T05:00:00Z");
  assert.equal(first.status, 201);
  assert.equal(first.data.id, trip.toLowerCase());
  const again = await send("2026-10-30T06:30:00Z");
  assert.equal(again.status, 200);
  assert.equal(again.data.depart_at, "2026-10-30T06:30:00.000Z");
  const list = (await h.api<DepotVisit[]>("GET", `/api/fleets/${h.fleetId}/depot-visits`)).data;
  assert.equal(list.filter((v) => v.id === trip.toLowerCase()).length, 1, "updated, not duplicated");
  assert.equal((await h.api("PUT", `/api/fleets/${h.fleetId}/depot-visits/trip-42`, { depot_id: "yard" })).status, 404, "ids must be UUIDs");

  // Another fleet's visit id: never overwritten, never revealed.
  const other = await h.api<{ id: string }>("POST", "/api/fleets", { name: "Other Haulage", sample: true, accept_terms: true });
  const theirs = (await h.api<Vehicle[]>("GET", `/api/fleets/${other.data.id}/vehicles`)).data[0];
  await h.api("PUT", `/api/fleets/${other.data.id}/energy`, { config: { depots: [{ id: "yard", name: "Yard", chargers: [{ id: "b1", name: "Bay 1", max_kw: 150 }] }] } });
  const clash = await h.api("PUT", `/api/fleets/${other.data.id}/depot-visits/${trip}`, { depot_id: "yard", vehicle_id: theirs.id, arrive_at: "2026-10-29T17:30:00Z", depart_at: "2026-10-30T05:00:00Z", soc_start: 25, soc_target: 90 });
  assert.equal(clash.status, 409);
  assert.equal((await h.api("PATCH", `/api/fleets/${other.data.id}/depot-visits/${trip}`, { soc_target: 50 })).status, 404);
  assert.equal(h.store.data.depotVisits!.find((v) => v.id === trip.toLowerCase())!.fleet_id, h.fleetId);
});

/** A fake rFMS server: two pages, Basic sign-in, v4 media type. */
function fakeRfms(h: Harness, opts: { v21Only?: boolean; foreignNext?: boolean } = {}) {
  const calls: { url: string; auth: string | null; accept: string | null }[] = [];
  const inner = h.ctx.transport.bind(h.ctx);
  h.ctx.transport = async (req) => {
    if (!req.url.startsWith("https://rfms.example.com/") && !req.url.startsWith("https://elsewhere.example/")) return inner(req);
    calls.push({ url: req.url, auth: req.headers.get("Authorization"), accept: req.headers.get("Accept") });
    if (req.headers.get("Authorization") !== `Basic ${btoa("fleet:rfms-pass")}`) return new Response("", { status: 401 });
    if (opts.v21Only && !req.headers.get("Accept")!.includes("v2.1")) return new Response("", { status: 406 });
    const second = new URL(req.url).searchParams.has("lastVin");
    const body = second
      ? { vehicleStatusResponse: { vehicleStatuses: [status(STRANGER, "2026-10-29T14:45:00Z", { hybridBatteryPackRemainingCharge: 90 })] }, moreDataAvailable: false }
      : { vehicleStatusResponse: { vehicleStatuses: [status(VOLVO, "2026-10-29T14:40:00Z", { hybridBatteryPackRemainingCharge: 33, estimatedDistanceToEmpty: 99000 })] }, moreDataAvailable: true, moreDataAvailableLink: opts.foreignNext ? "https://elsewhere.example/rfms/vehiclestatuses?lastVin=X" : `/rfms/vehiclestatuses?latestOnly=true&lastVin=${VOLVO}` };
    return Response.json(body);
  };
  return calls;
}

test("rFMS: the password is sealed, polled with paging, unknown VINs listed for set-up; cron stores readings", async () => {
  const h = await harness("2026-10-29T15:00:00Z");
  h.ctx.env.DATA_ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).map((_, i) => i * 7)).toString("base64");
  const vehicles = await depotFleet(h);
  const energy = (await h.api<{ config: object }>("GET", `/api/fleets/${h.fleetId}/energy`)).data.config;
  const telematics = { kind: "rfms", rfms: { base_url: "https://rfms.example.com/rfms", auth: "basic", username: "fleet", vins: { [vehicles[0].id]: VOLVO } } };
  const put = await h.api<{ config: { telematics: { rfms: { secret_hint?: string } } }; has_secret: Record<string, boolean> }>("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { ...energy, telematics }, secrets: { telematics: "rfms-pass" } });
  assert.equal(put.status, 200);
  assert.equal(put.data.has_secret.telematics, true);
  assert.ok(put.data.config.telematics.rfms.secret_hint);
  assert.ok(!JSON.stringify(h.store.data.energy).includes("rfms-pass"), "stored sealed");

  const calls = fakeRfms(h);
  const test1 = await h.api<{ trucks: number; unmatched: string[] }>("POST", `/api/fleets/${h.fleetId}/telematics/test`);
  assert.equal(test1.status, 200, JSON.stringify(test1.error));
  assert.deepEqual(test1.data, { trucks: 1, unmatched: [STRANGER] });
  assert.equal(calls.length, 2, "followed the next page");
  assert.equal(calls[0].url, "https://rfms.example.com/rfms/vehiclestatuses?latestOnly=true&contentFilter=SNAPSHOT");
  assert.equal(calls[0].accept, "application/json; rfms=vehiclestatuses.v4.0");
  const tel = (await h.api<Record<string, Telemetry>>("GET", `/api/fleets/${h.fleetId}/telemetry`)).data;
  assert.deepEqual(tel[vehicles[0].id], { soc_pct: 33, at: "2026-10-29T14:40:00.000Z", source: "rfms", range_km: 99 });

  // Older makers' servers only speak rFMS 2.1; the cron job polls every fleet set up for rFMS.
  h.clock.now = new Date("2026-10-29T15:15:00Z");
  const old = fakeRfms(h, { v21Only: true });
  assert.equal(await runTelematics(h.ctx), 1);
  assert.match(old[1].accept!, /vehiclestatuses\.v2\.1/);

  // A next-page link to another server is not followed: the sign-in stays with the rFMS server.
  const foreign = fakeRfms(h, { foreignNext: true });
  await h.api("POST", `/api/fleets/${h.fleetId}/telematics/test`);
  assert.ok(foreign.every((c) => c.url.startsWith("https://rfms.example.com/")));

  // Moving to another host needs the password again; the same host keeps it.
  const cfg = (await h.api<{ config: object }>("GET", `/api/fleets/${h.fleetId}/energy`)).data.config;
  const samePath = await h.api<{ has_secret: Record<string, boolean> }>("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { ...cfg, telematics: { ...telematics, rfms: { ...telematics.rfms, base_url: "https://rfms.example.com/rfms/v4" } } } });
  assert.equal(samePath.data.has_secret.telematics, true);
  const moved = await h.api<{ has_secret: Record<string, boolean> }>("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { ...cfg, telematics: { ...telematics, rfms: { ...telematics.rfms, base_url: "https://evil.example.net/rfms" } } } });
  assert.equal(moved.data.has_secret.telematics ?? false, false);
  assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/telematics/test`)).status, 502, "no password: a clear error");

  // Wrong password: a clear error, not a crash.
  await h.api("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { ...cfg, telematics }, secrets: { telematics: "wrong" } });
  fakeRfms(h);
  const bad = await h.api("POST", `/api/fleets/${h.fleetId}/telematics/test`);
  assert.equal(bad.status, 502);
  assert.match(bad.error!.message, /didn't accept/);
});

test("API keys can push readings; only owners can test the rFMS connection", async () => {
  const h = await harness("2026-10-29T15:00:00Z");
  const vehicles = await depotFleet(h);
  const { data: created } = await h.api<{ key: string }>("POST", `/api/fleets/${h.fleetId}/api-keys`, { name: "Telematics gateway", role: "planner" });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await dispatch(new Request(h.ctx.baseUrl + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.key}` }, body: body === undefined ? undefined : JSON.stringify(body) }), h.ctx);
    return res.status;
  };
  assert.equal(await call("POST", `/api/fleets/${h.fleetId}/telemetry`, { readings: [{ plate: vehicles[0].plate, soc_pct: 64 }] }), 200);
  assert.equal(await call("GET", `/api/fleets/${h.fleetId}/telemetry`), 200);
  assert.equal(await call("POST", `/api/fleets/${h.fleetId}/telematics/test`), 403);
});

test("dashboard: the truck's own reading shows when it is newer than the last charge", () => {
  const now = new Date("2026-10-29T15:00:00Z");
  const v = { id: "v1", name: "Tractor 01", active: true, plate: "PN74 EVA", vehicle_type: "TRUCK_WITH_TRAILER" } as Vehicle;
  const [t] = fleetOverview([v], [], now, () => null, { v1: { soc_pct: 58, range_km: 190, at: "2026-10-29T14:50:00Z", source: "rfms" } });
  assert.equal(t.battery?.soc, 58);
  assert.equal(t.battery?.fromTruck, true);
  assert.equal(t.battery?.rangeKm, 190);
});
