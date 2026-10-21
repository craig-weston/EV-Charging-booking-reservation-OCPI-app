// Deadlines and permissions derived from BookingTerms.
import type { BookingTerms } from "../ocpi/types";
import { addMinutes } from "../util";

export interface Deadlines {
  changeUntil: Date | null; // null → changes not allowed
  cancelFreeUntil: Date;
  arriveFrom: Date;
  noShowAt: Date | null; // null → no timeout
  stopBy: Date;
}

export function deadlines(terms: BookingTerms | null | undefined, start: Date | string, end: Date | string): Deadlines {
  const s = new Date(start);
  const e = new Date(end);
  const t = terms ?? ({ supported_access_methods: [], change_until_minutes: 0, cancel_until_minutes: 0 } as BookingTerms);
  return {
    changeUntil: t.change_not_allowed ? null : addMinutes(s, -(t.change_until_minutes ?? 0)),
    cancelFreeUntil: addMinutes(s, -(t.cancel_until_minutes ?? 0)),
    arriveFrom: t.early_start_allowed ? addMinutes(s, -(t.early_start_time ?? 0)) : s,
    noShowAt: t.noshow_timeout != null ? addMinutes(s, t.noshow_timeout) : null,
    stopBy: t.late_stop_allowed ? addMinutes(e, t.late_stop_time ?? 0) : e,
  };
}

export function canChange(terms: BookingTerms | null | undefined, start: Date | string, now: Date): { ok: boolean; reason?: string } {
  const d = deadlines(terms, start, start);
  if (!d.changeUntil) return { ok: false, reason: "This operator doesn't allow changes" };
  if (now > d.changeUntil) return { ok: false, reason: "The change deadline has passed" };
  return { ok: true };
}

/** Cancelling is always possible while the booking is open; after the deadline a fee may apply. */
export function cancelTerms(terms: BookingTerms | null | undefined, start: Date | string, now: Date): { free: boolean; deadline: Date } {
  const d = deadlines(terms, start, start);
  return { free: now <= d.cancelFreeUntil, deadline: d.cancelFreeUntil };
}
