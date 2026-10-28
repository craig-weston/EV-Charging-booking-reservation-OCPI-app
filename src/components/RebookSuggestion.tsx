// "Nearest free bay" offer under a cancelled, declined or no-show booking: one tap to rebook.
import { useMemo, useState } from "react";
import type { BookingRow } from "../../shared/model";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { navigate } from "../app/router";
import { fmtDay, fmtRange } from "../app/format";
import { bookingBody, describeShift, rebookOptions } from "../app/rebook";
import { Icon, Spinner } from "../ui/ui";

export function RebookSuggestion({ booking, onBooked, compact }: { booking: BookingRow; onBooked?(newId: string): void; compact?: boolean }) {
  const { network, vehicles, now, api, fleetId, upsertBooking, toast } = useApp();
  const vehicle = vehicles.find((v) => v.id === booking.vehicle_id) ?? null;
  // Rank once per booking and network change, not on every clock tick.
  const minute = Math.floor(now.getTime() / 60_000);
  const options = useMemo(() => rebookOptions(network, booking, vehicle, new Date(minute * 60_000)), [network, booking, vehicle, minute]);
  const [busy, setBusy] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const durationMin = Math.round((new Date(booking.end_at).getTime() - new Date(booking.start_at).getTime()) / 60_000);
  const openBook = () => navigate("/book", { vehicle: booking.vehicle_id, at: booking.start_at, duration: durationMin });

  if (!vehicle) return null;
  if (options.length === 0) {
    return (
      <div className={`rebook ${compact ? "compact" : ""}`}>
        <span className="small muted grow">No free bay nearby within 3 hours of the original time.</span>
        <button className="btn sm" onClick={openBook}>Find another time</button>
      </div>
    );
  }
  const book = async (i: number) => {
    if (!fleetId) return;
    setBusy(i);
    try {
      const r = options[i];
      const row = await api<BookingRow>("POST", `/fleets/${fleetId}/bookings`, bookingBody(r, booking));
      upsertBooking(row);
      toast(row.reservation_status === "FAILED" ? "The operator didn't accept that one. Try another option." : `Requested ${r.site.shortName}, ${fmtRange(r.slot.start, r.slot.end)}`, row.reservation_status === "FAILED" ? "bad" : "info");
      if (row.reservation_status !== "FAILED") onBooked?.(row.id);
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Couldn't send the booking request", "bad");
    } finally {
      setBusy(null);
    }
  };
  const shown = more ? options : options.slice(0, 1);
  return (
    <div className={`rebook ${compact ? "compact" : ""}`}>
      <div className="rebook-title xs muted">{options.length > 1 && more ? "Free bays nearby" : "Nearest free bay"}</div>
      <ul className="rebook-list">
        {shown.map((r, i) => (
          <li key={`${r.site.key}-${r.slot.start.toISOString()}`}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="rebook-site"><b>{r.sameSite ? `${r.site.shortName}, another bay` : r.site.shortName}</b>{r.option.assessment.zeroTouch && <span className="tag ok">No card needed</span>}</div>
              <div className="xs muted">
                {fmtDay(r.slot.start, now)}, {fmtRange(r.slot.start, r.slot.end)} ({describeShift(r.shiftMin)})
                {r.distanceKm != null && !r.sameSite ? `, ${Math.max(1, Math.round(r.distanceKm * 0.621371))} miles away` : ""}
              </div>
            </div>
            <button className="btn sm primary" disabled={busy !== null} onClick={() => void book(i)}>{busy === i ? <Spinner /> : <Icon name="book" size="sm" />}Book this</button>
          </li>
        ))}
      </ul>
      <div className="row gap-8 wrap">
        {options.length > 1 && !more && <button className="btn sm ghost" onClick={() => setMore(true)}>{options.length - 1} more nearby</button>}
        <button className="btn sm ghost" onClick={openBook}>Choose another time</button>
      </div>
    </div>
  );
}
