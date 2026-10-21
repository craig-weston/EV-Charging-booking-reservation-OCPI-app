// Can this vehicle use this bookable option — and can the driver just turn up?
//
// "Zero-touch" means: the site opens for the number plate (ANPR, AccessMethod LICENSE_PLATE or OPEN),
// no RFID card is needed (BookingTerms.rfid_auth_required), and a charger at the option supports the
// vehicle's start method (ConnectorCapability ISO_15118_*_PLUG_AND_CHARGE, or the AUTOCHARGE extension).
import type { BookingLocation, Connector, ConnectorType, EVSE, Location } from "../ocpi/types";
import { NOT_AVAILABLE } from "../ocpi/types";
import type { StartMethod, Vehicle } from "../model";
import { VEHICLE_TYPE_LABEL, connectorLabel } from "./labels";

export type IssueLevel = "block" | "touch" | "warn";
export interface Issue {
  level: IssueLevel;
  code: string;
  text: string;
}

export interface OptionSpec {
  connectorTypes: ConnectorType[];
  maxKw: number | null;
  kwByType: Partial<Record<ConnectorType, number>>;
  evses: EVSE[];
  autoStart: StartMethod[];
  plateAccess: boolean;
  rfidRequired: boolean;
}

const PNC: string[] = ["ISO_15118_2_PLUG_AND_CHARGE", "ISO_15118_20_PLUG_AND_CHARGE"];

function connectorKw(c: Connector): number {
  if (c.max_electric_power) return c.max_electric_power / 1000;
  return (c.max_voltage * c.max_amperage) / 1000;
}

/** The EVSEs a BookingLocation can put the driver on. */
export function optionEvses(bl: BookingLocation, loc: Location | null | undefined): EVSE[] {
  const evses = (loc?.evses ?? []).filter((e) => e.status !== "REMOVED");
  const opt = bl.booking_option;
  if (opt?.evse_uid && opt.evse_uid !== NOT_AVAILABLE) return evses.filter((e) => e.uid === opt.evse_uid);
  const types = opt?.connector_types ?? [];
  const byType = types.length ? evses.filter((e) => e.connectors.some((c) => types.includes(c.standard))) : evses;
  // A parking place narrows it further (e.g. rigid bays vs. artic bays with the same connector),
  // when the CPO links EVSEs to parking places at all.
  if (opt?.parking_id && opt.parking_id !== NOT_AVAILABLE) {
    const inBay = byType.filter((e) => e.parking?.some((p) => p.parking_id === opt.parking_id));
    if (inBay.length) return inBay;
  }
  return byType;
}

export function describeOption(bl: BookingLocation, loc: Location | null | undefined): OptionSpec {
  const evses = optionEvses(bl, loc);
  const opt = bl.booking_option ?? {};
  const connectors = evses.flatMap((e) => e.connectors).filter((c) => !opt.connector_types?.length || opt.connector_types.includes(c.standard));
  const connectorTypes = [...new Set([...(opt.connector_types ?? []), ...connectors.map((c) => c.standard)])];
  const maxKw = connectors.length ? Math.max(...connectors.map(connectorKw)) : null;
  const kwByType: Partial<Record<ConnectorType, number>> = {};
  for (const c of connectors) kwByType[c.standard] = Math.max(kwByType[c.standard] ?? 0, connectorKw(c));
  const caps = new Set(connectors.flatMap((c) => c.capabilities ?? []));
  const autoStart: StartMethod[] = [];
  if (PNC.some((p) => caps.has(p))) autoStart.push("PLUG_AND_CHARGE");
  if (caps.has("AUTOCHARGE")) autoStart.push("AUTOCHARGE");
  const methods = bl.booking_terms?.supported_access_methods ?? [];
  return {
    connectorTypes,
    maxKw,
    kwByType,
    evses,
    autoStart,
    plateAccess: methods.includes("LICENSE_PLATE") || methods.includes("OPEN"),
    rfidRequired: bl.booking_terms?.rfid_auth_required === true,
  };
}

