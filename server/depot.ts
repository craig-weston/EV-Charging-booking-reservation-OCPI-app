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
import type { Ctx } from "./context";
import type { ChargerDispatchResult, DepotDispatch, EnergyState, FleetEnergyRow, Vehicle } from "../shared/model";
import { EMPTY_ENERGY, depotTariffAsOcpi, type Depot, type DepotVisit, type EnergyConfig } from "../shared/energy/depot";
import { energyPriceAt } from "../shared/energy/price";
import { intensityAt, HALF_HOUR, floorHalfHour, type CarbonSeries } from "../shared/energy/carbon";
import { buildSlots, planDepot, schedulePeriods, type DepotPlan } from "../shared/energy/optimise";
import { carbonFor } from "./energy";
import { openSecret } from "./security";
import { signature } from "./webhooks";
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
  price_source: "tariff" | "agile" | "agile-modelled";
}

// --- Octopus Agile (public, no key): half-hourly unit rates by region ---------------------------
const agileCache = new Map<string, { at: number; value: Promise<Map<number, number> | null> }>();
async function agilePrices(ctx: Ctx, product: string, region: string, from: number, to: number): Promise<Map<number, number> | null> {
  if (ctx.mode !== "live") return null;
  const key = `${product}|${region}|${floorHalfHour(from)}|${floorHalfHour(to)}`;
  const hit = agileCache.get(key);
  if (hit && ctx.now().getTime() - hit.at < 30 * 60_000) return hit.value;
  const value = (async () => {
    try {
      const url = `https://api.octopus.energy/v1/products/${encodeURIComponent(product)}/electricity-tariffs/E-1R-${encodeURIComponent(product)}-${region}/standard-unit-rates/?period_from=${new Date(from).toISOString()}&period_to=${new Date(to).toISOString()}&page_size=300`;
      const res = await ctx.transport(new Request(url, { headers: { Accept: "application/json" } }));
      if (!res.ok) return null;
      const j = (await res.json()) as { results?: { value_exc_vat: number; valid_from: string; valid_to: string | null }[] };
      const m = new Map<number, number>();
      for (const r of j.results ?? []) {
        const a = new Date(r.valid_from).getTime(), b = r.valid_to ? new Date(r.valid_to).getTime() : a + HALF_HOUR;
        for (let t = a; t < b; t += HALF_HOUR) m.set(t, r.value_exc_vat / 100);
      }
      return m.size ? m : null;
    } catch { return null; }
  })();
  agileCache.set(key, { at: ctx.now().getTime(), value });
  return value;
}

export async function depotPlan(ctx: Ctx, depot: Depot, visits: DepotVisit[], vehicles: Vehicle[]): Promise<DepotPlanView> {
  const now = ctx.now().getTime();
  const active = visits.filter((v) => v.depot_id === depot.id && (v.status === "planned" || v.status === "plugged_in") && new Date(v.depart_at).getTime() > now);
  const horizonEnd = Math.min(now + MAX_HORIZON_MS, Math.max(now + 12 * 3_600_000, ...active.map((v) => new Date(v.depart_at).getTime())));
  const carbon = await carbonFor(ctx, depot.postcode || null, new Date(now - HALF_HOUR).toISOString(), new Date(horizonEnd + HALF_HOUR).toISOString());
  const tariffs = depotTariffAsOcpi(depot.tariff);
  let priceSource: DepotPlanView["price_source"] = "tariff";
  let priceAt = (t: number) => energyPriceAt(tariffs, new Date(t)) ?? depot.tariff.standard;
  if (depot.tariff.kind === "agile") {
    const agile = await agilePrices(ctx, depot.tariff.agile_product ?? "AGILE-24-10-01", depot.tariff.agile_region ?? "B", now - HALF_HOUR, horizonEnd + HALF_HOUR);
    if (agile) {
      priceSource = "agile";
      priceAt = (t: number) => agile.get(floorHalfHour(t)) ?? depot.tariff.standard;
    } else {
      // No live prices (demo, or Octopus unreachable): a wholesale-shaped stand-in that tracks the
      // carbon forecast around the standard rate, labelled as modelled.
      priceSource = "agile-modelled";
      priceAt = (t: number) => Math.round(depot.tariff.standard * (0.45 + 0.9 * Math.min(1.6, (intensityAt(carbon, new Date(t)) ?? 130) / 160)) * 10000) / 10000;
    }
  }
  const headroom = Math.max(0, depot.import_limit_kw - depot.site_load_kw);
  const slots = buildSlots(now, horizonEnd, priceAt, (t) => intensityAt(carbon, new Date(t)), headroom);
  const chargers = depot.chargers.map((c) => ({ id: c.id, maxKw: c.max_kw }));
  const rows = active.map((v) => {
    const veh = vehicles.find((x) => x.id === v.vehicle_id) ?? null;
    const ch = depot.chargers.find((c) => c.id === v.charger_id) ?? null;
    const battery = veh?.battery_kwh ?? null;
    const maxKw = Math.min(ch?.max_kw ?? DEFAULT_TRUCK_KW, veh?.max_charge_kw ?? DEFAULT_TRUCK_KW);
    const needBattery = battery ? Math.max(0, ((v.soc_target - v.soc_start) / 100) * battery) : 0;
    return { v, veh, battery, maxKw, need: needBattery / EFFICIENCY };
  });
  const plan = planDepot(slots, rows.map((r) => ({ id: r.v.id, chargerId: r.v.charger_id, from: Math.max(now, new Date(r.v.arrive_at).getTime()), to: new Date(r.v.depart_at).getTime(), needKwh: r.need, maxKw: r.maxKw })), chargers, depot.goal);
  return {
    depot_id: depot.id,
    generated_at: iso(ctx.now()),
    slots: plan.slots,
    total_kw: plan.totalKw,
    visits: rows.map((r, i) => {
      const p = plan.visits[i];
      const socReady = r.battery ? Math.min(100, r.v.soc_start + ((p.deliveredKwh * EFFICIENCY) / r.battery) * 100) : r.v.soc_start;
      return {
        visit: r.v, plate: r.veh?.plate ?? "?", name: r.veh?.name ?? null, battery_kwh: r.battery, max_kw: r.maxKw,
        need_kwh: Math.round(r.need * 10) / 10, soc_ready: Math.round(socReady), plan: p,
        outcome: r.need <= 0.05 ? "idle" : p.shortfallKwh > 0 ? "short" : "ready",
      };
    }),
    cost: plan.cost, kg: plan.kg, peak_kw: plan.peakKw, headroom_kw: headroom, baseline: plan.baseline,
    carbon_source: carbon.source, price_source: priceSource,
  };
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
            chargingSchedulePeriod: schedulePeriods(view.slots, kw, start),
          }],
        },
      },
    });
  }
  return out;
}

