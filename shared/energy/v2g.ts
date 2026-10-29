// Vehicle-to-grid pilot: a truck parked on a bidirectional charger can give power back at expensive
// times and recharge later at cheaper ones, as long as it never drops below a minimum charge, still
// leaves with the charge it needs, and (without export approval) only offsets the site's own load.
//
// Runs after the charging plan: repeatedly finds the most valuable pair (give back in slot d,
// recharge in a later slot c) and moves a small chunk of energy, until no pair beats battery wear.
import type { DepotPlan, PlanSlot } from "./optimise";

export interface V2gPilot {
  enabled: boolean;
  /** Trucks taking part (their maker has confirmed bidirectional use is covered by the warranty). */
  vehicle_ids: string[];
  /** Never go below this charge, %. */
  min_soc: number;
  /** Most power to give back per truck, kW. */
  max_discharge_kw: number;
  /** behind_meter: only offset the site's own load (no export). export: G99-approved export up to export_limit_kw. */
  mode: "behind_meter" | "export";
  export_limit_kw: number;
  /** Battery wear, £ per kWh cycled through the battery. */
  wear_per_kwh: number;
  /** The truck maker has confirmed in writing that bidirectional use is covered. */
  warranty_confirmed: boolean;
}

export const DEFAULT_V2G: V2gPilot = { enabled: false, vehicle_ids: [], min_soc: 35, max_discharge_kw: 100, mode: "behind_meter", export_limit_kw: 0, wear_per_kwh: 0.06, warranty_confirmed: false };

export function cleanV2g(x: Partial<V2gPilot> | null | undefined): V2gPilot {
  const n = (v: unknown, d: number, lo: number, hi: number) => { const k = Number(v); return Number.isFinite(k) ? Math.min(hi, Math.max(lo, k)) : d; };
  return {
    enabled: x?.enabled === true,
    vehicle_ids: Array.isArray(x?.vehicle_ids) ? x!.vehicle_ids.filter((s) => typeof s === "string").slice(0, 10) : [],
    min_soc: n(x?.min_soc, DEFAULT_V2G.min_soc, 10, 90),
    max_discharge_kw: n(x?.max_discharge_kw, DEFAULT_V2G.max_discharge_kw, 1, 1000),
    mode: x?.mode === "export" ? "export" : "behind_meter",
    export_limit_kw: n(x?.export_limit_kw, 0, 0, 10_000),
    wear_per_kwh: n(x?.wear_per_kwh, DEFAULT_V2G.wear_per_kwh, 0, 1),
    warranty_confirmed: x?.warranty_confirmed === true,
  };
}

export interface V2gVisit {
  index: number; // into plan.visits
  from: number;
  to: number;
  batteryKwh: number;
  socStart: number; // %
  maxChargeKw: number;
  maxDischargeKw: number;
}

export interface V2gResult {
  /** Energy given back, at the grid side, kWh. */
  dischargedKwh: number;
  /** Extra energy bought to recharge it, kWh. */
  rechargedKwh: number;
  /** Value of the power given back (avoided import / export) minus the cost of recharging, £. */
  arbitrage: number;
  /** Battery wear at wear_per_kwh, £. */
  wear: number;
  net: number;
  /** Lowest charge any pilot truck reaches, %. */
  minSocReached: number | null;
}

const EFF = 0.93; // each way

/**
 * Adds give-back (negative kW) to pilot trucks' plans in place, keeping every constraint.
 * `siteLoadKw` is the other site load (behind-the-meter discharge can offset it and other trucks' charging).
 */
export function v2gPass(plan: DepotPlan, slots: PlanSlot[], pilots: V2gVisit[], cfg: V2gPilot, siteLoadKw: number): V2gResult {
  const S = slots.length;
  const hours = slots.map((s) => (s.end - s.start) / 3_600_000);
  const total = () => slots.map((_, j) => plan.visits.reduce((a, v) => a + v.kw[j], 0));
  let dis = 0, rec = 0, arb = 0, wear = 0;
  const CHUNK = 10; // kWh of battery energy per step
  for (let iter = 0; iter < 600; iter++) {
    const tot = total();
    let best: { p: V2gVisit; d: number; c: number; value: number; e: number } | null = null;
    for (const p of pilots) {
      const kw = plan.visits[p.index].kw;
      const cap = p.batteryKwh;
      // Battery energy at the start of each slot.
      const soc: number[] = [];
      let e = (p.socStart / 100) * cap;
      for (let j = 0; j < S; j++) { soc.push(e); e += kw[j] >= 0 ? kw[j] * hours[j] * EFF : (kw[j] * hours[j]) / EFF; }
      soc.push(e);
      const minE = (cfg.min_soc / 100) * cap;
      for (let d = 0; d < S; d++) {
        const sd = slots[d];
        if (sd.start < p.from || sd.end > p.to || kw[d] > 0) continue;
        const roomKw = Math.min(p.maxDischargeKw - Math.max(0, -kw[d]), cfg.max_discharge_kw - Math.max(0, -kw[d]));
        const siteRoom = (cfg.mode === "export" ? cfg.export_limit_kw : 0) + siteLoadKw + tot[d]; // net import must stay ≥ −export
        const kwRoom = Math.min(roomKw, siteRoom);
        if (kwRoom <= 0.5) continue;
        for (let c = d + 1; c < S; c++) {
          const sc = slots[c];
          if (sc.start < p.from || sc.end > p.to || kw[c] < 0) continue;
          const chargeRoom = Math.min(p.maxChargeKw - kw[c], sc.headroomKw - tot[c]);
          if (chargeRoom <= 0.5) continue;
          // Per kWh moved through the battery: give back e·EFF at price_d, buy e/EFF at price_c, wear on e.
          const value = sd.price * EFF - sc.price / EFF - cfg.wear_per_kwh;
          if (value <= 0.005 || (best && value <= best.value)) continue;
          // Room in battery energy terms, and the lowest charge between d and c.
          let lowest = Infinity;
          for (let j = d + 1; j <= c; j++) lowest = Math.min(lowest, soc[j]);
          const eRoom = Math.min(kwRoom * hours[d] / EFF, chargeRoom * hours[c] * EFF, lowest - minE, CHUNK);
          if (eRoom <= 0.2) continue;
          best = { p, d, c, value, e: eRoom };
        }
      }
    }
    if (!best) break;
    const v = plan.visits[best.p.index];
    const outKwh = best.e * EFF, inKwh = best.e / EFF;
    v.kw[best.d] -= outKwh / hours[best.d];
    v.kw[best.c] += inKwh / hours[best.c];
    dis += outKwh; rec += inKwh;
    arb += outKwh * slots[best.d].price - inKwh * slots[best.c].price;
    wear += best.e * cfg.wear_per_kwh;
  }
  // Lowest state of charge reached by any pilot truck.
  let minSoc: number | null = null;
  for (const p of pilots) {
    const kw = plan.visits[p.index].kw;
    let e = (p.socStart / 100) * p.batteryKwh;
    for (let j = 0; j < S; j++) {
      e += kw[j] >= 0 ? kw[j] * hours[j] * EFF : (kw[j] * hours[j]) / EFF;
      if (slots[j].end > p.from) minSoc = Math.min(minSoc ?? 100, (e / p.batteryKwh) * 100);
    }
  }
  const t = total();
  plan.totalKw = t;
  plan.peakKw = Math.max(0, ...t);
  return { dischargedKwh: dis, rechargedKwh: rec, arbitrage: arb, wear, net: arb - wear, minSocReached: minSoc };
}