export interface Assessment {
  ok: boolean; // no blocking issues
  zeroTouch: boolean;
  issues: Issue[];
  spec: OptionSpec;
  connector: ConnectorType | null; // best shared connector
  usableKw: number | null; // min(charger, vehicle)
}

const cm = (n: number) => `${Number((n / 100).toFixed(2))} m`;
const kg = (n: number) => `${Math.round(n / 1000)} t`;

export function assess(vehicle: Vehicle, bl: BookingLocation, loc: Location | null | undefined): Assessment {
  const spec = describeOption(bl, loc);
  const opt = bl.booking_option ?? {};
  const issues: Issue[] = [];
  const block = (code: string, text: string) => issues.push({ level: "block", code, text });

  if (opt.vehicle_types?.length && !opt.vehicle_types.includes(vehicle.vehicle_type)) {
    block("vehicle_type", `Bay not designed for ${VEHICLE_TYPE_LABEL[vehicle.vehicle_type].toLowerCase()}`);
  }
  if (opt.max_vehicle_weight && vehicle.gross_weight_kg && vehicle.gross_weight_kg > opt.max_vehicle_weight) {
    block("weight", `Weight limit ${kg(opt.max_vehicle_weight)} (vehicle ${kg(vehicle.gross_weight_kg)})`);
  }
  if (opt.max_vehicle_height && vehicle.height_cm && vehicle.height_cm > opt.max_vehicle_height) {
    block("height", `Height limit ${cm(opt.max_vehicle_height)} (vehicle ${cm(vehicle.height_cm)})`);
  }
  const lengthLimit = Math.min(opt.max_vehicle_length ?? Infinity, opt.min_parking_space_length ?? Infinity);
  if (Number.isFinite(lengthLimit) && vehicle.length_cm && vehicle.length_cm > lengthLimit) {
    block("length", `Bay length ${cm(lengthLimit)} (vehicle ${cm(vehicle.length_cm)})`);
  }
  const widthLimit = Math.min(opt.max_vehicle_width ?? Infinity, opt.min_parking_space_width ?? Infinity);
  if (Number.isFinite(widthLimit) && vehicle.width_cm && vehicle.width_cm > widthLimit) {
    block("width", `Bay width ${cm(widthLimit)} (vehicle ${cm(vehicle.width_cm)})`);
  }
  if (vehicle.dangerous_goods && opt.dangerous_goods_allowed === false) {
    block("adr", "Dangerous goods (ADR) not allowed");
  }

  const shared = spec.connectorTypes.filter((c) => vehicle.connector_types.includes(c));
  // Prefer MCS when both sides have it.
  const connector = shared.includes("MCS") ? "MCS" : shared[0] ?? null;
  if (!connector) {
    const bay = spec.connectorTypes.map(connectorLabel).join("/") || "unknown";
    block("connector", `No matching connector (bay ${bay}, vehicle ${vehicle.connector_types.map(connectorLabel).join("/")})`);
  }

  if (spec.rfidRequired) {
    issues.push({ level: "touch", code: "rfid", text: "Operator requires an RFID card at the charger" });
  }
  if (!spec.plateAccess) {
    issues.push({ level: "touch", code: "access", text: "Site entry needs a code, ticket or intercom" });
  }
  if (!spec.autoStart.includes(vehicle.start_method)) {
    issues.push({
      level: "touch",
      code: "start",
      text: vehicle.start_method === "PLUG_AND_CHARGE" ? "Chargers don't support Plug & Charge" : "Chargers don't support Autocharge",
    });
  }
  if (vehicle.needs_reefer_outlet && !opt.refrigeration_outlet) {
    issues.push({ level: "warn", code: "reefer", text: "No reefer power outlet" });
  }

  const vehicleKw = vehicle.max_charge_kw ?? null;
  const chargerKw = connector ? spec.kwByType[connector] ?? spec.maxKw : spec.maxKw;
  const usableKw = chargerKw != null && vehicleKw != null ? Math.min(chargerKw, vehicleKw) : chargerKw ?? vehicleKw;
  const ok = !issues.some((i) => i.level === "block");
  return { ok, zeroTouch: ok && !issues.some((i) => i.level === "touch"), issues, spec, connector, usableKw };
}
