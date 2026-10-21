import type { AccessMethod, CanceledReason, ConnectorType, ReservationStatus, VehicleType } from "../ocpi/types";
import type { StartMethod } from "../model";

export const CONNECTOR_LABEL: Record<string, string> = {
  MCS: "MCS",
  IEC_62196_T2_COMBO: "CCS2",
  IEC_62196_T1_COMBO: "CCS1",
  CHADEMO: "CHAdeMO",
  IEC_62196_T2: "Type 2",
  IEC_62196_T1: "Type 1",
  GBT_DC: "GB/T DC",
  NACS: "NACS",
};
export const connectorLabel = (c: ConnectorType) => CONNECTOR_LABEL[c] ?? c.replace(/_/g, " ");

export const VEHICLE_TYPE_LABEL: Record<VehicleType, string> = {
  TRUCK_WITH_TRAILER: "Truck + trailer",
  SEMI_TRACTOR: "Tractor unit",
  RIGID: "Rigid",
  VAN: "Van",
  BUS: "Bus / coach",
  PERSONAL_VEHICLE: "Car",
  PERSONAL_VEHICLE_WITH_TRAILER: "Car + trailer",
  MOTORCYCLE: "Motorcycle",
  DISABLED: "Accessible bay",
};

export const START_METHOD_LABEL: Record<StartMethod, string> = {
  PLUG_AND_CHARGE: "Plug & Charge",
  AUTOCHARGE: "Autocharge",
};

export const ACCESS_LABEL: Record<AccessMethod, string> = {
  OPEN: "Open access",
  LICENSE_PLATE: "Number plate (ANPR)",
  TOKEN: "Booking token",
  ACCESS_CODE: "Access code",
  INTERCOM: "Intercom",
  PARKING_TICKET: "Parking ticket",
};

export const CANCEL_REASON_LABEL: Record<CanceledReason, string> = {
  POWER_OUTAGE: "Power outage at site",
  BROKEN_CHARGER: "Charger fault",
  FULL: "Site full, bay still occupied",
  BLOCKED: "Bay blocked",
  TRAFFIC: "Delayed by traffic",
  BROKEN_VEHICLE: "Vehicle breakdown",
  NO_CANCELED: "No reason given",
  UNKNOWN: "Unknown reason",
};

/** Reasons an eMSP (fleet) may give when cancelling. */
export const FLEET_CANCEL_REASONS: CanceledReason[] = ["TRAFFIC", "BROKEN_VEHICLE", "NO_CANCELED"];

export type StatusTone = "neutral" | "pending" | "ok" | "info" | "bad" | "muted";

export function statusView(status: ReservationStatus, opts: { sessionStatus?: string | null; pending?: boolean } = {}): {
  label: string; tone: StatusTone;
} {
  switch (status) {
    case "PENDING": return { label: "Pending", tone: "pending" };
    case "RESERVED": return opts.pending ? { label: "Change pending", tone: "pending" } : { label: "Reserved", tone: "ok" };
    case "FULFILLED":
      if (opts.sessionStatus === "COMPLETED") return { label: "Completed", tone: "neutral" };
      if (opts.sessionStatus === "ACTIVE") return { label: "Charging", tone: "info" };
      return { label: "Checked in", tone: "info" };
    case "CANCELED": return { label: "Cancelled", tone: "muted" };
    case "NO_SHOW": return { label: "No-show", tone: "bad" };
    case "REJECTED": return { label: "Rejected", tone: "bad" };
    case "FAILED": return { label: "Failed", tone: "bad" };
    default: return { label: "Unknown", tone: "muted" };
  }
}
