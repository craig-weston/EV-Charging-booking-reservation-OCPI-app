// Depot smart charging: build the charging plan for a depot and send it to the chargers.
//
// The plan is recomputed from the current visits whenever it's asked for, so the UI, the API and
// the 15-minute dispatch job always agree. Schedules go to chargers as OCPP 2.0.1
// SetChargingProfile requests (TxDefaultProfile, Absolute), through one of:
//   simulated  the demo / until chargers are connected: recorded, nothing leaves the app
//   citrineos  CitrineOS REST API: POST {base}/ocpp/2.0.1/smartcharging/setChargingProfile
//   webhook    a depot operator's own system: the same OCPP request, HMAC-signed
//
// A profile ends at the last departure, after which chargers fall back to their own defaults, so a
// lost connection can never leave a charger switched off.
import { socFromTruck, type Telemetry } from "../shared/energy/telematics";
import type { Ctx } from "./context";
import type { ChargerDispatchResult, DepotDispatch, EnergyState, FleetEnergyRow, Vehicle } from "../shared/model";
import { EMPTY_ENERGY, depotTariffAsOcpi, type Depot, type DepotVisit, type EnergyConfig } from "../shared/energy/depot";
import { energyPriceAt } from "../shared/energy/price";
import { intensityAt, HALF_HOUR, type CarbonSeries } from "../shared/energy/carbon";
import { buildSlots, planDepot, schedulePeriods, type DepotPlan } from "../shared/energy/optimise";
import { carbonFor } from "./energy";
import { feedRates, octopusRates, octopusRegion, wholesaleRates } from "./market";
import { OCTOPUS_PRODUCTS, REGION_NAMES, fillPrices, type PriceSeries } from "../shared/energy/suppliers";
import type { FlexEvent } from "../shared/energy/flex";
import { v2gPass, type V2gVisit } from "../shared/energy/v2g";
import { openSecret } from "./security";
import { signature } from "./webhooks";
import { cannotCharge, type ChargerNow } from "../shared/energy/chargers";
import { answerUrl, depotChargers, hookToken, reportUrl, simulatorSend, subscribeStations } from "./chargers";
import { fleetTelemetry } from "./telematics";
import { iso } from "../shared/util";

/** Charging efficiency, grid to battery. */
export const EFFICIENCY = 0.93;
const MAX_HORIZON_MS = 72 * 3_600_000;
const DEFAULT_TRUCK_KW = 150;

export async function energyRow(ctx: Ctx, fleetId: string): Promise<FleetEnergyRow> {
  return (await ctx.store.getEnergy(fleetId)) ?? { fleet_id: fleetId, config: EMPTY_ENERGY, secrets: {}, state: { dispatch: {} }, updated_at: iso(ctx.now()) };
}

export interface PlanVisitView {
  visit: DepotVisit;
  plate: string;
  name: string | null;
  battery_kwh: number | null;
  max_kw: number;
  need_kwh: number;
  soc_ready: number;
  plan: DepotPlan["visits"][number];
  /** "ready": full by departure; "short": can't be filled in time; "idle": nothing to do. */
  outcome: "ready" | "short" | "idle";
  /** The truck's own reading the plan used for its charge now, if any (else the typed-in figure). */
  soc_from?: Telemetry | null;
  /** Its charger can't charge now (it reported a fault, or is out of service): what's wrong. */
  charger_fault?: string | null;
}

export interface DepotPlanView {
  depot_id: string;
  generated_at: string;
  slots: DepotPlan["slots"];
  total_kw: number[];
  visits: PlanVisitView[];
  cost: number;
  kg: number;
  peak_kw: number;
  headroom_kw: number;
  baseline: DepotPlan["baseline"];
  carbon_source: CarbonSeries["source"] | null;
  price: PriceInfo;
  /** Grid flexibility events affecting this plan (accepted) or waiting for a decision (offered). */
  events: FlexEvent[];
  v2g: DepotPlan["v2g"];
}

