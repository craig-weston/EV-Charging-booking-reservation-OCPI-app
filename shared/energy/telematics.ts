// Battery levels from the trucks themselves, so nobody types them into the depot plan.
//
// Two ways in:
// - rFMS, the truck makers' standard fleet API (Volvo Connect, MAN RIO and others): polled every
//   15 minutes. Electric trucks report remaining battery charge, range and charging status.
// - A push endpoint any telematics system can call: POST /api/fleets/{id}/telemetry.
// The latest reading per truck is kept; the depot plan uses it for trucks that are at the depot or
// about to arrive. See docs/telematics.md.

export interface Telemetry {
  /** Battery state of charge, %. */
  soc_pct: number;
  range_km?: number;
  charging?: "charging" | "connected" | "idle" | "error";
  lat?: number;
  lon?: number;
  /** When the truck measured it. */
  at: string;
  source: "rfms" | "api" | "simulated";
}

export interface RfmsSettings {
  /** e.g. https://api.volvotrucks.com/rfms (the address before /vehiclestatuses). */
  base_url: string;
  auth: "basic" | "oauth2";
  /** Basic: the user name. OAuth2: the client id. */
  username: string;
  /** OAuth2 only: where to get an access token (client credentials). */
  token_url?: string;
  /** Truck VIN by vehicle id. */
  vins: Record<string, string>;
  /** Last characters of the stored password or client secret, to show it's set. */
  secret_hint?: string;
}

export interface TelematicsConfig {
  kind: "none" | "rfms" | "simulated";
  rfms?: RfmsSettings;
}

