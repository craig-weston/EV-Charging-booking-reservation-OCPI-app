// Depot charging planner. Every truck at a depot needs a certain amount of energy between arriving
// and leaving; the site can only import so much at once; electricity costs (and emits) different
// amounts each half-hour. This is a transportation problem, solved exactly as a minimum-cost flow:
//
//   source → truck (energy needed) → charger × half-hour (charger power) → half-hour (site headroom) → sink
//
// Maximum flow first means every truck gets its energy whenever that's physically possible (the
// departure guarantee); among those plans, the cheapest (cost + carbon weight) is chosen. Trucks
// that can't be filled in time are flagged with their shortfall.

import { HALF_HOUR, floorHalfHour } from "./carbon";

export interface PlanSlot {
  start: number; // ms
  end: number;
  /** £/kWh. */
  price: number;
  /** g CO2/kWh, if known. */
  carbon: number | null;
  /** kW available for charging (import limit − other site load). */
  headroomKw: number;
}

export interface PlanVisit {
  id: string;
  chargerId: string | null;
  /** Earliest the truck can charge (arrival, or now). */
  from: number;
  /** Departure. */
  to: number;
  /** kWh needed from the grid (battery energy ÷ charging efficiency). */
  needKwh: number;
  /** Fastest the truck can charge on its charger, kW. */
  maxKw: number;
}

export interface ChargerCap { id: string; maxKw: number }

export interface VisitPlan {
  id: string;
  /** kW per slot index (same order as slots). */
  kw: number[];
  deliveredKwh: number;
  shortfallKwh: number;
  cost: number;
  kg: number;
  /** End of the last slot with any charging, or null. */
  readyAt: number | null;
}

export interface DepotPlan {
  /** Vehicle-to-grid pilot results, when the depot runs one. */
  v2g?: import("./v2g").V2gResult | null;
  slots: PlanSlot[];
  visits: VisitPlan[];
  totalKw: number[];
  cost: number;
  kg: number;
  peakKw: number;
  /** Same trucks charged the moment they arrive (still within the site limit). */
  baseline: { cost: number; kg: number; peakKw: number; shortfallKwh: number };
}

/** £ per kg CO2 used to trade carbon against cost for each goal. */
export const CARBON_WEIGHT = { cost: 0, balanced: 0.1, carbon: 2 } as const;

export function buildSlots(from: number, to: number, priceAt: (t: number) => number, carbonAt: (t: number) => number | null, headroomKw: number): PlanSlot[] {
  const out: PlanSlot[] = [];
  for (let s = floorHalfHour(from); s < to; s += HALF_HOUR) {
    const start = Math.max(s, from), end = Math.min(s + HALF_HOUR, to);
    if (end <= start) continue;
    const mid = (start + end) / 2;
    out.push({ start, end, price: priceAt(mid), carbon: carbonAt(mid), headroomKw: Math.max(0, headroomKw) });
  }
  return out;
}

// --- min-cost flow (successive shortest paths, Bellman–Ford on the residual graph) ----------------

interface Edge { to: number; rev: number; cap: number; cost: number }
class Graph {
  g: Edge[][];
  constructor(n: number) { this.g = Array.from({ length: n }, () => []); }
  add(u: number, v: number, cap: number, cost: number): [number, number] {
    this.g[u].push({ to: v, rev: this.g[v].length, cap, cost });
    this.g[v].push({ to: u, rev: this.g[u].length - 1, cap: 0, cost: -cost });
    return [u, this.g[u].length - 1];
  }
  run(s: number, t: number): void {
    const n = this.g.length, EPS = 1e-9;
    for (let iter = 0; iter < 20000; iter++) {
      const dist = new Array<number>(n).fill(Infinity), inq = new Array<boolean>(n).fill(false);
      const pv = new Array<number>(n).fill(-1), pe = new Array<number>(n).fill(-1);
      dist[s] = 0;
      const q = [s]; inq[s] = true;
      while (q.length) { // SPFA
        const u = q.shift()!; inq[u] = false;
        const eu = this.g[u];
        for (let i = 0; i < eu.length; i++) {
          const e = eu[i];
          if (e.cap > EPS && dist[u] + e.cost < dist[e.to] - 1e-12) {
            dist[e.to] = dist[u] + e.cost; pv[e.to] = u; pe[e.to] = i;
            if (!inq[e.to]) { q.push(e.to); inq[e.to] = true; }
          }
        }
      }
      if (dist[t] === Infinity) return;
      let f = Infinity;
      for (let v = t; v !== s; v = pv[v]) f = Math.min(f, this.g[pv[v]][pe[v]].cap);
      if (!(f > EPS)) return;
      for (let v = t; v !== s; v = pv[v]) {
        const e = this.g[pv[v]][pe[v]];
        e.cap -= f; this.g[v][e.rev].cap += f;
      }
    }
  }
}