/** Where tonight's prices came from, in words for the page. */
export interface PriceInfo {
  source: "fixed" | "octopus" | "wholesale" | "feed" | "modelled";
  /** e.g. "Octopus Shape Shifters: Agile (business), East Midlands". */
  label: string;
  /** First half-hour estimated from earlier days' prices (not yet published), or null. */
  estimated_from: string | null;
  /** Live prices weren't available, so a modelled stand-in was used. */
  modelled: boolean;
}

/** The depot's half-hourly prices from its supplier source, with gaps filled and labelled. */
export async function depotPrices(ctx: Ctx, depot: Depot, from: number, to: number, carbon: CarbonSeries | null): Promise<{ priceAt(t: number): number; info: PriceInfo }> {
  const t = depot.tariff;
  const fixedAt = (x: number) => energyPriceAt(depotTariffAsOcpi(t), new Date(x)) ?? t.standard;
  // A wholesale-shaped stand-in that tracks the carbon forecast around the standard rate.
  const modelledAt = (x: number) => Math.round(t.standard * (0.45 + 0.9 * Math.min(1.6, (intensityAt(carbon, new Date(x)) ?? 130) / 160)) * 10000) / 10000;
  if (t.kind === "fixed") return { priceAt: fixedAt, info: { source: "fixed", label: t.supplier ? `${t.supplier}, fixed rates` : "Your fixed rates", estimated_from: null, modelled: false } };
  let series: PriceSeries | null = null;
  let label = "";
  let adjust = (p: number) => p;
  if (t.kind === "octopus") {
    const product = t.octopus_product ?? "AGILE-BUS-25-02-05";
    const region = t.octopus_region && t.octopus_region !== "auto" ? t.octopus_region : (await octopusRegion(ctx, depot.postcode)) ?? "B";
    series = await octopusRates(ctx, product, region, from - 24 * 3_600_000, to);
    const name = OCTOPUS_PRODUCTS.find((p) => p.code === product)?.label ?? product;
    label = `Octopus ${name}, ${REGION_NAMES[region] ?? `region ${region}`}`;
  } else if (t.kind === "wholesale") {
    series = await wholesaleRates(ctx, from, to);
    const up = t.uplift ?? 0.12;
    adjust = (p) => Math.round((p + up) * 10000) / 10000;
    label = `Wholesale price (Elexon) + £${up.toFixed(3)}/kWh`;
  } else if (t.kind === "feed") {
    series = t.feed_url ? await feedRates(ctx, t.feed_url) : null;
    label = t.supplier ? `${t.supplier} price feed` : "Your supplier's price feed";
  }
  const filled = fillPrices(series, from, to, modelledAt, adjust);
  if (filled.allFallback) return { priceAt: modelledAt, info: { source: "modelled", label: `${label} (live prices unavailable: modelled)`, estimated_from: null, modelled: true } };
  return { priceAt: filled.priceAt, info: { source: t.kind, label, estimated_from: filled.estimatedFrom ? new Date(filled.estimatedFrom).toISOString() : null, modelled: false } };
}

export interface PlanInputs {
  depot: Depot;
  now: number;
  slots: DepotPlan["slots"];
  rows: { v: DepotVisit; veh: Vehicle | null; battery: number | null; maxKw: number; need: number; truck: Telemetry | null }[];
  chargers: { id: string; maxKw: number }[];
  /** Chargers that can't charge now, and why (from what they reported). */
  faults: Record<string, string>;
  headroom: number;
  carbonSource: CarbonSeries["source"] | null;
  price: PriceInfo;
}

/** Everything the planner needs for a depot right now (prices, carbon, trucks).
 *  `telemetry`: the trucks' own battery readings; a recent one replaces the typed-in charge for
 *  trucks at the depot or about to arrive. `chargers`: what the chargers reported; one that's
 *  faulted or out of service gets nothing until it's back. */
