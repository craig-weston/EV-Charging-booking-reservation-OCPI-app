// Grid flexibility for depots: events come from an aggregator (signed webhook) or the simulator;
// we work out what the depot can safely commit (no truck may leave short), accept or decline,
// plan the chargers around accepted events, and after each event report delivery and credit the
// fleet's share of the payment on its monthly statement.
//
// Aggregator API (Depotcharge Flex), all bodies JSON, signed "Depotcharge-Signature: t=…,v1=…"
// (HMAC-SHA256 of `${t}.${body}` with the fleet's flex secret, the same scheme as our webhooks):
//   POST /api/flex/{fleet_id}/events                      offer an event → our commitment
//   POST /api/flex/{fleet_id}/events/{event_id}/settlement final payment for a delivered event
// We post to the fleet's report_url: flex.commitment (accept/decline) and flex.delivery.
import type { Ctx } from "./context";
import type { FleetEnergyRow } from "../shared/model";
import type { Depot } from "../shared/energy/depot";
import { MIN_COMMIT_KW, PROGRAMME_LABEL, flexPayment, hoursOf, newEvent, type FlexDirection, type FlexEvent, type FlexProgramme } from "../shared/energy/flex";
import { depotInputs, energyRow, planFromInputs, type PlanInputs } from "./depot";
import { hmacHex, signature } from "./webhooks";
import { openSecret } from "./security";
import { ApiError } from "./emsp/service";
import { iso, localDateKey, localToUtc, uuid } from "../shared/util";
import { DEFAULT_BILLING, cleanBilling, type BillingSettings } from "../shared/billing";

const SIGNATURE_TOLERANCE_S = 300;

async function fleetShare(ctx: Ctx): Promise<number> {
  const b = cleanBilling((await ctx.store.getSetting<BillingSettings>("billing")) ?? DEFAULT_BILLING);
  return b.flex_fleet_share;
}

/** Average planned kW over [a, b) in a plan. */
function windowKw(plan: ReturnType<typeof planFromInputs>, a: number, b: number): number {
  let e = 0;
  plan.slots.forEach((s, j) => {
    const ov = Math.max(0, Math.min(b, s.end) - Math.max(a, s.start)) / 3_600_000;
    if (ov > 0) e += plan.totalKw[j] * ov;
  });
  const h = (b - a) / 3_600_000;
  return h > 0 ? e / h : 0;
}
const shortfall = (plan: ReturnType<typeof planFromInputs>) => plan.visits.reduce((a, v) => a + v.shortfallKwh, 0);

/**
 * What the depot can commit to an event without any truck leaving with less charge than planned:
 * turn-down → the lowest charging cap in the window that keeps every departure; turn-up → the
 * extra power the optimiser moves into the window when it's paid for.
 */
export function assessEvent(inputs: PlanInputs, accepted: FlexEvent[], ev: FlexEvent): { committed_kw: number; cap_kw: number | null; baseline_kw: number; reason: string | null } {
  const a = Date.parse(ev.start_at), b = Date.parse(ev.end_at);
  const others = accepted.filter((x) => x.id !== ev.id);
  const plan0 = planFromInputs(inputs, others);
  const base = windowKw(plan0, a, b);
  const short0 = shortfall(plan0);
  if (ev.direction === "down") {
    if (base < MIN_COMMIT_KW) return { committed_kw: 0, cap_kw: null, baseline_kw: base, reason: "Nothing is planned to charge then, so there's nothing to turn down" };
    const ok = (cap: number) => shortfall(planFromInputs(inputs, [...others, { ...ev, status: "accepted", cap_kw: cap }])) <= short0 + 0.5;
    let lo = 0, hi = base;
    if (ok(0)) hi = 0;
    else {
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
    }
    let committed = base - hi;
    if (ev.requested_kw != null && ev.requested_kw > 0) committed = Math.min(committed, ev.requested_kw);
    committed = Math.floor(committed);
    if (committed < MIN_COMMIT_KW) return { committed_kw: 0, cap_kw: null, baseline_kw: base, reason: "Every truck needs that time to be ready before it leaves" };
    return { committed_kw: committed, cap_kw: Math.max(0, Math.round(base - committed)), baseline_kw: Math.round(base), reason: null };
  }
  const plan1 = planFromInputs(inputs, [...others, { ...ev, status: "accepted" }]);
  let extra = windowKw(plan1, a, b) - base;
  if (ev.requested_kw != null && ev.requested_kw > 0) extra = Math.min(extra, ev.requested_kw);
  extra = Math.floor(extra);
  if (extra < MIN_COMMIT_KW) return { committed_kw: 0, cap_kw: null, baseline_kw: base, reason: "No truck has charging to move into that time" };
  return { committed_kw: extra, cap_kw: null, baseline_kw: Math.round(base), reason: null };
}

