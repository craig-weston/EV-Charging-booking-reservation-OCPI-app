// The fleet's day as lanes: one row per truck, bookings placed in time, a live "now" line.
// Clicking an empty stretch of a lane starts a booking for that truck at that time.
import type { BookingRow, NetworkSnapshot, Vehicle } from "../../shared/model";
import { MINUTE, floorToStep } from "../../shared/util";
import { fmtRange, fmtTime } from "../app/format";
import { findLocation, operatorFor, shortSiteName } from "../app/network";
import { Plate, toneOf } from "../ui/ui";

const HOURS = 24;

export function LaneBoard({ vehicles, bookings, network, now, onOpen, onBookAt }: {
  vehicles: Vehicle[];
  bookings: BookingRow[];
  network: NetworkSnapshot | null;
  now: Date;
  onOpen(b: BookingRow): void;
  onBookAt(v: Vehicle, at: Date): void;
}) {
  const from = floorToStep(new Date(now.getTime() - 2 * 60 * MINUTE), 60).getTime();
  const to = from + HOURS * 60 * MINUTE;
  const pct = (t: number) => ((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100;
  const ticks: { t: number; label: string; day: boolean }[] = [];
  for (let t = from; t <= to; t += 60 * MINUTE) {
    const label = fmtTime(new Date(t)).slice(0, 2);
    if (Number(label) % 2) continue; // even local hours
    ticks.push({ t, label: label === "00" ? new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" }).format(new Date(t)) : label, day: label === "00" });
  }
  const visible = bookings.filter((b) => new Date(b.end_at).getTime() > from && new Date(b.start_at).getTime() < to && b.reservation_status !== "REJECTED" && b.reservation_status !== "FAILED");
  const lanes = vehicles
    .filter((v) => v.active || visible.some((b) => b.vehicle_id === v.id))
    .sort((a, b) => a.name.localeCompare(b.name, "en-GB", { numeric: true }));

  const site = (b: BookingRow) => {
    const loc = findLocation(network, b.cpo_country_code, b.cpo_party_id, b.location_id);
    // Lanes are tight: "Brackmills depot (Ridgeway Logistics)" reads as "Brackmills depot".
    return (loc ? shortSiteName(loc, operatorFor(network, b.cpo_country_code, b.cpo_party_id, loc)) : b.location_id).replace(/\s*\(.*\)$/, "");
  };

  return (
    <div className="lanes panel" role="region" aria-label="Today's charging plan">
      <div className="lanes-inner">
        <div className="lane-axis">
          <div className="lane-label" style={{ borderRight: "1px solid var(--line)" }}><span className="xs muted">Vehicle</span></div>
          <div className="ticks">
            {ticks.filter((t) => pct(t.t) > 1.5 && pct(t.t) < 98.5).map((t) => <span key={t.t} className={`tick ${t.day ? "day" : ""}`} style={{ left: `${pct(t.t)}%` }}>{t.label}</span>)}
          </div>
        </div>
        {lanes.map((v) => (
          <div className="lane" key={v.id}>
            <div className="lane-label">
              <Plate plate={v.plate} size="sm" />
              <span className="name ellipsis">{v.name}</span>
            </div>
            <div
              className="lane-track"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest(".lane-block, .block-label")) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const t = from + ((e.clientX - r.left) / r.width) * (to - from);
                onBookAt(v, floorToStep(new Date(Math.max(t, now.getTime())), 15));
              }}
              onMouseMove={(e) => {
                const g = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(".lane-ghost");
                if (!g) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                g.style.left = `${Math.min(r.width - 64, Math.max(0, e.clientX - r.left - 8))}px`;
              }}
              title={`Book ${v.plate} here`}
            >
              {ticks.map((t) => <div key={t.t} className={`grid-line ${t.day ? "day" : ""}`} style={{ left: `${pct(t.t)}%` }} />)}
              <div className="lane-ghost" />
              {visible.filter((b) => b.vehicle_id === v.id).map((b) => {
                const left = pct(new Date(b.start_at).getTime());
                const width = Math.max(0.8, pct(new Date(b.end_at).getTime()) - left);
                const tone = toneOf(b);
                const narrow = width < 11;
                const kwh = b.session?.status === "ACTIVE" ? (b.session.kwh >= 1 ? `, ${Math.round(b.session.kwh)} kWh` : ", starting") : "";
                const text = (
                  <>
                    <span className="s">{site(b)}</span>
                    <span className="t">{fmtRange(b.start_at, b.end_at)}{kwh}</span>
                  </>
                );
                return (
                  <span key={b.id}>
                    <button
                      type="button"
                      className={`lane-block ${tone}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={() => onOpen(b)}
                      aria-label={`${v.plate}, ${site(b)}, ${fmtRange(b.start_at, b.end_at)}`}
                    >
                      {!narrow && text}
                    </button>
                    {narrow && (
                      <button type="button" className="block-label" style={{ left: `calc(${left + width}% + 6px)` }} onClick={() => onOpen(b)} tabIndex={-1} aria-hidden="true">
                        {text}
                      </button>
                    )}
                  </span>
                );
              })}
              <div className="nowline" style={{ left: `${pct(now.getTime())}%` }} aria-hidden="true" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