export async function dispatchDepot(ctx: Ctx, row: FleetEnergyRow, depot: Depot, view: DepotPlanView, by: DepotDispatch["by"]): Promise<DepotDispatch> {
  const profiles = chargingProfiles(depot, view);
  const results: ChargerDispatchResult[] = [];
  const secret = row.secrets[depot.id] ? await openSecret(row.secrets[depot.id], ctx.env.DATA_ENCRYPTION_KEY, ctx.env.DATA_ENCRYPTION_KEY_PREVIOUS) : null;
  for (const { charger, request } of profiles) {
    const c = depot.control;
    if (c.kind === "simulated") {
      results.push({ charger_id: charger.id, ok: true, status: null, message: `Simulated: ${(request.chargingProfile as { chargingSchedule: { chargingSchedulePeriod: unknown[] }[] }).chargingSchedule[0].chargingSchedulePeriod.length} schedule steps` });
      continue;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      let res: Response;
      if (c.kind === "citrineos") {
        const url = `${c.base_url}/ocpp/2.0.1/smartcharging/setChargingProfile?identifier=${encodeURIComponent(charger.station_id)}&tenantId=${encodeURIComponent(c.tenant_id)}`;
        res = await ctx.transport(new Request(url, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(request) }));
      } else {
        const body = JSON.stringify({ type: "ocpp.set_charging_profile", station_id: charger.station_id, depot_id: depot.id, charger_id: charger.id, request });
        res = await ctx.transport(new Request(c.url, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", ...(secret ? { "Depotcharge-Signature": await signature(secret, body, ctx.now()) } : {}) }, body }));
      }
      results.push({ charger_id: charger.id, ok: res.ok, status: res.status, message: res.ok ? "Accepted by the charging system" : `Refused (${res.status})` });
    } catch (e) {
      results.push({ charger_id: charger.id, ok: false, status: null, message: (e as Error).name === "AbortError" ? "No answer within 8 seconds" : "Couldn't reach the charging system" });
    } finally {
      clearTimeout(timer);
    }
  }
  const d: DepotDispatch = { at: iso(ctx.now()), ok: results.every((r) => r.ok), by, results };
  const state: EnergyState = { ...row.state, dispatch: { ...(row.state?.dispatch ?? {}), [depot.id]: d } };
  await ctx.store.saveEnergy({ ...row, state, updated_at: iso(ctx.now()) });
  row.state = state;
  return d;
}

/** Every 15 minutes (worker cron): re-plan and send schedules for depots set to dispatch automatically. */
export async function runDepotDispatch(ctx: Ctx): Promise<number> {
  let sent = 0;
  for (const row of await ctx.store.listEnergy()) {
    const auto = (row.config as EnergyConfig).depots.filter((d) => d.auto_dispatch && d.control.kind !== "simulated");
    if (!auto.length) continue;
    const [visits, vehicles] = await Promise.all([ctx.store.listDepotVisits(row.fleet_id, iso(ctx.now())), ctx.store.listVehicles(row.fleet_id)]);
    for (const depot of auto) {
      try {
        const view = await depotPlan(ctx, depot, visits, vehicles);
        await dispatchDepot(ctx, row, depot, view, "auto");
        sent++;
      } catch (e) {
        console.warn("depot dispatch failed", row.fleet_id, depot.id, e);
      }
    }
  }
  return sent;
}
