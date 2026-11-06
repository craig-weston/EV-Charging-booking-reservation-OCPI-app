// The plan reaching the chargers, and what they say back: answers, status messages and faults,
// from simulated chargers, CitrineOS or a depot operator's own system.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DepotDispatch, Vehicle } from "../shared/model";
import type { DepotVisit } from "../shared/energy/depot";
import { checkProfile, chargerNow, parseFrame, stationReports, type ChargerNow } from "../shared/energy/chargers";
import { SIM_FAULT_AFTER_MS } from "../server/chargers";
import type { DepotPlanView } from "../server/depot";
import { harness, type Harness } from "./helpers";

type Plan = DepotPlanView & { dispatch: DepotDispatch | null; chargers: Record<string, ChargerNow> };
const NOW = "2026-10-29T15:00:00Z";
const later = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString();

test("station messages: OCPP 2.x and 1.6 status, problems raised and cleared", () => {
  const now = new Date(NOW);
  const f = parseFrame(JSON.stringify([2, "m1", "StatusNotification", { timestamp: "2026-10-29T14:59:00Z", connectorStatus: "Faulted", evseId: 2, connectorId: 1 }]))!;
  assert.equal(f.action, "StatusNotification");
  assert.deepEqual(stationReports(f.action!, f.payload, now), [{ evse: 2, at: "2026-10-29T14:59:00Z", status: "faulted" }]);
  // OCPP 1.6: the error code in plain words.
  assert.deepEqual(stationReports("StatusNotification", { connectorId: 1, status: "Faulted", errorCode: "GroundFailure", info: "RCD", timestamp: "2026-10-29T14:58:00Z" }, now),
    [{ evse: 1, at: "2026-10-29T14:58:00Z", status: "faulted", problem: { active: true, text: "Earth fault: RCD" } }]);
  assert.deepEqual(stationReports("StatusNotification", { connectorId: 1, status: "Charging", errorCode: "NoError" }, now)[0].problem, { active: false });
  // NotifyEvent: a problem raised, then cleared; availability.
  const raised = stationReports("NotifyEvent", { generatedAt: NOW, eventData: [{ timestamp: NOW, actualValue: "true", techInfo: "Insulation fault", component: { name: "EVSE", evse: { id: 1 } }, variable: { name: "Problem" } }] }, now);
  assert.deepEqual(raised, [{ evse: 1, at: "2026-10-29T15:00:00Z", problem: { active: true, text: "Insulation fault" } }]);
  assert.equal(stationReports("NotifyEvent", { eventData: [{ timestamp: NOW, actualValue: "true", cleared: true, component: { name: "EVSE" }, variable: { name: "Problem" } }] }, now)[0].problem!.active, false);
  assert.equal(stationReports("NotifyEvent", { eventData: [{ timestamp: NOW, actualValue: "Unavailable", component: { name: "Connector" }, variable: { name: "AvailabilityState" } }] }, now)[0].status, "unavailable");
  // A station clock in the future is pulled back to now; other messages are ignored.
  assert.equal(stationReports("StatusNotification", { timestamp: "2027-01-01T00:00:00Z", connectorStatus: "Available", evseId: 1 }, now)[0].at, "2026-10-29T15:01:00Z");
  assert.deepEqual(stationReports("Heartbeat", {}, now), []);
  assert.equal(parseFrame("not json"), null);
  assert.equal(parseFrame([3, "m2", { status: "Accepted" }])!.type, 3);
});

