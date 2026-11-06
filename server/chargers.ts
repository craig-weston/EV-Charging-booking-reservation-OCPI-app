// The chargers' side of depot charging: their answers to the plans we send, and their state.
//
// - CitrineOS: each SetChargingProfile call carries a callbackUrl, so CitrineOS posts the charger's
//   answer back to us. We also subscribe (CitrineOS webhooks) to each station's StatusNotification
//   and NotifyEvent messages, so a fault shows up here within seconds.
// - A depot operator's own system can post to the same addresses (docs/chargers.md).
// - The simulator answers like a real charger, and can develop a fault a few seconds after a plan
//   is sent, reported through the same OCPP messages a real station sends.
//
//   POST /api/chargers/{fleet}/{depot}/{token}                    station events (CitrineOS's format)
//   POST /api/chargers/{fleet}/{depot}/{token}?charger=…&sent=…   a charger's answer to a plan
//
// Facts are stored one per key (server/livekeys.ts), so answers arriving together never overwrite
// each other.
import type { Ctx } from "./context";
import type { Depot } from "../shared/energy/depot";
import type { ChargerDispatchResult } from "../shared/model";
import {
  checkProfile, chargerNow, faultFrames, parseFrame, profileAnswer, stationReports,
  type ChargerAnswer, type ChargerNow, type ChargerProblem, type ChargerStatus, type StationLink,
} from "../shared/energy/chargers";
import { chargerKey, chargersPrefix, getLive, hookKey, seg, simKey, stationKey, stationsPrefix, subscribedPrefix, unseg } from "./livekeys";
import { openSecret, safeEqual, sealSecret } from "./security";
import { iso } from "../shared/util";

/** How long after a plan is sent the simulated fault appears. */
export const SIM_FAULT_AFTER_MS = 6_000;
export const SIM_FAULT_TEXT = "Earth leakage (the residual current device tripped)";
const TIMEOUT_MS = 8_000;

interface SimFault { charger_id: string; at: string; sent_at: string; applied?: boolean }

/** The secret part of the depot's report address: random, sealed, made the first time it's needed. */
export async function hookToken(ctx: Ctx, fleetId: string, depotId: string, create = true): Promise<string | null> {
  const open = async () => {
    const sealed = await getLive<string>(ctx.store, hookKey(fleetId, depotId));
    return sealed ? openSecret(sealed, ctx.env.DATA_ENCRYPTION_KEY, ctx.env.DATA_ENCRYPTION_KEY_PREVIOUS) : null;
  };
  const existing = await open();
  if (existing || !create) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await ctx.store.putLive({ [hookKey(fleetId, depotId)]: await sealSecret(token, ctx.env.DATA_ENCRYPTION_KEY) });
  // Two sends at once: both use whichever token was stored last.
  return (await open()) ?? token;
}

/** Where stations' messages for this depot are sent. */
export const reportUrl = (ctx: Ctx, fleetId: string, depotId: string, token: string) =>
  `${ctx.baseUrl.replace(/\/+$/, "")}/api/chargers/${encodeURIComponent(fleetId)}/${encodeURIComponent(depotId)}/${token}`;
/** Where one charger's answer to the plan sent at `sentAt` goes. */
export const answerUrl = (report: string, chargerId: string, sentAt: string) => `${report}?charger=${encodeURIComponent(chargerId)}&sent=${encodeURIComponent(sentAt)}`;

/** Every charger at the depot now: state, fault, and its answer to the latest plan. */
export async function depotChargers(ctx: Ctx, fleetId: string, depot: Depot): Promise<Record<string, ChargerNow>> {
  if (depot.control.kind === "simulated") return {};
  const [facts, links] = await Promise.all([
    ctx.store.listLive<unknown>(chargersPrefix(fleetId, depot.id)),
    ctx.store.listLive<StationLink>(stationsPrefix(fleetId, depot.id)),
  ]);
  const by: Record<string, { status?: ChargerStatus; problem?: ChargerProblem; answer?: ChargerAnswer }> = {};
  for (const [k, v] of Object.entries(facts)) {
    const [c, fact] = k.split("/");
    if (fact === "status" || fact === "problem" || fact === "answer") (by[unseg(c)] ??= {})[fact] = v as never;
  }
  return Object.fromEntries(depot.chargers.map((ch) => [ch.id, chargerNow(by[ch.id] ?? {}, links[seg(ch.station_id)])]));
}

/** Stores each fact unless a newer one is already there. */
async function putNewer(ctx: Ctx, facts: Record<string, { at: string }>): Promise<number> {
  const keep: Record<string, { at: string }> = {};
  for (const [key, value] of Object.entries(facts)) {
    const cur = await getLive<{ at: string }>(ctx.store, key);
    if (!cur || cur.at <= value.at) keep[key] = value;
  }
  if (Object.keys(keep).length) await ctx.store.putLive(keep);
  return Object.keys(keep).length;
}