async function report(ctx: Ctx, row: FleetEnergyRow, type: string, ev: FlexEvent): Promise<void> {
  const p = row.config.flex_provider;
  if (p.kind !== "aggregator" || !p.report_url) return;
  const secret = row.secrets.flex ? await openSecret(row.secrets.flex, ctx.env.DATA_ENCRYPTION_KEY, ctx.env.DATA_ENCRYPTION_KEY_PREVIOUS) : null;
  const body = JSON.stringify({
    type, sent_at: iso(ctx.now()), fleet_id: ev.fleet_id,
    event: { id: ev.id, provider_event_id: ev.provider_event_id, depot_id: ev.depot_id, programme: ev.programme, direction: ev.direction, start_at: ev.start_at, end_at: ev.end_at, status: ev.status, committed_kw: ev.committed_kw, baseline_kw: ev.baseline_kw, delivered_kwh: ev.delivered_kwh, reason: ev.reason },
  });
  try {
    await ctx.transport(new Request(p.report_url, { method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { "Depotcharge-Signature": await signature(secret, body, ctx.now()) } : {}) }, body }));
  } catch (e) { console.warn("flex report failed", e); }
}

/** Accept (with the assessed commitment) or decline an event and save it. */
export async function decide(ctx: Ctx, row: FleetEnergyRow, ev: FlexEvent, accept: boolean, by: string): Promise<FlexEvent> {
  const depot = row.config.depots.find((d) => d.id === ev.depot_id);
  if (!depot) throw new ApiError(404, "Depot not found");
  if (ev.status !== "offered") throw new ApiError(409, "This event has already been decided");
  if (Date.parse(ev.start_at) <= ctx.now().getTime()) throw new ApiError(409, "This event has already started");
  let next: FlexEvent;
  if (!accept) {
    next = { ...ev, status: "declined", reason: ev.reason ?? "Declined by the fleet", decided_by: by, updated_at: iso(ctx.now()) };
  } else {
    const [visits, vehicles, events] = await Promise.all([ctx.store.listDepotVisits(ev.fleet_id, iso(ctx.now())), ctx.store.listVehicles(ev.fleet_id), ctx.store.listFlexEvents(ev.fleet_id, iso(ctx.now()))]);
    const inputs = await depotInputs(ctx, depot, visits, vehicles);
    const a = assessEvent(inputs, events.filter((x) => x.status === "accepted"), ev);
    next = a.committed_kw >= MIN_COMMIT_KW
      ? { ...ev, status: "accepted", committed_kw: a.committed_kw, cap_kw: a.cap_kw, baseline_kw: a.baseline_kw, reason: null, decided_by: by, updated_at: iso(ctx.now()) }
      : { ...ev, status: "declined", reason: a.reason, baseline_kw: a.baseline_kw, decided_by: by, updated_at: iso(ctx.now()) };
  }
  const saved = await ctx.store.upsertFlexEvent(next);
  ctx.waitUntil(report(ctx, row, "flex.commitment", saved));
  return saved;
}

/** A new event for a depot: stored, then decided straight away when the depot accepts automatically. */
export async function offerEvent(ctx: Ctx, row: FleetEnergyRow, depot: Depot, p: { provider_event_id: string | null; programme: FlexProgramme; direction: FlexDirection; start_at: string; end_at: string; price_per_mwh: number; requested_kw: number | null; source: FlexEvent["source"] }): Promise<FlexEvent> {
  const now = ctx.now();
  if (Date.parse(p.end_at) <= Date.parse(p.start_at)) throw new ApiError(400, "end must be after start");
  if (Date.parse(p.start_at) <= now.getTime()) throw new ApiError(400, "The event must start in the future");
  if (Date.parse(p.end_at) - Date.parse(p.start_at) > 6 * 3_600_000) throw new ApiError(400, "Events can be at most 6 hours long");
  const ev = newEvent({ id: uuid(), fleet_id: row.fleet_id, depot_id: depot.id, ...p }, now);
  if (!depot.flex.enabled) return ctx.store.upsertFlexEvent({ ...ev, status: "declined", reason: "This depot isn't taking part in grid flexibility" });
  if (!depot.flex.programmes.includes(p.programme)) return ctx.store.upsertFlexEvent({ ...ev, status: "declined", reason: `This depot doesn't take ${PROGRAMME_LABEL[p.programme]} events` });
  if (p.price_per_mwh < depot.flex.min_price_mwh) return ctx.store.upsertFlexEvent({ ...ev, status: "declined", reason: `Below the depot's minimum of £${depot.flex.min_price_mwh}/MWh` });
  const stored = await ctx.store.upsertFlexEvent(ev);
  return depot.flex.auto_accept ? decide(ctx, row, stored, true, "auto") : stored;
}