test("a charger's state now: the newest report wins, and a fault holds until it's cleared", () => {
  const faulted = chargerNow({ problem: { active: true, text: "Insulation fault", at: "2026-10-29T14:00:00Z" }, status: { state: "faulted", at: "2026-10-29T14:00:00Z" } });
  assert.equal(faulted.state, "faulted");
  assert.equal(faulted.fault, "Insulation fault");
  // The station says the connector is usable again, after the problem: no longer faulted.
  assert.equal(chargerNow({ problem: { active: true, text: "x", at: "2026-10-29T14:00:00Z" }, status: { state: "available", at: "2026-10-29T14:30:00Z" } }).state, "available");
  assert.equal(chargerNow({ status: { state: "faulted", at: NOW } }).fault, "The charger reported a fault");
  assert.equal(chargerNow({ status: { state: "occupied", at: "2026-10-29T14:00:00Z" } }, { online: false, at: NOW }).state, "offline");
  assert.equal(chargerNow({ status: { state: "unavailable", at: NOW } }).fault, "Taken out of service");
  assert.equal(chargerNow({}).state, null);
});

test("simulated chargers check a plan like real ones", () => {
  const request = (periods: object[], unit = "W") => ({ evseId: 1, chargingProfile: { id: 7001, stackLevel: 1, chargingProfilePurpose: "TxDefaultProfile", chargingProfileKind: "Absolute", chargingSchedule: [{ id: 7001, duration: 3600, chargingRateUnit: unit, chargingSchedulePeriod: periods }] } });
  assert.equal(checkProfile(request([{ startPeriod: 0, limit: 150000 }, { startPeriod: 1800, limit: 0 }]), 150000).status, "Accepted");
  assert.deepEqual(checkProfile(request([{ startPeriod: 0, limit: 200000 }]), 150000), { status: "Rejected", reason: "LimitTooHigh" });
  assert.deepEqual(checkProfile(request([{ startPeriod: 0, limit: 1 }, { startPeriod: 0, limit: 2 }]), 150000), { status: "Rejected", reason: "InvalidSchedule" });
  assert.deepEqual(checkProfile(request([{ startPeriod: 0, limit: 1 }], "kW"), 150000), { status: "Rejected", reason: "UnsupportedRateUnit" });
});

/** A depot with three chargers and two trucks staying tonight. */
async function depot(h: Harness, control: object) {
  const vehicles = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data.filter((v) => v.active);
  const chargers = [1, 2, 3].map((n) => ({ id: `bay-${n}`, name: `Bay ${n}`, station_id: n < 3 ? "CP-A" : "CP-B", evse_id: n < 3 ? n : 1, max_kw: 150 }));
  const put = await h.api("PUT", `/api/fleets/${h.fleetId}/energy`, { config: { depots: [{ id: "yard", name: "Yard", import_limit_kw: 400, site_load_kw: 50, tariff: { kind: "tou", standard: 0.25, rates: [{ price: 0.12, start: "00:30", end: "07:30" }] }, chargers, control }] } });
  assert.equal(put.status, 200, JSON.stringify(put.error));
  const stay = (vehicle: Vehicle, charger: string) => h.api<DepotVisit>("POST", `/api/fleets/${h.fleetId}/depot-visits`, { depot_id: "yard", vehicle_id: vehicle.id, charger_id: charger, arrive_at: later(20), depart_at: "2026-10-30T05:00:00Z", soc_start: 20, soc_target: 90 });
  const a = (await stay(vehicles[0], "bay-1")).data;
  const b = (await stay(vehicles[1], "bay-2")).data;
  return { a, b, vehicles };
}
const plan = async (h: Harness) => (await h.api<Plan>("GET", `/api/fleets/${h.fleetId}/depots/yard/plan`)).data;

