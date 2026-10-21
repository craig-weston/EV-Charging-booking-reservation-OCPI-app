import { useEffect, useState } from "react";
import type { BookingRow, Vehicle } from "../../shared/model";
import { useApp } from "../app/state";
import { fmtDay, fmtRange } from "../app/format";
import { Icon, copyText } from "../ui/ui";

export function passUrl(token: string) {
  return `${window.location.origin}${window.location.pathname}#/pass/${token}`;
}

export function PassShare({ booking, vehicle, siteName }: { booking: BookingRow; vehicle: Vehicle | null; siteName: string }) {
  const { api, fleetId, me, upsertBooking, toast } = useApp();
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState(booking.pass_token);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => setToken(booking.pass_token), [booking.pass_token]);
  const canReset = me?.memberships.find((m) => m.fleet_id === fleetId)?.role !== "viewer";
  const url = passUrl(token);
  // Revokes a link that went to the wrong person: the old one stops working immediately.
  const reset = async () => {
    if (!confirmReset) { setConfirmReset(true); return; }
    setConfirmReset(false);
    try {
      const b = await api<BookingRow>("POST", `/fleets/${fleetId}/bookings/${booking.id}/pass`);
      setToken(b.pass_token);
      upsertBooking(b);
      toast("New pass link created. The old link no longer works.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't reset the link", "bad");
    }
  };
  const text = `Charging booked: ${siteName}, ${fmtDay(booking.start_at)} ${fmtRange(booking.start_at, booking.end_at)} for ${vehicle?.plate ?? booking.plate}. Just drive in and plug in. Details: ${url}`;
  return (
    <div className="panel" style={{ background: "var(--surface-2)" }}>
      <div className="panel-body stack gap-12">
        <div>
          <b>Send the driver their pass</b>
          <div className="xs muted">A mobile page with the address, arrival window and what happens at the gate. No app or login needed.</div>
        </div>
        <div className="row gap-8 wrap">
          <button className="btn sm" onClick={async () => { if (await copyText(url)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }}>
            <Icon name={copied ? "check" : "copy"} size="sm" />{copied ? "Link copied" : "Copy link"}
          </button>
          <a className="btn sm" href={`sms:?&body=${encodeURIComponent(text)}`}><Icon name="message" size="sm" />Text</a>
          <a className="btn sm" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer"><Icon name="share" size="sm" />WhatsApp</a>
          <a className="btn sm ghost" href={url} target="_blank" rel="noreferrer"><Icon name="external" size="sm" />Open pass</a>
          {canReset && (
            <button className={`btn sm ghost${confirmReset ? " danger-text" : ""}`} onClick={() => void reset()} onBlur={() => setConfirmReset(false)} title="Stop the current link working and create a new one">
              <Icon name="refresh" size="sm" />{confirmReset ? "Confirm new link" : "Reset link"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