/** After an event ends: record what was delivered (as planned, until the aggregator settles) and the credit. */
export async function closeEndedEvents(ctx: Ctx, fleetId: string): Promise<number> {
  const now = ctx.now().getTime();
  const row = await energyRow(ctx, fleetId);
  const share = await fleetShare(ctx);
  let n = 0;
  for (const ev of await ctx.store.listFlexEvents(fleetId, new Date(now - 14 * 864e5).toISOString())) {
    if (Date.parse(ev.end_at) > now) continue;
    if (ev.status === "offered") { await ctx.store.upsertFlexEvent({ ...ev, status: "cancelled", reason: "Not decided before it started", updated_at: iso(ctx.now()) }); continue; }
    if (ev.status !== "accepted") continue;
    const kwh = Math.round((ev.committed_kw ?? 0) * hoursOf(ev) * 10) / 10;
    const pay = flexPayment(kwh, ev.price_per_mwh, share);
    const done = await ctx.store.upsertFlexEvent({ ...ev, status: "delivered", delivered_kwh: kwh, payment_gbp: pay.payment, fleet_share_pct: share, fleet_credit_gbp: pay.credit, estimated: true, updated_at: iso(ctx.now()) });
    ctx.waitUntil(report(ctx, row, "flex.delivery", done));
    n++;
  }
  return n;
}

/** The aggregator's final figures replace our estimate. */
export async function settleEvent(ctx: Ctx, ev: FlexEvent, b: { payment_gbp?: unknown; delivered_kwh?: unknown }): Promise<FlexEvent> {
  if (ev.status !== "delivered" && ev.status !== "settled" && ev.status !== "accepted") throw new ApiError(409, "Only accepted events can be settled");
  const pay = Number(b.payment_gbp);
  if (!Number.isFinite(pay) || pay < 0 || pay > 1_000_000) throw new ApiError(400, "payment_gbp must be a positive amount");
  const kwh = b.delivered_kwh == null ? ev.delivered_kwh : Number(b.delivered_kwh);
  const share = ev.fleet_share_pct ?? (await fleetShare(ctx));
  return ctx.store.upsertFlexEvent({ ...ev, status: "settled", payment_gbp: Math.round(pay * 100) / 100, delivered_kwh: kwh != null && Number.isFinite(kwh) ? kwh : ev.delivered_kwh, fleet_share_pct: share, fleet_credit_gbp: Math.round(pay * share) / 100, estimated: false, updated_at: iso(ctx.now()) });
}

// --- inbound aggregator API ---------------------------------------------------------------------

