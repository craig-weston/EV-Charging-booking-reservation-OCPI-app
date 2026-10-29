// Optional sample fleet for new accounts and the demo. Plates are invented; phone numbers use the
// Ofcom drama range (07700 900xxx).
import type { Driver, Vehicle } from "../../shared/model";
import { iso, uuid } from "../../shared/util";

export function sampleVehicles(fleetId: string, cc: string, pid: string): Vehicle[] {
  const now = iso(new Date());
  const base = { fleet_id: fleetId, active: true, created_at: now, updated_at: now, battery_kwh: 540, needs_reefer_outlet: false, dangerous_goods: false };
  const contract = (n: string) => `${cc}-${pid}-C${n}`;
  return [
    { ...base, id: uuid(), name: "Tractor 01", plate: "PN74 EVH", make_model: "Volvo FH Electric", vehicle_type: "TRUCK_WITH_TRAILER", gross_weight_kg: 44000, height_cm: 400, length_cm: 1650, width_cm: 255, connector_types: ["IEC_62196_T2_COMBO", "MCS"], max_charge_kw: 750, battery_kwh: 540, start_method: "PLUG_AND_CHARGE", token_uid: `${cc}${pid}C00000101K`, contract_id: contract("00000101K") },
    { ...base, id: uuid(), name: "Tractor 02", plate: "KX25 HGV", make_model: "Mercedes-Benz eActros 600", vehicle_type: "TRUCK_WITH_TRAILER", gross_weight_kg: 44000, height_cm: 400, length_cm: 1650, width_cm: 255, connector_types: ["IEC_62196_T2_COMBO", "MCS"], max_charge_kw: 1000, battery_kwh: 621, start_method: "AUTOCHARGE", token_uid: "VID:A4B2C3D4E5F6", contract_id: contract("00000102M") },
    { ...base, id: uuid(), name: "Rigid 03", plate: "YD74 ZRO", make_model: "DAF XD Electric", vehicle_type: "RIGID", gross_weight_kg: 19000, height_cm: 360, length_cm: 1000, width_cm: 255, connector_types: ["IEC_62196_T2_COMBO"], max_charge_kw: 325, battery_kwh: 315, start_method: "AUTOCHARGE", token_uid: "VID:3C2A9B4E1F07", contract_id: contract("00000103P") },
    { ...base, id: uuid(), name: "Reefer 04", plate: "LS25 CLD", make_model: "Renault E-Tech T", vehicle_type: "TRUCK_WITH_TRAILER", gross_weight_kg: 42000, height_cm: 410, length_cm: 1650, width_cm: 260, connector_types: ["IEC_62196_T2_COMBO"], max_charge_kw: 400, battery_kwh: 540, start_method: "PLUG_AND_CHARGE", token_uid: `${cc}${pid}C00000104R`, contract_id: contract("00000104R"), needs_reefer_outlet: true },
    { ...base, id: uuid(), name: "Tanker 05", plate: "BK74 ADR", make_model: "Scania 40 R BEV", vehicle_type: "TRUCK_WITH_TRAILER", gross_weight_kg: 44000, height_cm: 380, length_cm: 1650, width_cm: 255, connector_types: ["IEC_62196_T2_COMBO", "MCS"], max_charge_kw: 750, battery_kwh: 624, start_method: "PLUG_AND_CHARGE", token_uid: `${cc}${pid}C00000105T`, contract_id: contract("00000105T"), dangerous_goods: true },
  ];
}

export function sampleDrivers(fleetId: string): Driver[] {
  const now = iso(new Date());
  return [
    { id: uuid(), fleet_id: fleetId, name: "Sam Patel", phone: "07700 900123", created_at: now, updated_at: now },
    { id: uuid(), fleet_id: fleetId, name: "Jo Mitchell", phone: "07700 900456", created_at: now, updated_at: now },
    { id: uuid(), fleet_id: fleetId, name: "Aled Hughes", phone: "07700 900789", created_at: now, updated_at: now },
  ];
}