export async function depotInputs(ctx: Ctx, depot: Depot, visits: DepotVisit[], vehicles: Vehicle[], telemetry: Record<string, Telemetry> = {}, chargers: Record<string, ChargerNow> = {}): Promise<PlanInputs> {
  const now = ctx.now().getTime();
  const active = visits.filter((v) => v.depot_id === depot.id && (v.status === "planned" || v.status === "plugged_in") && new Date(v.depart_at).getTime() > now);
  const horizonEnd = Math.min(now + MAX_HORIZON_MS, Math.max(now + 12 * 3_600_000, ...active.map((v) => new Date(v.depart_at).getTime())));
  const carbon = await carbonFor(ctx, depot.postcode || null, new Date(now - HALF_HOUR).toISOString(), new Date(horizonEnd + HALF_HOUR).toISOString());
  const prices = await depotPrices(ctx, depot, now - HALF_HOUR, horizonEnd + HALF_HOUR, carbon);
  const priceAt = prices.priceAt;
  const headroom = Math.max(0, depot.import_limit_kw - depot.site_load_kw);
  const slots = buildSlots(now, horizonEnd, priceAt, (t) => intensityAt(carbon, new Date(t)), headroom);
  const faults: Record<string, string> = {};
  for (const c of depot.chargers) if (cannotCharge(chargers[c.id])) faults[c.id] = chargers[c.id].fault ?? "Can't charge now";
  const rows = active.map((planned) => {
    const truck = socFromTruck(telemetry[planned.vehicle_id], planned, now);
    const v = truck ? { ...planned, soc_start: Math.round(truck.soc_pct) } : planned;
    const veh = vehicles.find((x) => x.id === v.vehicle_id) ?? null;
    const ch = depot.chargers.find((c) => c.id === v.charger_id) ?? null;
    const battery = veh?.battery_kwh ?? null;
    const maxKw = ch && faults[ch.id] ? 0 : Math.min(ch?.max_kw ?? DEFAULT_TRUCK_KW, veh?.max_charge_kw ?? DEFAULT_TRUCK_KW);
    const needBattery = battery ? Math.max(0, ((v.soc_target - v.soc_start) / 100) * battery) : 0;
    return { v, veh, battery, maxKw, need: needBattery / EFFICIENCY, truck };
  });
  return { depot, now, slots, rows, chargers: depot.chargers.map((c) => ({ id: c.id, maxKw: faults[c.id] ? 0 : c.max_kw })), faults, headroom, carbonSource: carbon.source, price: prices.info };
}

/** Event windows applied to the slots: turn-down caps charging power, turn-up makes power cheaper
 *  (the payment per kWh), so the optimiser moves charging into it. */
export function applyEvents(slots: DepotPlan["slots"], events: Pick<FlexEvent, "start_at" | "end_at" | "direction" | "cap_kw" | "price_per_mwh">[]): DepotPlan["slots"] {
  return slots.map((s) => {
    let out = s;
    for (const e of events) {
      const a = Date.parse(e.start_at), b = Date.parse(e.end_at);
      if (!(s.start < b && s.end > a)) continue;
      if (e.direction === "down" && e.cap_kw != null) out = { ...out, headroomKw: Math.min(out.headroomKw, Math.max(0, e.cap_kw)) };
      if (e.direction === "up") out = { ...out, price: out.price - e.price_per_mwh / 1000 };
    }
    return out;
  });
}

/** Trucks that can give power back now: pilot trucks on bidirectional chargers, with the warranty confirmed. */
export function v2gPilots(i: PlanInputs): V2gVisit[] {
  const cfg = i.depot.v2g;
  if (!cfg?.enabled || !cfg.warranty_confirmed) return [];
  const out: V2gVisit[] = [];
  i.rows.forEach((r, index) => {
    const ch = i.depot.chargers.find((c) => c.id === r.v.charger_id);
    if (!ch?.bidirectional || !r.battery || !cfg.vehicle_ids.includes(r.v.vehicle_id)) return;
    out.push({ index, from: Math.max(i.now, new Date(r.v.arrive_at).getTime()), to: new Date(r.v.depart_at).getTime(), batteryKwh: r.battery, socStart: r.v.soc_start, maxChargeKw: r.maxKw, maxDischargeKw: Math.min(ch.max_kw, cfg.max_discharge_kw) });
  });
  return out;
}

