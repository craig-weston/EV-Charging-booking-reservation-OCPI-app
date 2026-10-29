// Depot energy settings: a fleet's own sites, their chargers, grid connection limit, electricity
// tariff and how the chargers are controlled. Stored per fleet (fleet_energy.config).
import type { Tariff } from "../ocpi/types";
import { uuid } from "../util";
import { DEFAULT_DEPOT_FLEX, DEFAULT_PROVIDER, cleanDepotFlex, cleanProvider, type DepotFlex, type FlexProvider } from "./flex";

export type DepotGoal = "cost" | "balanced" | "carbon";

export interface DepotRate { price: number; start: string; end: string; days?: string[] }

export interface DepotTariff {
  /** flat: one rate; tou: timed rates over a standard rate; agile: Octopus Agile half-hourly prices. */
  kind: "flat" | "tou" | "agile";
  /** £/kWh ex VAT: the all-day rate (and the fallback for agile). */
  standard: number;
  rates: DepotRate[];
  /** Octopus Agile: product code and region letter (A–P). */
  agile_product?: string;
  agile_region?: string;
}

export interface DepotCharger {
  id: string;
  name: string;
  /** OCPP charging station identity (as the CSMS knows it). */
  station_id: string;
  /** OCPP EVSE id on that station. */
  evse_id: number;
  max_kw: number;
  /** Bidirectional (V2G) capable: the charger can export, if the truck can too. */
  bidirectional?: boolean;
}

export type DepotControl =
  | { kind: "simulated" }
  /** CitrineOS (open source CSMS): POST {base_url}/ocpp/2.0.1/smartcharging/setChargingProfile. */
  | { kind: "citrineos"; base_url: string; tenant_id: string; token_hint?: string }
  /** A depot operator's own system: we POST OCPP 2.0.1 SetChargingProfile requests, HMAC-signed. */
  | { kind: "webhook"; url: string; secret_hint?: string };

export interface Depot {
  id: string;
  name: string;
  postcode: string;
  /** Grid connection: maximum import, kW. */
  import_limit_kw: number;
  /** Other site load (lighting, warehouse, reefers) to keep headroom for, kW. */
  site_load_kw: number;
  tariff: DepotTariff;
  goal: DepotGoal;
  chargers: DepotCharger[];
  control: DepotControl;
  /** Re-plan and send schedules to the chargers automatically every 15 minutes. */
  auto_dispatch: boolean;
  /** Grid flexibility (turn down / turn up events). */
  flex: DepotFlex;
}

export interface EnergyConfig {
  depots: Depot[];
  /** Who sends grid flexibility events (an aggregator, or the simulator). */
  flex_provider: FlexProvider;
}

export type VisitStatus = "planned" | "plugged_in" | "done" | "cancelled";

/** A truck's stay at a depot: when it arrives and leaves, and the charge it needs. */
export interface DepotVisit {
  id: string;
  fleet_id: string;
  depot_id: string;
  vehicle_id: string;
  charger_id: string | null;
  arrive_at: string;
  depart_at: string;
  /** State of charge on arrival (or now, once known), %. */
  soc_start: number;
  /** Required at departure, %. */
  soc_target: number;
  status: VisitStatus;
  created_at: string;
  updated_at: string;
}

export const EMPTY_ENERGY: EnergyConfig = { depots: [], flex_provider: DEFAULT_PROVIDER };

export const DEFAULT_TARIFF: DepotTariff = { kind: "tou", standard: 0.26, rates: [{ price: 0.15, start: "00:30", end: "07:30" }] };

