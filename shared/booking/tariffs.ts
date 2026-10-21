// Human-readable summary of the Tariffs attached to a BookingLocation (incl. the Bookings-module
// restrictions BOOKING, BOOKING_EXPIRES, BOOKING_CANCELLATION_FEES, BOOKING_OVERTIME).
import type { PriceComponent, Tariff, TariffElement } from "../ocpi/types";

export interface TariffSummary {
  currency: string;
  taxIncluded: Tariff["tax_included"];
  vat: number | null;
  energyPerKwh: number | null;
  bookingFlat: number | null;
  bookingPerHour: number | null;
  noShowFee: number | null;
  noShowPerHour: number | null;
  cancelFee: number | null;
  overtimePerHour: number | null;
  parkingPerHour: number | null;
}

const comp = (el: TariffElement | undefined, type: PriceComponent["type"]) => el?.price_components.find((p) => p.type === type);

export function summarizeTariffs(tariffs: Tariff[]): TariffSummary | null {
  if (!tariffs.length) return null;
  const elements = tariffs.flatMap((t) => t.elements);
  const plain = elements.filter((e) => !e.restrictions?.booking && !e.restrictions?.reservation);
  const byBooking = (k: string) => elements.find((e) => e.restrictions?.booking === k);
  const energy = plain.map((e) => comp(e, "ENERGY")).find(Boolean);
  const parking = plain.map((e) => comp(e, "PARKING_TIME")).find(Boolean);
  const booking = byBooking("BOOKING");
  const expires = byBooking("BOOKING_EXPIRES");
  const cancel = byBooking("BOOKING_CANCELLATION_FEES");
  const overtime = byBooking("BOOKING_OVERTIME");
  const anyVat = elements.flatMap((e) => e.price_components).find((p) => p.vat != null)?.vat ?? null;
  return {
    currency: tariffs[0].currency,
    taxIncluded: tariffs[0].tax_included,
    vat: anyVat,
    energyPerKwh: energy?.price ?? null,
    bookingFlat: comp(booking, "FLAT")?.price ?? null,
    bookingPerHour: comp(booking, "TIME")?.price ?? null,
    noShowFee: comp(expires, "FLAT")?.price ?? null,
    noShowPerHour: comp(expires, "TIME")?.price ?? null,
    cancelFee: comp(cancel, "FLAT")?.price ?? null,
    overtimePerHour: comp(overtime, "TIME")?.price ?? comp(overtime, "PARKING_TIME")?.price ?? null,
    parkingPerHour: parking?.price ?? null,
  };
}

export interface CostEstimate {
  booking: number;
  energy: number | null;
  total: number | null;
  kwh: number | null;
}

/** Rough pre-booking estimate: booking fee for the slot + energy at the usable power (85% average). */
export function estimateCost(summary: TariffSummary | null, durationMin: number, usableKw: number | null, batteryKwh?: number | null): CostEstimate {
  if (!summary) return { booking: 0, energy: null, total: null, kwh: null };
  const hours = durationMin / 60;
  const booking = (summary.bookingFlat ?? 0) + (summary.bookingPerHour ?? 0) * hours;
  let kwh = usableKw != null ? usableKw * hours * 0.85 : null;
  if (kwh != null && batteryKwh) kwh = Math.min(kwh, batteryKwh * 0.8);
  const energy = kwh != null && summary.energyPerKwh != null ? kwh * summary.energyPerKwh : null;
  return { booking: round2(booking), energy: energy != null ? round2(energy) : null, total: energy != null ? round2(booking + energy) : null, kwh: kwh != null ? Math.round(kwh) : null };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