export function planFromInputs(i: PlanInputs, events: FlexEvent[] = []): DepotPlan {
  const mine = events.filter((e) => e.depot_id === i.depot.id && e.status === "accepted");
  const slots = applyEvents(i.slots, mine);
  const plan = planDepot(slots, i.rows.map((r) => ({ id: r.v.id, chargerId: r.v.charger_id, from: Math.max(i.now, new Date(r.v.arrive_at).getTime()), to: new Date(r.v.depart_at).getTime(), needKwh: r.need, maxKw: r.maxKw })), i.chargers, i.depot.goal);
  const pilots = v2gPilots(i);
  plan.v2g = pilots.length ? v2gPass(plan, slots, pilots, i.depot.v2g, i.depot.site_load_kw) : null;
  // Report real prices (a turn-up incentive is income, not a cheaper tariff).
  const real = i.slots;
  const cost = plan.visits.reduce((a, v) => a + v.kw.reduce((b, kw, j) => b + kw * ((real[j].end - real[j].start) / 3_600_000) * real[j].price, 0), 0);
  plan.visits.forEach((v) => {
    v.cost = v.kw.reduce((b, kw, j) => b + kw * ((real[j].end - real[j].start) / 3_600_000) * real[j].price, 0);
    v.kg = v.kw.reduce((b, kw, j) => b + (real[j].carbon != null ? (kw * ((real[j].end - real[j].start) / 3_600_000) * real[j].carbon!) / 1000 : 0), 0);
  });
  const kg = plan.visits.reduce((a, v) => a + v.kg, 0);
  return { ...plan, slots: plan.slots.map((s, j) => ({ ...s, price: real[j].price })), cost, kg };
}

export function viewFromPlan(i: PlanInputs, plan: DepotPlan, events: FlexEvent[] = []): DepotPlanView {
  return {
    depot_id: i.depot.id,
    generated_at: new Date(i.now).toISOString(),
    slots: plan.slots,
    total_kw: plan.totalKw,
    visits: i.rows.map((r, j) => {
      const p = plan.visits[j];
      const socReady = r.battery ? Math.min(100, r.v.soc_start + ((p.deliveredKwh * EFFICIENCY) / r.battery) * 100) : r.v.soc_start;
      return {
        visit: r.v, plate: r.veh?.plate ?? "?", name: r.veh?.name ?? null, battery_kwh: r.battery, max_kw: r.maxKw,
        need_kwh: Math.round(r.need * 10) / 10, soc_ready: Math.round(socReady), plan: p, soc_from: r.truck,
        charger_fault: (r.v.charger_id && i.faults[r.v.charger_id]) || null,
        outcome: r.need <= 0.05 ? "idle" : p.shortfallKwh > 0 ? "short" : "ready",
      };
    }),
    cost: plan.cost, kg: plan.kg, peak_kw: plan.peakKw, headroom_kw: i.headroom, baseline: plan.baseline,
    carbon_source: i.carbonSource, price: i.price,
    v2g: plan.v2g ?? null,
    events: events.filter((e) => e.depot_id === i.depot.id && Date.parse(e.end_at) > i.now && (e.status === "accepted" || e.status === "offered")),
  };
}

export async function depotPlan(ctx: Ctx, depot: Depot, visits: DepotVisit[], vehicles: Vehicle[], events: FlexEvent[] = [], telemetry: Record<string, Telemetry> = {}, chargers: Record<string, ChargerNow> = {}): Promise<DepotPlanView> {
  const inputs = await depotInputs(ctx, depot, visits, vehicles, telemetry, chargers);
  return viewFromPlan(inputs, planFromInputs(inputs, events), events);
}

