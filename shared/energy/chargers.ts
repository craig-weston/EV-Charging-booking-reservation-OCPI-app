// What the chargers tell us back: their answer to each plan we send, and whether they can charge.
//
// Stations speak OCPP. Their messages reach us as OCPP-J frames ([2, id, action, payload]): from
// CitrineOS (its webhook subscriptions), from a depot operator's own system, or from the built-in
// charger simulator, which sends the same frames a real station would. See docs/chargers.md.

import { iso } from "../util";

export type ChargerState = "available" | "occupied" | "charging" | "faulted" | "unavailable" | "offline";

/** The connector state a station last reported (StatusNotification, or AvailabilityState). */
export interface ChargerStatus { state: ChargerState; at: string }
/** A problem the station reported or cleared (NotifyEvent Problem, or an OCPP 1.6 error code). */
export interface ChargerProblem { active: boolean; text?: string; at: string }
/** The charger's answer to a plan: `sent_at` is the plan it answers (DepotDispatch.at). */
export interface ChargerAnswer { answer: "accepted" | "rejected"; reason?: string; at: string; sent_at: string }
/** Whether the station is connected to the charging system (CitrineOS connect and close events). */
export interface StationLink { online: boolean; at: string }

/** One charger now, as shown and planned with. `state` null: nothing reported yet. */
export interface ChargerNow {
  state: ChargerState | null;
  /** When the charger last reported. */
  at: string | null;
  /** What's wrong, in plain words, when it's faulted or unavailable. */
  fault: string | null;
  answer: ChargerAnswer | null;
}

/** A charger that can't charge now: the plan gives it nothing until it reports it's back. */
export const cannotCharge = (c: Pick<ChargerNow, "state"> | null | undefined) => c?.state === "faulted" || c?.state === "unavailable";

/** The facts stored for a charger, combined. The newest report wins; a problem holds until cleared
 *  or until the station says the connector is usable again. */
export function chargerNow(f: { status?: ChargerStatus; problem?: ChargerProblem; answer?: ChargerAnswer }, link?: StationLink): ChargerNow {
  const { status, problem } = f;
  const answer = f.answer ?? null;
  const faultedByStatus = status?.state === "faulted";
  const problemHolds = !!problem?.active && (!status || problem.at >= status.at || faultedByStatus || status.state === "unavailable");
  const at = [status?.at, problem?.at, link?.at].filter((x): x is string => !!x).sort().pop() ?? null;
  if (problemHolds || faultedByStatus) return { state: "faulted", at, fault: (problem?.active && problem.text) || "The charger reported a fault", answer };
  if (link && !link.online && (!status || link.at >= status.at)) return { state: "offline", at, fault: null, answer };
  if (status?.state === "unavailable") return { state: "unavailable", at, fault: "Taken out of service", answer };
  return { state: status?.state ?? (link?.online ? "available" : null), at, fault: null, answer };
}

export interface OcppFrame { type: 2 | 3 | 4; id: string; action?: string; payload: Record<string, unknown> }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** An OCPP-J frame, from its JSON text or already parsed. */
export function parseFrame(raw: unknown): OcppFrame | null {
  let f: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 64_000) return null;
    try { f = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(f) || f.length < 3) return null;
  const id = String(f[1] ?? "").slice(0, 64);
  if (f[0] === 2 && typeof f[2] === "string") return { type: 2, id, action: f[2].slice(0, 64), payload: obj(f[3]) };
  if (f[0] === 3) return { type: 3, id, payload: obj(f[2]) };
  if (f[0] === 4) return { type: 4, id, payload: { errorCode: f[2], errorDescription: f[3] } };
  return null;
}

/** What a station said about one EVSE (`evse` null or 0: the whole station). */
export interface StationReport { evse: number | null; at: string; status?: ChargerState; problem?: { active: boolean; text?: string } }

// OCPP 1.6 StatusNotification error codes, in plain words.
const OCPP16_ERRORS: Record<string, string> = {
  ConnectorLockFailure: "Connector lock failed", EVCommunicationError: "Lost contact with the truck", GroundFailure: "Earth fault",
  HighTemperature: "Overheating", InternalError: "Internal error", LocalListConflict: "Card list conflict", OtherError: "Fault",
  OverCurrentFailure: "Over-current", OverVoltage: "Supply voltage too high", PowerMeterFailure: "Meter failed",
  PowerSwitchFailure: "Power switch failed", ReaderFailure: "Card reader failed", ResetFailure: "Reset failed", UnderVoltage: "Supply voltage too low",
};

/** OCPP 2.x connector status and 1.6 charge point status → ours. */
function stateOf(s: unknown): ChargerState | undefined {
  switch (String(s)) {
    case "Available": case "Reserved": return "available";
    case "Occupied": case "Preparing": case "SuspendedEV": case "SuspendedEVSE": case "Finishing": return "occupied";
    case "Charging": return "charging";
    case "Faulted": return "faulted";
    case "Unavailable": return "unavailable";
    default: return undefined;
  }
}

const when = (v: unknown, now: Date) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  // A station's clock can be off: never accept a time from the future.
  return iso(Number.isNaN(t) ? now.getTime() : Math.min(t, now.getTime() + 60_000));
};
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const text = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** StatusNotification and NotifyEvent (OCPP 2.0.1 and 2.1; StatusNotification from 1.6 too) →
 *  reports. Anything else → none. */