/** What a station said (an OCPP-J call from it), for the depot's chargers on that station. Returns
 *  how many facts were stored. */
export async function recordStationMessage(ctx: Ctx, fleetId: string, depot: Depot, stationId: string, raw: unknown): Promise<number> {
  const frame = parseFrame(raw);
  if (!frame || frame.type !== 2 || !frame.action) return 0;
  const facts: Record<string, { at: string }> = {};
  for (const r of stationReports(frame.action, frame.payload, ctx.now())) {
    const targets = depot.chargers.filter((c) => c.station_id === stationId && (r.evse == null || r.evse === 0 || c.evse_id === r.evse));
    for (const c of targets) {
      if (r.status) { const f: ChargerStatus = { state: r.status, at: r.at }; facts[chargerKey(fleetId, depot.id, c.id, "status")] = f; }
      if (r.problem) { const f: ChargerProblem = { ...r.problem, at: r.at }; facts[chargerKey(fleetId, depot.id, c.id, "problem")] = f; }
    }
  }
  return putNewer(ctx, facts);
}

/** A charger's answer to the plan sent at `sentAt`. An answer to an older plan never replaces a newer one. */
export async function recordAnswer(ctx: Ctx, fleetId: string, depot: Depot, chargerId: string, sentAt: string, payload: Record<string, unknown>): Promise<boolean> {
  const a = profileAnswer(payload);
  const sent = Date.parse(sentAt);
  if (!a || Number.isNaN(sent) || !depot.chargers.some((c) => c.id === chargerId)) return false;
  const key = chargerKey(fleetId, depot.id, chargerId, "answer");
  const cur = await getLive<ChargerAnswer>(ctx.store, key);
  const sent_at = iso(sent);
  if (cur && cur.sent_at > sent_at) return true;
  await ctx.store.putLive({ [key]: { ...a, at: iso(ctx.now()), sent_at } satisfies ChargerAnswer });
  return true;
}

/** Inbound: CitrineOS (subscriptions and callbacks), or a depot operator's own system. */
export async function handleChargerHook(ctx: Ctx, fleetId: string, depotId: string, token: string, url: URL, text: string): Promise<{ status: number; data: unknown }> {
  const notFound = { status: 404, data: { error: { message: "Not found" } } };
  const bad = (message: string) => ({ status: 400, data: { error: { message } } });
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return notFound;
  const row = await ctx.store.getEnergy(fleetId).catch(() => null);
  const depot = row?.config.depots.find((d) => d.id === depotId);
  if (!depot) return notFound;
  const expected = await hookToken(ctx, fleetId, depotId, false);
  if (!expected || !safeEqual(token, expected)) return notFound;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("Send a JSON object");
    body = parsed as Record<string, unknown>;
  } catch { return bad("Send JSON"); }

  const charger = url.searchParams.get("charger");
  if (charger !== null) {
    return (await recordAnswer(ctx, fleetId, depot, charger, url.searchParams.get("sent") ?? "", body))
      ? { status: 200, data: { ok: true } }
      : bad("Send the charger's answer: { \"status\": \"Accepted\" } or { \"status\": \"Rejected\" }, for one of this depot's chargers");
  }
  const station = String(body.ocppConnectionName ?? body.stationId ?? body.station_id ?? "").slice(0, 120);
  if (!station) return bad("Name the station: ocppConnectionName (or stationId)");
  const event = String(body.event ?? "message");
  if (event === "connected" || event === "closed") {
    if (!depot.chargers.some((c) => c.station_id === station)) return { status: 200, data: { ok: true, recorded: 0 } };
    await ctx.store.putLive({ [stationKey(fleetId, depot.id, station)]: { online: event === "connected", at: iso(ctx.now()) } satisfies StationLink });
    return { status: 200, data: { ok: true, recorded: 1 } };
  }
  // Only what the station said; our own commands to it (origin "csms") are ignored.
  if (event !== "message" || (body.origin != null && body.origin !== "cs")) return { status: 200, data: { ok: true, recorded: 0 } };
  return { status: 200, data: { ok: true, recorded: await recordStationMessage(ctx, fleetId, depot, station, body.message) } };
}

async function call(ctx: Ctx, req: Request): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { return await ctx.transport(new Request(req, { signal: ctl.signal })); } finally { clearTimeout(timer); }
}

/** Asks CitrineOS to send us each station's status messages, once per station. Best effort: a
 *  station that fails is tried again with the next plan. */