/** OCPP 2.0.1 SetChargingProfileRequest per charger with planned charging. */
export function chargingProfiles(depot: Depot, view: DepotPlanView): { charger: Depot["chargers"][number]; request: Record<string, unknown> }[] {
  if (!view.slots.length) return [];
  const start = view.slots[0].start;
  const end = view.slots[view.slots.length - 1].end;
  const out: { charger: Depot["chargers"][number]; request: Record<string, unknown> }[] = [];
  for (const ch of depot.chargers) {
    const kw = view.slots.map((_, j) => view.visits.filter((v) => v.visit.charger_id === ch.id).reduce((a, v) => a + (v.plan.kw[j] ?? 0), 0));
    const hasVisit = view.visits.some((v) => v.visit.charger_id === ch.id);
    if (!hasVisit) continue;
    // A stable id per charger so each new plan replaces the last one on the station.
    const profileId = 7000 + (Math.abs([...ch.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 2000);
    out.push({
      charger: ch,
      request: {
        evseId: ch.evse_id,
        chargingProfile: {
          id: profileId,
          stackLevel: 1,
          chargingProfilePurpose: "TxDefaultProfile",
          chargingProfileKind: "Absolute",
          validFrom: new Date(start).toISOString(),
          validTo: new Date(end).toISOString(),
          chargingSchedule: [{
            id: profileId,
            startSchedule: new Date(start).toISOString(),
            duration: Math.round((end - start) / 1000),
            chargingRateUnit: "W",
            // Giving power back (V2G) needs OCPP 2.1: a negative setpoint in CentralSetpoint mode.
            chargingSchedulePeriod: ch.bidirectional && kw.some((x) => x < -0.05)
              ? schedulePeriods(view.slots, kw, start).map((p) => (p.limit < 0 ? { startPeriod: p.startPeriod, limit: 0, operationMode: "CentralSetpoint", setpoint: p.limit } : { ...p, operationMode: "ChargingOnly" }))
              : schedulePeriods(view.slots, kw, start),
          }],
        },
      },
    });
  }
  return out;
}

/** What CitrineOS said when it took a command: [{ success, payload }] (or one object). */
function citrineConfirmation(body: unknown): { ok: boolean; message?: string } {
  const list = (Array.isArray(body) ? body : body && typeof body === "object" ? [body] : []) as { success?: unknown; payload?: unknown }[];
  const failed = list.find((c) => c && c.success === false);
  if (!failed) return { ok: true };
  const p = failed.payload;
  const text = typeof p === "string" ? p : p && typeof p === "object" ? String((p as { message?: unknown }).message ?? JSON.stringify(p)) : "";
  return { ok: false, message: text.slice(0, 160) || "it couldn't pass the plan to the charger" };
}

export async function dispatchDepot(ctx: Ctx, row: FleetEnergyRow, depot: Depot, view: DepotPlanView, by: DepotDispatch["by"]): Promise<DepotDispatch> {
  const profiles = chargingProfiles(depot, view);
  // One time for the whole plan: chargers' answers quote it.
  const at = iso(ctx.now());
  const c = depot.control;
  let results: ChargerDispatchResult[] = [];
  if (c.kind === "simulated") {
    results = profiles.map(({ charger, request }) => ({ charger_id: charger.id, ok: true, status: null, message: `Simulated: ${(request.chargingProfile as { chargingSchedule: { chargingSchedulePeriod: unknown[] }[] }).chargingSchedule[0].chargingSchedulePeriod.length} schedule steps` }));
  } else if (c.kind === "simulator") {
    results = await simulatorSend(ctx, row.fleet_id, depot, profiles, at);
  } else {
    const secret = row.secrets[depot.id] ? await openSecret(row.secrets[depot.id], ctx.env.DATA_ENCRYPTION_KEY, ctx.env.DATA_ENCRYPTION_KEY_PREVIOUS) : null;
    // Where the chargers' answers and status messages come back to (server/chargers.ts).
    const report = reportUrl(ctx, row.fleet_id, depot.id, (await hookToken(ctx, row.fleet_id, depot.id))!);
    if (c.kind === "citrineos") await subscribeStations(ctx, row.fleet_id, depot, report, secret ? { Authorization: `Bearer ${secret}` } : {});
    for (const { charger, request } of profiles) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const answer = answerUrl(report, charger.id, at);
      try {
        if (c.kind === "citrineos") {
          // Giving power back needs OCPP 2.1.
          const version = c.ocpp_version === "2.1" || JSON.stringify(request).includes("CentralSetpoint") ? "2.1" : "2.0.1";
          const url = `${c.base_url}/ocpp/${version}/smartcharging/setChargingProfile?identifier=${encodeURIComponent(charger.station_id)}&tenantId=${encodeURIComponent(c.tenant_id)}&callbackUrl=${encodeURIComponent(answer)}`;
          const res = await ctx.transport(new Request(url, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(request) }));
          const conf = res.ok ? citrineConfirmation(await res.json().catch(() => null)) : { ok: false, message: undefined };
          results.push(res.ok && conf.ok
            ? { charger_id: charger.id, ok: true, status: res.status, message: "Sent, waiting for the charger's answer", answer: "waiting" }
            : { charger_id: charger.id, ok: false, status: res.status, message: res.ok ? `CitrineOS: ${conf.message}` : `CitrineOS refused it (${res.status})` });
        } else {
          const body = JSON.stringify({ type: "ocpp.set_charging_profile", station_id: charger.station_id, depot_id: depot.id, charger_id: charger.id, sent_at: at, request, answer_url: answer, report_url: report });
          const res = await ctx.transport(new Request(c.url, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", ...(secret ? { "Depotcharge-Signature": await signature(secret, body, ctx.now()) } : {}) }, body }));
          results.push({ charger_id: charger.id, ok: res.ok, status: res.status, message: res.ok ? "Taken by the depot's system" : `Refused (${res.status})` });
        }
      } catch (e) {
        results.push({ charger_id: charger.id, ok: false, status: null, message: (e as Error).name === "AbortError" ? "No answer within 8 seconds" : "Couldn't reach the charging system" });
      } finally {
        clearTimeout(timer);
      }
    }
  }
  const d: DepotDispatch = { at, ok: results.every((r) => r.ok), by, results };
  // Write back only the dispatch, onto the latest row: settings saved meanwhile are kept.
  const fresh = (await ctx.store.getEnergy(row.fleet_id)) ?? row;
  const state: EnergyState = { ...(fresh.state ?? row.state), dispatch: { ...(fresh.state?.dispatch ?? {}), [depot.id]: d } };
  await ctx.store.saveEnergy({ ...fresh, state, updated_at: iso(ctx.now()) });
  row.state = state;
  return d;
}

/** Every 15 minutes (worker cron): re-plan and send schedules for depots set to dispatch automatically. */
export async function runDepotDispatch(ctx: Ctx): Promise<number> {
  let sent = 0;
  for (const row of await ctx.store.listEnergy()) {
    const auto = (row.config as EnergyConfig).depots.filter((d) => d.auto_dispatch && d.control.kind !== "simulated");
    if (!auto.length) continue;
    const [visits, vehicles, events] = await Promise.all([ctx.store.listDepotVisits(row.fleet_id, iso(ctx.now())), ctx.store.listVehicles(row.fleet_id), ctx.store.listFlexEvents(row.fleet_id, iso(ctx.now()))]);
    for (const depot of auto) {
      try {
        const [telemetry, chargers] = await Promise.all([fleetTelemetry(ctx, row.fleet_id, row), depotChargers(ctx, row.fleet_id, depot)]);
        const view = await depotPlan(ctx, depot, visits, vehicles, events, telemetry, chargers);
        await dispatchDepot(ctx, row, depot, view, "auto");
        sent++;
      } catch (e) {
        console.warn("depot dispatch failed", row.fleet_id, depot.id, e);
      }
    }
  }
  return sent;
}