/** How old a reading can be and still count as the truck's current charge. */
export const FRESH_MS = 3 * 3_600_000;
/** A reading is used for a visit once the truck is due within this long. */
export const ARRIVING_MS = 30 * 60_000;

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const VIN = /^[A-HJ-NPR-Z0-9]{11,17}$/;
export const plateKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function cleanTelematics(x: unknown): TelematicsConfig {
  const t = (x ?? {}) as Partial<TelematicsConfig>;
  if (t.kind === "simulated") return { kind: "simulated" };
  const r = (t.rfms ?? {}) as Partial<RfmsSettings>;
  const base = str(r.base_url, 300).replace(/\/+$/, "").replace(/\/vehiclestatuses$/i, "");
  if (t.kind !== "rfms" || !/^https:\/\//.test(base)) return { kind: "none" };
  const vins: Record<string, string> = {};
  for (const [id, vin] of Object.entries(r.vins ?? {}).slice(0, 500)) {
    const v = str(vin, 17).toUpperCase();
    if (str(id, 60) && VIN.test(v)) vins[str(id, 60)] = v;
  }
  const auth = r.auth === "oauth2" ? "oauth2" : "basic";
  const token = str(r.token_url, 300);
  return {
    kind: "rfms",
    rfms: {
      base_url: base, auth, username: str(r.username, 120), vins,
      ...(auth === "oauth2" && /^https:\/\//.test(token) ? { token_url: token } : {}),
      ...(r.secret_hint ? { secret_hint: str(r.secret_hint, 12) } : {}),
    },
  };
}

/** One reading sent to the push API, checked. */
export function cleanReading(x: unknown, now: Date, source: Telemetry["source"] = "api"): Telemetry | null {
  const r = (x ?? {}) as Record<string, unknown>;
  const soc = num(r.soc_pct ?? r.soc);
  if (soc == null || soc < 0 || soc > 100) return null;
  const at = r.at ? new Date(String(r.at)) : now;
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + 5 * 60_000) return null; // no future readings
  const range = num(r.range_km), lat = num(r.lat), lon = num(r.lon);
  const charging = ["charging", "connected", "idle", "error"].includes(String(r.charging)) ? (r.charging as Telemetry["charging"]) : undefined;
  return {
    soc_pct: Math.round(soc * 10) / 10, at: at.toISOString(), source,
    ...(range != null && range >= 0 && range < 5000 ? { range_km: Math.round(range) } : {}),
    ...(charging ? { charging } : {}),
    ...(lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : {}),
  };
}

/** rFMS charging status → ours. */
function rfmsCharging(v: unknown, conn: unknown): Telemetry["charging"] | undefined {
  const s = String(v ?? "").toUpperCase(), c = String(conn ?? "").toUpperCase();
  if (s.startsWith("CHARGING")) return "charging";
  if (s === "ERROR" || c === "ERROR") return "error";
  if (c === "CONNECTED" || c === "CONNECTING") return "connected";
  if (s === "NOT_CHARGING" || c === "DISCONNECTED") return "idle";
  return undefined;
}

/** GET /vehiclestatuses (rFMS 2.1 and 4.0; tolerant of makers' small differences) → readings by
 *  VIN. Trucks that don't report a battery level (diesel) are skipped. */
export function parseRfmsStatuses(body: unknown): { vin: string; t: Telemetry }[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const list = (((root.vehicleStatusResponse as Record<string, unknown> | undefined)?.vehicleStatuses ?? root.vehicleStatuses ?? []) as unknown[]);
  const latest = new Map<string, { vin: string; t: Telemetry }>();
  for (const item of Array.isArray(list) ? list : []) {
    const v = (item ?? {}) as Record<string, unknown>;
    const vin = str(v.vin, 17).toUpperCase();
    const snap = (v.snapshotData ?? {}) as Record<string, unknown>;
    const volvo = (snap.volvoGroupSnapshot ?? {}) as Record<string, unknown>;
    const soc = num(snap.hybridBatteryPackRemainingCharge ?? snap.batteryPackRemainingCharge ?? snap.batteryPackRemainingChargePercent ?? snap.batteryPackRemainingChargePercentage ?? volvo.hybridBatteryPackRemainingCharge);
    const at = new Date(str(v.createdDateTime, 40) || str(v.receivedDateTime, 40));
    if (!vin || soc == null || soc < 0 || soc > 100 || Number.isNaN(at.getTime())) continue;
    // Distance to empty: metres; rFMS 4 nests it per energy source in some implementations.
    const dte = snap.estimatedDistanceToEmpty;
    const metres = typeof dte === "object" && dte ? num((dte as Record<string, unknown>).batteryPack ?? (dte as Record<string, unknown>).total) : num(dte);
    const gnss = (snap.gnssPosition ?? snap) as Record<string, unknown>;
    const lat = num(gnss.latitude), lon = num(gnss.longitude);
    const charging = rfmsCharging(snap.batteryPackChargingStatus, snap.batteryPackChargingConnectionStatus);
    const t: Telemetry = {
      soc_pct: Math.round(soc * 10) / 10, at: at.toISOString(), source: "rfms",
      ...(metres != null && metres >= 0 ? { range_km: Math.round(metres / 1000) } : {}),
      ...(charging ? { charging } : {}),
      ...(lat != null && lon != null ? { lat, lon } : {}),
    };
    const prev = latest.get(vin);
    if (!prev || prev.t.at < t.at) latest.set(vin, { vin, t });
  }
  return [...latest.values()];
}

/** Newer readings replace older ones, truck by truck. */
export function mergeTelemetry(cur: Record<string, Telemetry> | undefined, add: Record<string, Telemetry>): Record<string, Telemetry> {
  const out = { ...(cur ?? {}) };
  for (const [id, t] of Object.entries(add)) if (!out[id] || out[id].at <= t.at) out[id] = t;
  return out;
}

/** The truck's own reading to plan a visit with, if it's recent and the truck is here or due. */
export function socFromTruck(t: Telemetry | undefined, visit: { arrive_at: string; status: string }, now: number): Telemetry | null {
  if (!t) return null;
  const at = Date.parse(t.at);
  if (!(now - at <= FRESH_MS)) return null;
  const here = visit.status === "plugged_in" || Date.parse(visit.arrive_at) <= now + ARRIVING_MS;
  return here ? t : null;
}