export function stationReports(action: string, p: Record<string, unknown>, now: Date): StationReport[] {
  if (action === "StatusNotification") {
    if ("connectorStatus" in p) return [{ evse: int(p.evseId), at: when(p.timestamp, now), status: stateOf(p.connectorStatus) }].filter((r) => r.status);
    // OCPP 1.6: connectors are numbered like EVSEs; 0 is the whole charge point.
    const status = stateOf(p.status);
    const code = String(p.errorCode ?? "NoError");
    const faulty = code !== "NoError" && code !== "WeakSignal";
    const problem = faulty ? { active: true, text: [OCPP16_ERRORS[code] ?? code, text(p.info, 80)].filter(Boolean).join(": ") } : status && status !== "faulted" ? { active: false } : undefined;
    return status || problem ? [{ evse: int(p.connectorId), at: when(p.timestamp, now), ...(status ? { status } : {}), ...(problem ? { problem } : {}) }] : [];
  }
  if (action === "NotifyEvent") {
    const out: StationReport[] = [];
    for (const raw of Array.isArray(p.eventData) ? p.eventData.slice(0, 50) : []) {
      const e = obj(raw);
      const component = obj(e.component), variable = obj(e.variable);
      const evse = int(obj(component.evse).id);
      const at = when(e.timestamp ?? p.generatedAt, now);
      const name = String(variable.name ?? "");
      const value = String(e.actualValue ?? "").toLowerCase();
      if (name === "Problem" || name === "Tripped" || name === "Overheated") {
        const active = value === "true" && e.cleared !== true;
        const label = text(e.techInfo) ?? text(e.techCode) ?? (name === "Problem" ? `${text(component.name, 40) ?? "Charger"} problem` : `${text(component.name, 40) ?? "Charger"} ${name.toLowerCase()}`);
        out.push({ evse, at, problem: active ? { active, text: label } : { active } });
      } else if (name === "AvailabilityState") {
        const status = stateOf(e.actualValue);
        if (status) out.push({ evse, at, status });
      }
    }
    return out;
  }
  return [];
}

/** A station's answer to SetChargingProfile ({ status, statusInfo }) → ours. */
export function profileAnswer(p: Record<string, unknown>): { answer: "accepted" | "rejected"; reason?: string } | null {
  const status = String(p.status ?? "");
  if (status !== "Accepted" && status !== "Rejected") return null;
  const info = obj(p.statusInfo);
  const reason = [text(info.reasonCode, 40), text(info.additionalInfo, 120)].filter(Boolean).join(": ");
  return { answer: status === "Accepted" ? "accepted" : "rejected", ...(reason ? { reason } : {}) };
}

/** How a charger checks a SetChargingProfile request before taking it (the simulator uses this,
 *  so a plan that a real charger would refuse is refused in the demo too). */
export function checkProfile(request: unknown, maxW: number): { status: "Accepted" | "Rejected"; reason?: string } {
  const r = obj(request);
  const profile = obj(r.chargingProfile);
  const schedule = obj(Array.isArray(profile.chargingSchedule) ? profile.chargingSchedule[0] : undefined);
  const periods = Array.isArray(schedule.chargingSchedulePeriod) ? schedule.chargingSchedulePeriod.map(obj) : [];
  const reject = (reason: string) => ({ status: "Rejected" as const, reason });
  if (!["TxDefaultProfile", "TxProfile", "ChargingStationMaxProfile"].includes(String(profile.chargingProfilePurpose))) return reject("UnsupportedPurpose");
  if (schedule.chargingRateUnit !== "W" && schedule.chargingRateUnit !== "A") return reject("UnsupportedRateUnit");
  if (!periods.length || periods[0].startPeriod !== 0) return reject("InvalidSchedule");
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    if (typeof p.startPeriod !== "number" || (i > 0 && !(p.startPeriod > (periods[i - 1].startPeriod as number)))) return reject("InvalidSchedule");
    if (typeof p.limit !== "number" || p.limit < 0) return reject("InvalidValue");
    if (schedule.chargingRateUnit === "W" && p.limit > maxW * 1.001) return reject("LimitTooHigh");
    if (typeof p.setpoint === "number" && p.operationMode !== "CentralSetpoint") return reject("InvalidValue");
  }
  if (typeof schedule.duration === "number" && schedule.duration <= 0) return reject("InvalidSchedule");
  return { status: "Accepted" };
}

/** The frames a station sends when it develops a fault: the simulator uses these. */
export function faultFrames(evseId: number, at: string, techInfo: string): unknown[] {
  return [
    [2, `sim-${at}-1`, "StatusNotification", { timestamp: at, connectorStatus: "Faulted", evseId, connectorId: 1 }],
    [2, `sim-${at}-2`, "NotifyEvent", {
      generatedAt: at, seqNo: 0,
      eventData: [{ eventId: 1, timestamp: at, trigger: "Delta", actualValue: "true", techCode: "RCD", techInfo, eventNotificationType: "HardWiredNotification", component: { name: "EVSE", evse: { id: evseId } }, variable: { name: "Problem" } }],
    }],
  ];
}