export async function subscribeStations(ctx: Ctx, fleetId: string, depot: Depot, report: string, auth: Record<string, string>): Promise<number> {
  const c = depot.control;
  if (c.kind !== "citrineos") return 0;
  const done = await ctx.store.listLive<{ base_url: string }>(subscribedPrefix(fleetId, depot.id));
  let n = 0;
  for (const station of [...new Set(depot.chargers.map((ch) => ch.station_id))]) {
    if (done[seg(station)]?.base_url === c.base_url) continue;
    const common = { onConnect: true, onClose: true, onMessage: true, sentMessage: false, messageRegexFilter: "StatusNotification|NotifyEvent", url: report };
    const post = (path: string, body: object) => call(ctx, new Request(`${c.base_url}${path}?tenantId=${encodeURIComponent(c.tenant_id)}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body),
    }));
    try {
      let res = await post("/ocpprouter/subscription", { ocppConnectionName: station, ...common });
      // CitrineOS 1.x
      if (res.status === 404) res = await post("/data/ocpprouter/subscription", { stationId: station, ...common });
      if (res.ok) { await ctx.store.putLive({ [subscribedPrefix(fleetId, depot.id) + seg(station)]: { base_url: c.base_url, at: iso(ctx.now()) } }); n++; }
    } catch { /* tried again next time */ }
  }
  return n;
}

const steps = (request: Record<string, unknown>) => {
  const s = (request.chargingProfile as { chargingSchedule?: { chargingSchedulePeriod?: unknown[] }[] } | undefined)?.chargingSchedule?.[0]?.chargingSchedulePeriod;
  return Array.isArray(s) ? s.length : 0;
};

/** The simulator: each charger checks its profile like a real one and answers straight away. The
 *  charger set to develop a fault reports one a few seconds later. */
export async function simulatorSend(ctx: Ctx, fleetId: string, depot: Depot, profiles: { charger: Depot["chargers"][number]; request: Record<string, unknown> }[], sentAt: string): Promise<ChargerDispatchResult[]> {
  const now = await depotChargers(ctx, fleetId, depot);
  const results: ChargerDispatchResult[] = profiles.map(({ charger, request }) => {
    const check = checkProfile(request, charger.max_kw * 1000);
    return check.status === "Accepted"
      ? { charger_id: charger.id, ok: true, status: null, message: `Accepted: ${steps(request)} power ${steps(request) === 1 ? "step" : "steps"}`, answer: "accepted", answered_at: sentAt }
      : { charger_id: charger.id, ok: false, status: null, message: `Refused: ${check.reason}`, answer: "rejected", answered_at: sentAt };
  });
  // Chargers report their state when they get a plan (a truck plugged in, or free), unless faulted.
  const facts: Record<string, ChargerStatus> = {};
  for (const ch of depot.chargers) {
    if (now[ch.id]?.state === "faulted" || now[ch.id]?.state === "unavailable") continue;
    facts[chargerKey(fleetId, depot.id, ch.id, "status")] = { state: profiles.some((p) => p.charger.id === ch.id) ? "occupied" : "available", at: sentAt };
  }
  if (Object.keys(facts).length) await ctx.store.putLive(facts);
  const f = depot.control.kind === "simulator" ? depot.control.fault_charger_id : undefined;
  if (f && profiles.some((p) => p.charger.id === f) && now[f]?.state !== "faulted") {
    await ctx.store.putLive({ [simKey(fleetId, depot.id)]: { charger_id: f, at: iso(Date.parse(sentAt) + SIM_FAULT_AFTER_MS), sent_at: sentAt } satisfies SimFault });
  }
  return results;
}

/** Lets the simulator's fault happen once its time has come (called when the plan is read). */
export async function simulatorTick(ctx: Ctx, fleetId: string, depot: Depot): Promise<boolean> {
  if (depot.control.kind !== "simulator") return false;
  const sim = await getLive<SimFault>(ctx.store, simKey(fleetId, depot.id));
  if (!sim || sim.applied || Date.parse(sim.at) > ctx.now().getTime()) return false;
  await ctx.store.putLive({ [simKey(fleetId, depot.id)]: { ...sim, applied: true } });
  const ch = depot.chargers.find((c) => c.id === sim.charger_id);
  if (!ch) return false;
  for (const frame of faultFrames(ch.evse_id, sim.at, SIM_FAULT_TEXT)) await recordStationMessage(ctx, fleetId, depot, ch.station_id, frame);
  return true;
}

/** Forgets what the depot's chargers reported (the simulator's "clear the fault"). */
export async function resetChargers(ctx: Ctx, fleetId: string, depot: Depot): Promise<void> {
  await Promise.all([
    ctx.store.deleteLive(chargersPrefix(fleetId, depot.id)),
    ctx.store.deleteLive(stationsPrefix(fleetId, depot.id)),
    ctx.store.deleteLive(simKey(fleetId, depot.id)),
  ]);
}