async function verify(ctx: Ctx, row: FleetEnergyRow, req: Request, body: string): Promise<boolean> {
  const secret = row.secrets.flex ? await openSecret(row.secrets.flex, ctx.env.DATA_ENCRYPTION_KEY, ctx.env.DATA_ENCRYPTION_KEY_PREVIOUS) : null;
  if (!secret) return false;
  const h = req.headers.get("Depotcharge-Signature") ?? "";
  const t = /(?:^|,)t=(\d+)/.exec(h)?.[1], v1 = /(?:^|,)v1=([0-9a-f]{64})/.exec(h)?.[1];
  if (!t || !v1) return false;
  if (Math.abs(ctx.now().getTime() / 1000 - Number(t)) > SIGNATURE_TOLERANCE_S) return false;
  const want = await hmacHex(secret, `${t}.${body}`);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export async function handleFlexInbound(ctx: Ctx, req: Request, fleetId: string, seg: string[], text: string): Promise<{ status: number; data: unknown }> {
  const row = await ctx.store.getEnergy(fleetId);
  if (!row || row.config.flex_provider?.kind !== "aggregator") return { status: 404, data: { error: "Unknown fleet" } };
  if (!(await verify(ctx, row, req, text))) return { status: 401, data: { error: "Bad or missing Depotcharge-Signature" } };
  let b: Record<string, unknown>;
  try { b = JSON.parse(text); } catch { return { status: 400, data: { error: "Expected JSON" } }; }
  if (seg.length === 0) {
    const depot = row.config.depots.find((d) => d.id === b.depot_id);
    if (!depot) return { status: 400, data: { error: "Unknown depot_id" } };
    const programme = String(b.programme ?? "").toUpperCase() as FlexProgramme;
    if (!["DFS", "DNO", "BM"].includes(programme)) return { status: 400, data: { error: "programme must be DFS, DNO or BM" } };
    const direction = b.direction === "up" ? "up" : b.direction === "down" ? "down" : null;
    if (!direction) return { status: 400, data: { error: "direction must be down or up" } };
    const pid = typeof b.event_id === "string" ? b.event_id.slice(0, 120) : null;
    if (pid) {
      const dup = await ctx.store.findFlexEventByProvider(fleetId, pid);
      if (dup) return { status: 200, data: commitment(dup) };
    }
    const start = new Date(String(b.start)), end = new Date(String(b.end));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { status: 400, data: { error: "start and end must be ISO 8601 times" } };
    const price = Number(b.price_per_mwh);
    if (!Number.isFinite(price) || price < 0) return { status: 400, data: { error: "price_per_mwh must be a number" } };
    try {
      const ev = await offerEvent(ctx, row, depot, { provider_event_id: pid, programme, direction, start_at: start.toISOString(), end_at: end.toISOString(), price_per_mwh: price, requested_kw: b.requested_kw != null && Number.isFinite(Number(b.requested_kw)) ? Number(b.requested_kw) : null, source: "aggregator" });
      return { status: 201, data: commitment(ev) };
    } catch (e) {
      return { status: e instanceof ApiError ? e.status : 500, data: { error: (e as Error).message } };
    }
  }
  if (seg.length === 2 && seg[1] === "settlement") {
    const ev = (await ctx.store.getFlexEvent(seg[0])) ?? (await ctx.store.findFlexEventByProvider(fleetId, seg[0]));
    if (!ev || ev.fleet_id !== fleetId) return { status: 404, data: { error: "Unknown event" } };
    try { return { status: 200, data: commitment(await settleEvent(ctx, ev, b)) }; } catch (e) { return { status: e instanceof ApiError ? e.status : 500, data: { error: (e as Error).message } }; }
  }
  return { status: 404, data: { error: "Not found" } };
}

function commitment(ev: FlexEvent) {
  return { id: ev.id, event_id: ev.provider_event_id, status: ev.status, accepted: ev.status === "accepted" || ev.status === "delivered" || ev.status === "settled", pending: ev.status === "offered", committed_kw: ev.committed_kw, baseline_kw: ev.baseline_kw, reason: ev.reason, payment_gbp: ev.payment_gbp };
}

// --- simulator (demo, and trying it out before an aggregator is connected) ----------------------

/** A realistic event for a depot: a DNO constraint as off-peak load ramps up, a DFS evening
 *  turn-down, or a DFS turn-up when wind is plentiful. */
export async function simulateEvent(ctx: Ctx, row: FleetEnergyRow, depot: Depot, kind: "dno" | "dfs-down" | "dfs-up", accept?: boolean): Promise<FlexEvent> {
  const now = ctx.now();
  const local = (dayOffset: number, hh: number, mm = 0) => {
    const [y, m, d] = localDateKey(new Date(now.getTime() + dayOffset * 864e5), "Europe/London").split("-").map(Number);
    return localToUtc(y, m, d, hh, mm, "Europe/London");
  };
  const next = (hh: number, mm: number) => { const t = local(0, hh, mm); return t.getTime() > now.getTime() + 15 * 60_000 ? t : local(1, hh, mm); };
  const spec = kind === "dno"
    ? { programme: "DNO" as const, direction: "down" as const, start: next(0, 30), hours: 1, price: 600 }
    : kind === "dfs-down"
      ? { programme: "DFS" as const, direction: "down" as const, start: next(17, 30), hours: 1.5, price: 900 }
      : { programme: "DFS" as const, direction: "up" as const, start: next(21, 0), hours: 1, price: 120 };
  const d = { ...depot, flex: accept === false ? { ...depot.flex, auto_accept: false } : depot.flex };
  return offerEvent(ctx, row, d, { provider_event_id: `SIM-${uuid().slice(0, 8)}`, programme: spec.programme, direction: spec.direction, start_at: spec.start.toISOString(), end_at: new Date(spec.start.getTime() + spec.hours * 3_600_000).toISOString(), price_per_mwh: spec.price, requested_kw: null, source: "simulated" });
}

/** Cron: close ended events for every fleet taking part (delivery reports and credits). */
export async function runFlexHousekeeping(ctx: Ctx): Promise<number> {
  let n = 0;
  for (const row of await ctx.store.listEnergy()) {
    if (!row.config.depots?.some((d) => d.flex?.enabled)) continue;
    try { n += await closeEndedEvents(ctx, row.fleet_id); } catch (e) { console.warn("flex housekeeping failed", row.fleet_id, e); }
  }
  return n;
}