test("simulator: the plan is accepted, then the chosen charger reports a fault and the plan works around it", async () => {
  const h = await harness(NOW);
  const { b } = await depot(h, { kind: "simulator", fault_charger_id: "bay-2" });
  const sent = await h.api<DepotDispatch>("POST", `/api/fleets/${h.fleetId}/depots/yard/dispatch`);
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.data.results.map((r) => [r.charger_id, r.answer]), [["bay-1", "accepted"], ["bay-2", "accepted"]]);
  assert.ok(sent.data.ok);
  let p = await plan(h);
  assert.equal(p.chargers["bay-2"].state, "available", "its truck isn't in yet, and no fault yet");
  assert.equal(p.chargers["bay-3"].state, "available");

  h.clock.now = new Date(Date.parse(NOW) + SIM_FAULT_AFTER_MS + 1000);
  p = await plan(h);
  assert.equal(p.chargers["bay-2"].state, "faulted");
  assert.match(p.chargers["bay-2"].fault!, /Earth leakage/);
  const truck = p.visits.find((v) => v.visit.id === b.id)!;
  assert.match(truck.charger_fault!, /Earth leakage/);
  assert.equal(truck.outcome, "short", "nothing can be planned on a faulted charger");
  assert.ok(truck.plan.kw.every((kw) => kw === 0));

  // Move the truck to the spare charger and send again: all accepted, and Bay 2 isn't sent anything.
  assert.equal((await h.api("PATCH", `/api/fleets/${h.fleetId}/depot-visits/${b.id}`, { charger_id: "bay-3" })).status, 200);
  const again = await h.api<DepotDispatch>("POST", `/api/fleets/${h.fleetId}/depots/yard/dispatch`);
  assert.deepEqual(again.data.results.map((r) => r.charger_id).sort(), ["bay-1", "bay-3"]);
  p = await plan(h);
  assert.equal(p.visits.find((v) => v.visit.id === b.id)!.outcome, "ready");
  assert.equal(p.chargers["bay-2"].state, "faulted", "still faulted until it's cleared");

  // Clear the fault (simulator only).
  assert.equal((await h.api("POST", `/api/fleets/${h.fleetId}/depots/yard/reset-chargers`)).status, 200);
  assert.equal((await plan(h)).chargers["bay-2"].state, null);
});

/** A fake CitrineOS: records commands and subscriptions; `oldApi` answers 404 on the new
 *  subscription path, like CitrineOS 1.x. */
function fakeCitrine(h: Harness, opts: { oldApi?: boolean; offline?: string } = {}) {
  const calls: { url: URL; body: Record<string, unknown> }[] = [];
  const inner = h.ctx.transport.bind(h.ctx);
  h.ctx.transport = async (req) => {
    if (!req.url.startsWith("https://csms.example.com/")) return inner(req);
    const url = new URL(req.url);
    const body = JSON.parse(await req.text()) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.pathname === "/ocpprouter/subscription" && opts.oldApi) return new Response("", { status: 404 });
    if (url.pathname.endsWith("/subscription")) return Response.json(17);
    if (url.searchParams.get("identifier") === opts.offline) return Response.json([{ success: false, payload: "Charging station CP-B is offline" }]);
    return Response.json([{ success: true }]);
  };
  return calls;
}
const pathOf = (u: string) => { const x = new URL(u); return x.pathname + x.search; };