export function planDepot(slots: PlanSlot[], visits: PlanVisit[], chargers: ChargerCap[], goal: keyof typeof CARBON_WEIGHT): DepotPlan {
  const S = slots.length, w = CARBON_WEIGHT[goal];
  const hours = slots.map((s) => (s.end - s.start) / 3_600_000);
  // Charger keys: real chargers, plus one virtual charger per unassigned truck.
  const chargerKeys = new Map<string, number>(); // key → max kW
  for (const c of chargers) chargerKeys.set(c.id, c.maxKw);
  for (const v of visits) if (!v.chargerId || !chargerKeys.has(v.chargerId)) chargerKeys.set(`v:${v.id}`, v.maxKw);
  const keyOf = (v: PlanVisit) => (v.chargerId && chargers.some((c) => c.id === v.chargerId) ? v.chargerId : `v:${v.id}`);
  const ckeys = [...chargerKeys.keys()];
  const cIndex = new Map(ckeys.map((k, i) => [k, i]));

  const SRC = 0, V0 = 1, CS0 = V0 + visits.length, SL0 = CS0 + ckeys.length * S, SNK = SL0 + S;
  const G = new Graph(SNK + 1);
  const unitCost = (j: number) => slots[j].price + (slots[j].carbon != null ? (w * slots[j].carbon!) / 1000 : 0) + j * 1e-7; // tiny: earlier wins ties
  const visitEdges: { v: number; j: number; edge: [number, number] }[] = [];
  visits.forEach((v, i) => {
    G.add(SRC, V0 + i, Math.max(0, v.needKwh), 0);
    const ci = cIndex.get(keyOf(v))!;
    for (let j = 0; j < S; j++) {
      const ov = Math.max(0, Math.min(v.to, slots[j].end) - Math.max(v.from, slots[j].start)) / 3_600_000;
      if (ov <= 0) continue;
      visitEdges.push({ v: i, j, edge: G.add(V0 + i, CS0 + ci * S + j, v.maxKw * ov, unitCost(j)) });
    }
  });
  ckeys.forEach((k, ci) => { for (let j = 0; j < S; j++) G.add(CS0 + ci * S + j, SL0 + j, chargerKeys.get(k)! * hours[j], 0); });
  for (let j = 0; j < S; j++) G.add(SL0 + j, SNK, slots[j].headroomKw * hours[j], 0);
  G.run(SRC, SNK);

  const out: VisitPlan[] = visits.map((v) => ({ id: v.id, kw: new Array<number>(S).fill(0), deliveredKwh: 0, shortfallKwh: 0, cost: 0, kg: 0, readyAt: null }));
  for (const { v, j, edge } of visitEdges) {
    const e = G.g[edge[0]][edge[1]];
    const flow = G.g[e.to][e.rev].cap; // reverse residual = flow sent
    if (flow <= 1e-6) continue;
    const p = out[v];
    p.kw[j] += flow / hours[j];
    p.deliveredKwh += flow;
    p.cost += flow * slots[j].price;
    p.kg += slots[j].carbon != null ? (flow * slots[j].carbon!) / 1000 : 0;
    p.readyAt = Math.max(p.readyAt ?? 0, slots[j].end);
  }
  visits.forEach((v, i) => { out[i].shortfallKwh = Math.max(0, v.needKwh - out[i].deliveredKwh); if (out[i].shortfallKwh < 0.05) out[i].shortfallKwh = 0; });
  const totalKw = slots.map((_, j) => out.reduce((a, p) => a + p.kw[j], 0));
  return {
    slots, visits: out, totalKw,
    cost: out.reduce((a, p) => a + p.cost, 0),
    kg: out.reduce((a, p) => a + p.kg, 0),
    peakKw: Math.max(0, ...totalKw),
    baseline: baselinePlan(slots, visits, chargers, keyOf),
  };
}

/** Plug in and charge at full power straight away, first come first served, within the limits. */
function baselinePlan(slots: PlanSlot[], visits: PlanVisit[], chargers: ChargerCap[], keyOf: (v: PlanVisit) => string) {
  const used = slots.map(() => 0);
  const chargerUsed = new Map<string, number[]>();
  const cmax = new Map(chargers.map((c) => [c.id, c.maxKw]));
  let cost = 0, kg = 0, short = 0;
  for (const v of [...visits].sort((a, b) => a.from - b.from)) {
    let need = v.needKwh;
    const k = keyOf(v);
    if (!chargerUsed.has(k)) chargerUsed.set(k, slots.map(() => 0));
    const cu = chargerUsed.get(k)!;
    for (let j = 0; j < slots.length && need > 1e-6; j++) {
      const ov = Math.max(0, Math.min(v.to, slots[j].end) - Math.max(v.from, slots[j].start)) / 3_600_000;
      if (ov <= 0) continue;
      const h = (slots[j].end - slots[j].start) / 3_600_000;
      const kw = Math.min(v.maxKw, (cmax.get(k) ?? v.maxKw) - cu[j], slots[j].headroomKw - used[j]);
      if (kw <= 0) continue;
      const e = Math.min(need, kw * ov);
      need -= e; used[j] += e / h; cu[j] += e / h;
      cost += e * slots[j].price; kg += slots[j].carbon != null ? (e * slots[j].carbon!) / 1000 : 0;
    }
    short += Math.max(0, need);
  }
  return { cost, kg, peakKw: Math.max(0, ...used), shortfallKwh: short };
}

/** Merge a per-slot kW series into OCPP schedule periods (seconds from start, watts). */
export function schedulePeriods(slots: PlanSlot[], kw: number[], start: number): { startPeriod: number; limit: number }[] {
  const out: { startPeriod: number; limit: number }[] = [];
  slots.forEach((s, j) => {
    const limit = Math.round((kw[j] ?? 0) * 1000 / 100) * 100; // 0.1 kW steps
    const startPeriod = Math.max(0, Math.round((s.start - start) / 1000));
    if (!out.length || out[out.length - 1].limit !== limit) out.push({ startPeriod, limit });
  });
  return out;
}
