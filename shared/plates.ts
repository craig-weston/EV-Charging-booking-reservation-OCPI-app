// Number-plate lookup: a UK registration → what DVLA's Vehicle Enquiry Service says about the
// vehicle (make, fuel, gross weight, axle layout), turned into what the app needs for a truck. DVLA
// doesn't hold the model, dimensions, battery or connectors: dimensions here are typical for the
// kind of truck and marked as such, for the planner to correct.
import type { VehicleType } from "./ocpi/types";
import { displayPlate, normalizePlate } from "./util";

export type PlateKind = "artic" | "rigid" | "van" | "bus" | "other";

export interface PlateDetails {
  /** Display form: "PN74 EVH". */
  plate: string;
  /** As DVLA holds it: "VOLVO". */
  make: string | null;
  /** DVLA's fuel type: "ELECTRICITY", "DIESEL", … */
  fuel: string | null;
  electric: boolean;
  year: number | null;
  colour: string | null;
  /** DVLA's revenue weight: for an artic tractor unit, the gross train weight. */
  gross_weight_kg: number | null;
  /** DVLA's axle layout: "2 AXLE RIGID BODY", "3 AXLE & ARTIC", … */
  wheel_plan: string | null;
  /** Type approval category: N3 (over 12 t), N2 (3.5–12 t), N1 (vans), M1 (cars), M2/M3 (buses). */
  type_approval: string | null;
  kind: PlateKind;
  /** The app's vehicle type for this kind. */
  vehicle_type: VehicleType;
  /** Typical dimensions for this kind and weight (not from DVLA): cm. */
  typical: { length_cm: number; height_cm: number; width_cm: number };
  /** A truck (or bus) the map and app are for; false for cars and motorbikes. */
  heavy: boolean;
}

/** UK plates are 2 to 7 letters and digits, with both. */
export function isUkPlate(s: string): boolean {
  const p = normalizePlate(s);
  return p.length >= 2 && p.length <= 7 && /[A-Z]/.test(p) && /\d/.test(p);
}

const title = (s: string) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

/** Typical outside dimensions by kind and weight. */
export function typicalSize(kind: PlateKind, kg: number | null): { length_cm: number; height_cm: number; width_cm: number } {
  const t = (kg ?? 0) / 1000;
  if (kind === "artic") return { length_cm: 1650, height_cm: 400, width_cm: 255 };
  if (kind === "bus") return { length_cm: 1200, height_cm: 330, width_cm: 255 };
  if (kind === "van") return { length_cm: 600, height_cm: 260, width_cm: 210 };
  if (kind === "rigid") return t > 0 && t <= 7.5 ? { length_cm: 750, height_cm: 330, width_cm: 240 } : t > 0 && t <= 18 ? { length_cm: 1000, height_cm: 360, width_cm: 255 } : { length_cm: 1100, height_cm: 380, width_cm: 255 };
  return { length_cm: 480, height_cm: 160, width_cm: 190 };
}

/** What kind of vehicle DVLA's record describes. */
export function plateKind(wheelPlan: string | null, typeApproval: string | null, kg: number | null): PlateKind {
  const w = (wheelPlan ?? "").toUpperCase(), ta = (typeApproval ?? "").toUpperCase();
  if (/ARTIC/.test(w)) return "artic";
  if (/^M[23]/.test(ta)) return "bus";
  if (/RIGID/.test(w) && (/^N[23]/.test(ta) || (kg ?? 0) > 3500)) return "rigid";
  if (/^N[23]/.test(ta) || (kg ?? 0) > 3500) return "rigid";
  if (/^N1/.test(ta)) return "van";
  return "other";
}

const TYPE: Record<PlateKind, VehicleType> = { artic: "TRUCK_WITH_TRAILER", rigid: "RIGID", van: "VAN", bus: "BUS", other: "PERSONAL_VEHICLE" };

/** DVLA's answer → our details, or null when it isn't a vehicle record. */
export function fromDvla(body: unknown): PlateDetails | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.registrationNumber !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const kg = num(b.revenueWeight), wheel = str(b.wheelPlan), ta = str(b.typeApproval), fuel = str(b.fuelType), make = str(b.make);
  const kind = plateKind(wheel, ta, kg);
  return {
    plate: displayPlate(b.registrationNumber),
    make: make ? title(make) : null,
    fuel,
    electric: /^ELECTRIC/i.test(fuel ?? ""),
    year: num(b.yearOfManufacture),
    colour: str(b.colour) ? title(str(b.colour)!) : null,
    gross_weight_kg: kg,
    wheel_plan: wheel,
    type_approval: ta,
    kind,
    vehicle_type: TYPE[kind],
    typical: typicalSize(kind, kg),
    heavy: kind === "artic" || kind === "rigid" || kind === "bus",
  };
}

/** One line for a card: "Volvo · 44 t · 2023". */
export function plateSummary(d: PlateDetails): string {
  return [d.make, d.gross_weight_kg ? `${(d.gross_weight_kg / 1000).toFixed(d.gross_weight_kg % 1000 ? 1 : 0)} t` : null, d.year ? String(d.year) : null].filter(Boolean).join(" · ");
}
