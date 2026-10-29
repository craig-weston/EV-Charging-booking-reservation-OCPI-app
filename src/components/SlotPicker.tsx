// Bay availability as a 12-hour window you can page through. Free time is clean space, unavailable
// time is hatched; the selection is the brand colour and can be dragged, clicked into place or
// nudged with the arrow keys (Shift = an hour).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { BookingLocation } from "../../shared/ocpi/types";
import { availableWindows, checkSlot } from "../../shared/booking/slots";
import { MINUTE, floorToStep } from "../../shared/util";
import { fmtDay, fmtRange, fmtTime } from "../app/format";
import { Icon } from "../ui/ui";

const HOUR = 60 * MINUTE;

/** A shaded half-hour under the track: carbon or price, 0 = best (darkest) … 4 = worst. */
export interface EnergyCell { start: number; end: number; level: 0 | 1 | 2 | 3 | 4; title: string }

export function SlotPicker({ bl, dayStart, now, start, duration, onChange, tz, ignoreBusy, hours = 12, energy, onRange }: {
  bl: BookingLocation;
  /** Anchor for the booking increments (local midnight of the calendar). */
  dayStart: Date;
  now: Date;
  start: Date | null;
  duration: number;
  onChange(start: Date): void;
  tz: string;
  /** For changes: the booking's own time doesn't count as busy. */
  ignoreBusy?: { start: Date; end: Date } | null;
  hours?: number;
  /** Optional carbon or price strip under the track. */
  energy?: { kind: "carbon" | "price"; cells: EnergyCell[] } | null;
  /** Tells the parent which range is on screen, so it can fetch data for it. */
  onRange?(from: Date, to: Date): void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const span = hours * HOUR;
  const centre = (t: number) => Math.floor((t - 3 * HOUR) / HOUR) * HOUR;
  const [from, setFrom] = useState(() => centre((start ?? now).getTime()));
  const to = from + span;

  // Follow the selection when it moves out of view (e.g. a suggestion chip on another day).
  useEffect(() => {
    if (!start) return;
    const s = start.getTime();
    if (s < from || s + duration * MINUTE > to) setFrom(centre(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start?.getTime(), duration]);

  useEffect(() => { onRange?.(new Date(from), new Date(to)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to]);

  const pct = (t: number) => ((t - from) / span) * 100;
  const windows = useMemo(() => {
    const ws = availableWindows(bl, new Date(Math.max(from, now.getTime())), new Date(to));
    if (ignoreBusy && ignoreBusy.end.getTime() > from && ignoreBusy.start.getTime() < to) {
      ws.push({ start: ignoreBusy.start, end: ignoreBusy.end, minPowerW: null, maxPowerW: null, green: false, calendarId: "", increment: ws[0]?.increment ?? 15, anchor: dayStart });
    }
    return ws.sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [bl, from, to, now, ignoreBusy, dayStart]);
  const step = windows[0]?.increment ?? bl.calendars?.[0]?.timeslot_increment ?? 15;

  const end = start ? new Date(start.getTime() + duration * MINUTE) : null;
  const valid = start && end ? (ignoreBusy ? windows.some((w) => w.start <= start && w.end >= end) || checkSlot(bl, start, end, now).ok : checkSlot(bl, start, end, now).ok) : false;

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return floorToStep(new Date(from + ((clientX - r.left) / r.width) * span), step, dayStart);
  };

  /** Snap a wanted start into the free window under it so the whole charge fits when possible. */
  const place = (wanted: Date) => {
    const w = windows.find((x) => x.start <= wanted && x.end > wanted) ?? windows.find((x) => x.start > wanted);
    if (!w) return onChange(wanted);
    let s = Math.max(wanted.getTime(), w.start.getTime());
    if (s + duration * MINUTE > w.end.getTime()) s = Math.max(w.start.getTime(), w.end.getTime() - duration * MINUTE);
    onChange(floorToStep(new Date(s), step, dayStart));
  };

  const drag = useRef<{ offset: number } | null>(null);
  const onDown = (e: ReactPointerEvent) => {
    if (!start) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { offset: timeAt(e.clientX).getTime() - start.getTime() };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag.current || !start) return;
    const t = new Date(timeAt(e.clientX).getTime() - drag.current.offset);
    if (t.getTime() !== start.getTime()) onChange(t);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!start) return;
    const d = e.shiftKey ? 60 : step;
    if (e.key === "ArrowLeft") { e.preventDefault(); onChange(new Date(start.getTime() - d * MINUTE)); }
    if (e.key === "ArrowRight") { e.preventDefault(); onChange(new Date(start.getTime() + d * MINUTE)); }
  };

  const ticks: { t: number; label: string }[] = [];
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) {
    const hh = fmtTime(new Date(t), tz).slice(0, 2);
    if (Number(hh) % 2) continue; // even local hours
    ticks.push({ t, label: hh === "00" ? fmtDay(new Date(t), now, tz).replace("Tomorrow", "Tmrw") : hh });
  }
  const earliest = Math.floor(now.getTime() / HOUR) * HOUR - 2 * HOUR;
  const latest = Math.max(...(bl.calendars ?? []).map((c) => new Date(c.end_before).getTime()), now.getTime() + 24 * HOUR);

  return (
    <div className="picker stack gap-6">
      <div className="row gap-8">
        <b className="small">{fmtDay(new Date(from), now, tz)} {fmtTime(new Date(from), tz)} to {fmtDay(new Date(to), now, tz) === fmtDay(new Date(from), now, tz) ? "" : `${fmtDay(new Date(to), now, tz)} `}{fmtTime(new Date(to), tz)}</b>
        <span className="right row gap-4">
          <button type="button" className="btn sm ghost icon-only" aria-label="Earlier" disabled={from <= earliest} onClick={() => setFrom(Math.max(earliest, from - 6 * HOUR))}><Icon name="chevronLeft" size="sm" /></button>
          <button type="button" className="btn sm ghost icon-only" aria-label="Later" disabled={to >= latest} onClick={() => setFrom(Math.min(latest - span, from + 6 * HOUR))}><Icon name="chevronRight" size="sm" /></button>
        </span>
      </div>
      <div
        className="picker-track"
        ref={track}
        onClick={(e) => { if (!(e.target as HTMLElement).classList.contains("picker-sel")) place(timeAt(e.clientX)); }}
      >
        {windows.map((w, i) => (
          <div
            key={i}
            className={`picker-free ${w.green ? "green" : ""}`}
            style={{ left: `${Math.max(0, pct(w.start.getTime()))}%`, width: `${Math.max(0.3, Math.min(100, pct(w.end.getTime())) - Math.max(0, pct(w.start.getTime())))}%` }}
            title={`Free ${fmtRange(w.start, w.end, tz)}${w.maxPowerW ? `, up to ${Math.round(w.maxPowerW / 1000)} kW` : ""}${w.green ? ", green energy" : ""}`}
          />
        ))}
        {now.getTime() > from && now.getTime() < to && <div className="picker-now" style={{ left: `${pct(now.getTime())}%` }} />}
        {start && end && end.getTime() > from && start.getTime() < to && (
          <div
            className={`picker-sel ${valid ? "" : "invalid"}`}
            role="slider"
            tabIndex={0}
            aria-label="Booking time"
            aria-valuetext={fmtRange(start, end, tz)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct(start.getTime()))}
            style={{ left: `${pct(start.getTime())}%`, width: `${pct(end.getTime()) - pct(start.getTime())}%` }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onKeyDown={onKey}
          >
            {pct(end.getTime()) - pct(start.getTime()) > 18 ? fmtRange(start, end, tz) : pct(end.getTime()) - pct(start.getTime()) > 9 ? fmtTime(start, tz) : ""}
          </div>
        )}
      </div>
      {energy && energy.cells.length > 0 && (
        <div className={`picker-energy ${energy.kind}`} aria-hidden="true">
          {energy.cells.filter((c) => c.end > from && c.start < to).map((c) => (
            <span key={c.start} className={`l${c.level}`} title={c.title} style={{ left: `${Math.max(0, pct(c.start))}%`, width: `${Math.min(100, pct(c.end)) - Math.max(0, pct(c.start))}%` }} />
          ))}
          {start && end && end.getTime() > from && start.getTime() < to && <i className="picker-energy-sel" style={{ left: `${Math.max(0, pct(start.getTime()))}%`, width: `${Math.min(100, pct(end.getTime())) - Math.max(0, pct(start.getTime()))}%` }} />}
        </div>
      )}
      <div className="picker-axis" aria-hidden="true">
        {ticks.map((t) => {
          const p = pct(t.t);
          return <span key={t.t} style={{ left: `${p}%`, transform: p < 3 ? "none" : p > 97 ? "translateX(-100%)" : undefined }}>{t.label}</span>;
        })}
      </div>
    </div>
  );
}