test("CitrineOS: answers come back through the callback, faults through the subscription", async () => {
  const h = await harness(NOW);
  await depot(h, { kind: "citrineos", base_url: "https://csms.example.com", tenant_id: "1" });
  const calls = fakeCitrine(h);
  const sent = await h.api<DepotDispatch>("POST", `/api/fleets/${h.fleetId}/depots/yard/dispatch`);
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.data.results.map((r) => r.answer), ["waiting", "waiting"]);

  // One subscription per station, for its status messages, to the depot's report address.
  const subs = calls.filter((c) => c.url.pathname === "/ocpprouter/subscription");
  assert.deepEqual(subs.map((s) => s.body.ocppConnectionName), ["CP-A", "CP-B"]);
  assert.equal(subs[0].body.messageRegexFilter, "StatusNotification|NotifyEvent");
  const report = String(subs[0].body.url);
  assert.match(report, /\/api\/chargers\/[^/]+\/yard\/[A-Za-z0-9_-]{20,}$/);
  // Each profile carries a callback address for the charger's answer.
  const cmds = calls.filter((c) => c.url.pathname === "/ocpp/2.0.1/smartcharging/setChargingProfile");
  assert.equal(cmds.length, 2);
  const callback = cmds[0].url.searchParams.get("callbackUrl")!;
  assert.equal(new URL(callback).searchParams.get("sent"), sent.data.at);

  // The charger's answer, as CitrineOS posts it.
  assert.equal((await h.api("POST", pathOf(callback), { status: "Accepted" })).status, 200);
  const rejectedAt = answerFor(cmds[1].url);
  assert.equal((await h.api("POST", pathOf(rejectedAt), { status: "Rejected", statusInfo: { reasonCode: "InvalidSchedule" } })).status, 200);
  let p = await plan(h);
  assert.deepEqual([p.chargers["bay-1"].answer?.answer, p.chargers["bay-2"].answer?.answer, p.chargers["bay-2"].answer?.reason], ["accepted", "rejected", "InvalidSchedule"]);

  // A station message through the subscription: EVSE 2 on CP-A faults.
  const event = (message: unknown[], extra: object = {}) => h.api("POST", pathOf(report), { ocppConnectionName: "CP-A", event: "message", origin: "cs", message: JSON.stringify(message), info: { action: message[2] }, ...extra });
  assert.equal((await event([2, "a1", "StatusNotification", { timestamp: NOW, connectorStatus: "Faulted", evseId: 2, connectorId: 1 }])).status, 200);
  await event([2, "a2", "NotifyEvent", { generatedAt: NOW, seqNo: 0, eventData: [{ eventId: 1, timestamp: NOW, trigger: "Delta", actualValue: "true", techInfo: "Insulation fault", eventNotificationType: "HardWiredNotification", component: { name: "EVSE", evse: { id: 2 } }, variable: { name: "Problem" } }] }]);
  // Our own command echoed back (origin csms) changes nothing.
  await event([2, "a3", "StatusNotification", { timestamp: NOW, connectorStatus: "Faulted", evseId: 1, connectorId: 1 }], { origin: "csms" });
  p = await plan(h);
  assert.equal(p.chargers["bay-1"].state, null);
  assert.equal(p.chargers["bay-2"].state, "faulted");
  assert.equal(p.chargers["bay-2"].fault, "Insulation fault");
  assert.ok(p.visits.find((v) => v.visit.charger_id === "bay-2")!.charger_fault);

  // The station loses its connection: its chargers show as offline (they keep their own settings).
  h.clock.now = new Date(later(5));
  await h.api("POST", pathOf(report), { ocppConnectionName: "CP-A", event: "closed" });
  p = await plan(h);
  assert.equal(p.chargers["bay-1"].state, "offline");
  assert.equal(p.chargers["bay-2"].state, "faulted", "a fault outranks a lost connection");

  // A newer plan: an answer to the older one never replaces the newer answer.
  h.clock.now = new Date(later(10));
  const second = await h.api<DepotDispatch>("POST", `/api/fleets/${h.fleetId}/depots/yard/dispatch`);
  const fresh = calls.filter((c) => c.url.pathname.endsWith("/setChargingProfile") && c.url.searchParams.get("identifier") === "CP-A" && c.body.evseId === 1).at(-1)!;
  assert.equal(new URL(fresh.url.searchParams.get("callbackUrl")!).searchParams.get("sent"), second.data.at);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/subscription")).length, 2, "stations are subscribed once");
  await h.api("POST", pathOf(answerFor(fresh.url)), { status: "Accepted" });
  await h.api("POST", pathOf(callback), { status: "Rejected" });
  assert.equal((await plan(h)).chargers["bay-1"].answer?.sent_at, second.data.at);
});

const answerFor = (url: URL) => url.searchParams.get("callbackUrl")!;

