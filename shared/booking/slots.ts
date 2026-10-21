// Availability maths on BookingLocation.calendars (Calendar.available_timeslots, timeslot_increment)
// and BookingTerms.min_booking_duration / max_booking_duration.
import type { BookingLocation, Timeslot } from "../ocpi/types";
import { MINUTE, ceilToStep } from "../util";

export interface Window {
  start: Date;
  end: Date;
  minPowerW: number | null;
  maxPowerW: number | null;
  green: boolean;
  calendarId: string;
  increment: number; // minutes
  anchor: Date; // calendar begin_from — increments count from here
}

export const DEFAULT_INCREMENT = 15;

/** All available windows clipped to [from, to), sorted, with contiguous windows merged. */
export function availableWindows(bl: BookingLocation, from: Date, to: Date): Window[] {
  const out: Window[] = [];
  for (const cal of bl.calendars ?? []) {
    const anchor = new Date(cal.begin_from);
    const increment = cal.timeslot_increment && cal.timeslot_increment > 0 ? cal.timeslot_increment : DEFAULT_INCREMENT;
    for (const ts of cal.available_timeslots ?? []) {
      const s = new Date(Math.max(new Date(ts.start_date_time).getTime(), from.getTime(), anchor.getTime()));
      const e = new Date(Math.min(new Date(ts.end_date_time).getTime(), to.getTime(), new Date(cal.end_before).getTime()));
      if (!(e > s) || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) continue;
      out.push({
        start: s, end: e,
        minPowerW: ts.min_power ?? null, maxPowerW: ts.max_power ?? null,
        green: ts.green_energy_support === true, calendarId: cal.id, increment, anchor,
      });
    }
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  // merge touching/overlapping windows (power: keep the lower guarantee)
  const merged: Window[] = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (last && w.start.getTime() <= last.end.getTime()) {
      if (w.end > last.end) last.end = w.end;
      last.maxPowerW = minNullable(last.maxPowerW, w.maxPowerW);
      last.minPowerW = minNullable(last.minPowerW, w.minPowerW);
      last.green = last.green && w.green;
    } else merged.push({ ...w });
  }
  return merged;
}

function minNullable(a: number | null, b: number | null) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

export function durationLimits(bl: BookingLocation): { min: number; max: number; step: number } {
  const step = bl.calendars?.find((c) => c.timeslot_increment)?.timeslot_increment || DEFAULT_INCREMENT;
  const min = Math.max(step, bl.booking_terms?.min_booking_duration ?? step);
  const max = Math.max(min, bl.booking_terms?.max_booking_duration ?? 240);
  return { min, max, step };
}

/** The window that fully contains [start, end], or null. */
export function fitWindow(bl: BookingLocation, start: Date, end: Date): Window | null {
  if (!(end > start)) return null;
  const windows = availableWindows(bl, new Date(start.getTime() - 24 * 60 * MINUTE), new Date(end.getTime() + 24 * 60 * MINUTE));
  return windows.find((w) => w.start <= start && w.end >= end) ?? null;
}

export interface SlotCheck {
  ok: boolean;
  reason?: string;
  window?: Window;
}

export function checkSlot(bl: BookingLocation, start: Date, end: Date, now: Date): SlotCheck {
  const lim = durationLimits(bl);
  const dur = Math.round((end.getTime() - start.getTime()) / MINUTE);
  if (start < new Date(now.getTime() - MINUTE)) return { ok: false, reason: "Start time is in the past" };
  if (dur < lim.min) return { ok: false, reason: `Minimum booking is ${lim.min} min` };
  if (dur > lim.max) return { ok: false, reason: `Maximum booking is ${lim.max} min` };
  const w = fitWindow(bl, start, end);
  if (!w) return { ok: false, reason: "That time isn't available" };
  const offset = Math.round((start.getTime() - w.anchor.getTime()) / MINUTE);
  if (offset % w.increment !== 0) return { ok: false, reason: `Start must be on a ${w.increment}-minute step` };
  return { ok: true, window: w };
}

export interface Suggestion {
  start: Date;
  end: Date;
  window: Window;
  deltaMin: number; // distance from the desired start (negative = earlier)
}

/**
 * Feasible slots of `durationMin` closest to `desired` (ties prefer later), at most `count`,
 * no two starting closer than `spacingMin` apart.
 */
export function suggestSlots(
  bl: BookingLocation, desired: Date, durationMin: number, now: Date,
  opts: { count?: number; horizonMin?: number; spacingMin?: number } = {},
): Suggestion[] {
  const count = opts.count ?? 3;
  const horizon = opts.horizonMin ?? 12 * 60;
  const spacing = opts.spacingMin ?? 30;
  const from = new Date(Math.max(now.getTime(), desired.getTime() - horizon * MINUTE));
  const to = new Date(desired.getTime() + horizon * MINUTE + durationMin * MINUTE);
  const candidates: Suggestion[] = [];
  for (const w of availableWindows(bl, from, to)) {
    let s = ceilToStep(new Date(Math.max(w.start.getTime(), now.getTime())), w.increment, w.anchor);
    while (s.getTime() + durationMin * MINUTE <= w.end.getTime()) {
      const delta = Math.round((s.getTime() - desired.getTime()) / MINUTE);
      candidates.push({ start: s, end: new Date(s.getTime() + durationMin * MINUTE), window: w, deltaMin: delta });
      s = new Date(s.getTime() + w.increment * MINUTE);
      if (candidates.length > 2000) break;
    }
  }
  candidates.sort((a, b) => Math.abs(a.deltaMin) - Math.abs(b.deltaMin) || b.deltaMin - a.deltaMin);
  const picked: Suggestion[] = [];
  for (const c of candidates) {
    if (picked.every((p) => Math.abs(p.start.getTime() - c.start.getTime()) >= spacing * MINUTE)) picked.push(c);
    if (picked.length >= count) break;
  }
  return picked.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Fraction of [from, to) that is bookable — drives the mini availability bars. */
export function availabilityRatio(bl: BookingLocation, from: Date, to: Date): number {
  const total = to.getTime() - from.getTime();
  if (total <= 0) return 0;
  const free = availableWindows(bl, from, to).reduce((s, w) => s + (w.end.getTime() - w.start.getTime()), 0);
  return Math.min(1, free / total);
}

export function timeslotOf(w: Window, start: Date, end: Date): Timeslot {
  return {
    start_date_time: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
    end_date_time: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(w.minPowerW != null ? { min_power: w.minPowerW } : {}),
    ...(w.maxPowerW != null ? { max_power: w.maxPowerW } : {}),
    green_energy_support: w.green,
  };
}