export function newDepot(name = "Main depot"): Depot {
  return {
    id: uuid(), name, postcode: "", import_limit_kw: 500, site_load_kw: 50, tariff: { ...DEFAULT_TARIFF, rates: [...DEFAULT_TARIFF.rates] },
    goal: "balanced", chargers: [], control: { kind: "simulated" }, auto_dispatch: false, flex: { ...DEFAULT_DEPOT_FLEX },
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate and normalise what the settings screen sends. Secrets are never part of the config. */
export function cleanEnergy(x: unknown): EnergyConfig {
  const depots = Array.isArray((x as EnergyConfig)?.depots) ? (x as EnergyConfig).depots : [];
  return {
    flex_provider: cleanProvider((x as EnergyConfig)?.flex_provider),
    depots: depots.slice(0, 20).map((d): Depot => {
      const t = (d?.tariff ?? {}) as Partial<DepotTariff>;
      const kind = t.kind === "flat" || t.kind === "agile" ? t.kind : "tou";
      const c = (d?.control ?? { kind: "simulated" }) as DepotControl;
      let control: DepotControl = { kind: "simulated" };
      if (c.kind === "citrineos" && /^https:\/\//.test(str(c.base_url, 300))) control = { kind: "citrineos", base_url: str(c.base_url, 300).replace(/\/+$/, ""), tenant_id: str(c.tenant_id, 40) || "1", ...(c.token_hint ? { token_hint: str(c.token_hint, 12) } : {}) };
      if (c.kind === "webhook" && /^https:\/\//.test(str(c.url, 300))) control = { kind: "webhook", url: str(c.url, 300), ...(c.secret_hint ? { secret_hint: str(c.secret_hint, 12) } : {}) };
      return {
        id: str(d?.id, 60) || uuid(),
        name: str(d?.name, 80) || "Depot",
        postcode: str(d?.postcode, 10).toUpperCase(),
        import_limit_kw: num(d?.import_limit_kw, 500, 1, 100_000),
        site_load_kw: num(d?.site_load_kw, 0, 0, 100_000),
        tariff: {
          kind,
          standard: num(t.standard, 0.26, 0, 5),
          rates: kind === "tou" ? (Array.isArray(t.rates) ? t.rates : []).slice(0, 8).filter((r) => HHMM.test(r?.start) && HHMM.test(r?.end)).map((r) => ({
            price: num(r.price, 0.15, -1, 5), start: r.start, end: r.end,
            ...(Array.isArray(r.days) && r.days.length ? { days: r.days.filter((x) => DAYS.includes(x)) } : {}),
          })) : [],
          ...(kind === "agile" ? { agile_product: str(t.agile_product, 40) || "AGILE-24-10-01", agile_region: /^[A-P]$/.test(str(t.agile_region, 1).toUpperCase()) ? str(t.agile_region, 1).toUpperCase() : "B" } : {}),
        },
        goal: d?.goal === "cost" || d?.goal === "carbon" ? d.goal : "balanced",
        chargers: (Array.isArray(d?.chargers) ? d.chargers : []).slice(0, 200).map((ch, i) => ({
          id: str(ch?.id, 60) || uuid(),
          name: str(ch?.name, 40) || `Charger ${i + 1}`,
          station_id: str(ch?.station_id, 60) || `CS${i + 1}`,
          evse_id: Math.round(num(ch?.evse_id, 1, 0, 99)),
          max_kw: num(ch?.max_kw, 150, 1, 3000),
          ...(ch?.bidirectional ? { bidirectional: true } : {}),
        })),
        control,
        auto_dispatch: d?.auto_dispatch === true,
        flex: cleanDepotFlex(d?.flex),
      };
    }),
  };
}

/** The depot tariff as OCPI-style tariff elements, so the same time-of-use pricing code applies. */
export function depotTariffAsOcpi(t: DepotTariff): Tariff[] {
  const elements: Tariff["elements"] = [
    ...(t.kind === "tou" ? t.rates.map((r) => ({ price_components: [{ type: "ENERGY" as const, price: r.price, step_size: 1 }], restrictions: { start_time: r.start, end_time: r.end, ...(r.days ? { day_of_week: r.days } : {}) } })) : []),
    { price_components: [{ type: "ENERGY", price: t.standard, step_size: 1 }] },
  ];
  return [{ country_code: "GB", party_id: "DPT", id: "depot", currency: "GBP", tax_included: "NO", elements, last_updated: "2026-01-01T00:00:00Z" } as Tariff];
}