test("CitrineOS: the report address is checked; older CitrineOS and an offline station", async () => {
  const h = await harness(NOW);
  await depot(h, { kind: "citrineos", base_url: "https://csms.example.com", tenant_id: "1", ocpp_version: "2.1" });
  const calls = fakeCitrine(h, { oldApi: true, offline: "CP-A" });
  const sent = await h.api<DepotDispatch>("POST", `/api/fleets/${h.fleetId}/depots/yard/dispatch`);
  assert.equal(sent.data.ok, false);
  assert.match(sent.data.results[0].message, /offline/);
  assert.ok(calls.some((c) => c.url.pathname.startsWith("/ocpp/2.1/")), "the chosen OCPP version");
  const old = calls.filter((c) => c.url.pathname === "/data/ocpprouter/subscription");
  assert.deepEqual(old.map((c) => c.body.stationId), ["CP-A", "CP-B"], "CitrineOS 1.x: stationId on the old path");

  const report = String(old[0].body.url);
  const u = new URL(report);
  const wrong = u.pathname.replace(/[^/]+$/, "x".repeat(32));
  assert.equal((await h.api("POST", wrong, { ocppConnectionName: "CP-A", event: "closed" })).status, 404);
  assert.equal((await h.api("POST", u.pathname.replace("/yard/", "/other/"), { ocppConnectionName: "CP-A", event: "closed" })).status, 404);
  assert.equal((await h.api("POST", `${u.pathname}?charger=bay-9&sent=${encodeURIComponent(sent.data.at)}`, { status: "Accepted" })).status, 400, "not one of its chargers");
  assert.equal((await h.api("POST", u.pathname, { event: "message", message: "[]" })).status, 400, "no station named");
  assert.equal((await h.api("POST", u.pathname, { ocppConnectionName: "CP-Z", event: "closed" })).status, 200, "another depot's station: ignored");
});

test("a depot operator's system gets addresses to report back to", async () => {
  const h = await harness(NOW);
  await depot(h, { kind: "webhook", url: "https://depot.example.com/profiles" });
  const posted: Record<string, unknown>[] = [];
  const inner = h.ctx.transport.bind(h.ctx);
  h.ctx.transport = async (req) => {
    if (!req.url.startsWith("https://depot.example.com/")) return inner(req);
    posted.push(JSON.parse(await req.text()) as Record<string, unknown>);
    return new Response(null, { status: 202 });
  };
  const sent = await h.api<DepotDispatch>("POST", `/api/fleets/${h.fleetId}/depots/yard/dispatch`);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].sent_at, sent.data.at);
  assert.equal((await h.api("POST", pathOf(String(posted[0].answer_url)), { status: "Accepted" })).status, 200);
  assert.equal((await h.api("POST", pathOf(String(posted[0].report_url)), { stationId: "CP-B", event: "message", message: [2, "x", "StatusNotification", { connectorStatus: "Unavailable", evseId: 1, timestamp: NOW }] })).status, 200);
  const p = await plan(h);
  assert.equal(p.chargers["bay-1"].answer?.answer, "accepted");
  assert.equal(p.chargers["bay-3"].state, "unavailable");
});

test("chargers' and trucks' live records are one per key, and go with the fleet", async () => {
  const h = await harness(NOW);
  const { vehicles } = await depot(h, { kind: "simulator" });
  await h.api("POST", `/api/fleets/${h.fleetId}/telemetry`, { readings: vehicles.slice(0, 3).map((v, i) => ({ vehicle_id: v.id, soc_pct: 40 + i })) });
  await h.api("POST", `/api/fleets/${h.fleetId}/depots/yard/dispatch`);
  const keys = Object.keys(h.store.data.live ?? {});
  assert.equal(keys.filter((k) => k.includes("/telemetry/")).length, 3);
  assert.ok(keys.some((k) => k.includes("/chargers/yard/bay-1/status")));
  assert.ok(!h.store.data.energy!.find((e) => e.fleet_id === h.fleetId)!.state?.telemetry, "not in the energy settings row");
  await h.store.deleteFleet(h.fleetId);
  assert.equal(Object.keys(h.store.data.live ?? {}).filter((k) => k.startsWith(`${h.fleetId}/`)).length, 0);
});
