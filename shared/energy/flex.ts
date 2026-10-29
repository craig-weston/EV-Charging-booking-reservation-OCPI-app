// Grid flexibility: an aggregator (or the simulator) offers a depot an event — NESO's Demand
// Flexibility Service, a local network (DNO) constraint, or the Balancing Mechanism — to use less
// power (turn down) or more (turn up) for a while. We commit only what the depot can do without any
// truck leaving short, plan around it, and credit the fleet's share of the payment on its statement.
import { iso } from "../util";

export type FlexProgramme = "DFS" | "DNO" | "BM";
export type FlexDirection = "down" | "up";
export type FlexStatus = "offered" | "accepted" | "declined" | "delivered" | "settled" | "cancelled";

export const PROGRAMME_LABEL: Record<FlexProgramme, string> = {
  DFS: "NESO Demand Flexibility Service",
  DNO: "Local network (DNO) flexibility",
  BM: "Balancing Mechanism",
};

export interface FlexEvent {
  id: string;
  fleet_id: string;
  depot_id: string;
  /** The aggregator's own id for the event, for reports and settlement. */
  provider_event_id: string | null;
  programme: FlexProgramme;
  direction: FlexDirection;
  start_at: string;
  end_at: string;
  /** Utilisation payment, £ per MWh shifted. */
  price_per_mwh: number;
  /** What the aggregator asked for, kW (optional). */
  requested_kw: number | null;
  status: FlexStatus;
  /** Why it was declined, or other notes. */
  reason: string | null;
  /** kW we committed to reduce (down) or add (up) on average over the window. */
  committed_kw: number | null;
  /** Turn-down: maximum charging power during the window, kW. */
  cap_kw: number | null;
  /** Planned charging during the window before the event, kW average. */
  baseline_kw: number | null;
  delivered_kwh: number | null;
  /** Total paid for the event (estimated until settled). */
  payment_gbp: number | null;
  fleet_share_pct: number | null;
  fleet_credit_gbp: number | null;
  /** Payment is our estimate; the aggregator's settlement replaces it. */
  estimated: boolean;
  decided_by: string | null;
  source: "simulated" | "aggregator";
  created_at: string;
  updated_at: string;
}

/** Per depot: whether it takes part and how. */
export interface DepotFlex {
  enabled: boolean;
  programmes: FlexProgramme[];
  /** Accept events automatically when the depot can deliver them. */
  auto_accept: boolean;
  /** Don't take events paying less than this, £/MWh. */
  min_price_mwh: number;
}

/** Per fleet: who sends the events. */
export interface FlexProvider {
  kind: "simulated" | "aggregator";
  name: string;
  /** Where commitments and delivery reports are posted (signed). */
  report_url: string | null;
  secret_hint?: string;
}

export const DEFAULT_DEPOT_FLEX: DepotFlex = { enabled: false, programmes: ["DFS", "DNO"], auto_accept: true, min_price_mwh: 100 };
export const DEFAULT_PROVIDER: FlexProvider = { kind: "simulated", name: "Simulated aggregator", report_url: null };

/** Smallest commitment worth offering, kW. */
export const MIN_COMMIT_KW = 10;

export function cleanDepotFlex(x: Partial<DepotFlex> | null | undefined): DepotFlex {
  const progs = Array.isArray(x?.programmes) ? x!.programmes.filter((p): p is FlexProgramme => p === "DFS" || p === "DNO" || p === "BM") : DEFAULT_DEPOT_FLEX.programmes;
  const min = Number(x?.min_price_mwh);
  return {
    enabled: x?.enabled === true,
    programmes: [...new Set(progs)],
    auto_accept: x?.auto_accept !== false,
    min_price_mwh: Number.isFinite(min) ? Math.min(100_000, Math.max(0, min)) : DEFAULT_DEPOT_FLEX.min_price_mwh,
  };
}

export function cleanProvider(x: Partial<FlexProvider> | null | undefined): FlexProvider {
  const url = typeof x?.report_url === "string" && /^https:\/\//.test(x.report_url.trim()) ? x.report_url.trim().slice(0, 300) : null;
  return {
    kind: x?.kind === "aggregator" ? "aggregator" : "simulated",
    name: (typeof x?.name === "string" && x.name.trim() ? x.name.trim() : x?.kind === "aggregator" ? "Aggregator" : DEFAULT_PROVIDER.name).slice(0, 60),
    report_url: x?.kind === "aggregator" ? url : null,
    ...(x?.secret_hint ? { secret_hint: String(x.secret_hint).slice(0, 12) } : {}),
  };
}

export const hoursOf = (e: Pick<FlexEvent, "start_at" | "end_at">) => (Date.parse(e.end_at) - Date.parse(e.start_at)) / 3_600_000;

/** Payment for an amount shifted, and the fleet's share of it. */
export function flexPayment(kwh: number, pricePerMwh: number, sharePct: number): { payment: number; credit: number } {
  const payment = Math.round((kwh / 1000) * pricePerMwh * 100) / 100;
  return { payment, credit: Math.round(payment * (sharePct / 100) * 100) / 100 };
}

/** A new event as it arrives (from an aggregator or the simulator), before we decide. */
export function newEvent(p: { id: string; fleet_id: string; depot_id: string; provider_event_id: string | null; programme: FlexProgramme; direction: FlexDirection; start_at: string; end_at: string; price_per_mwh: number; requested_kw: number | null; source: FlexEvent["source"] }, now: Date): FlexEvent {
  return {
    ...p, status: "offered", reason: null, committed_kw: null, cap_kw: null, baseline_kw: null, delivered_kwh: null,
    payment_gbp: null, fleet_share_pct: null, fleet_credit_gbp: null, estimated: true, decided_by: null,
    created_at: iso(now), updated_at: iso(now),
  };
}
