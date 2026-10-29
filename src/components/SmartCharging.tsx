// Smart charging for one public booking (OCPI ChargingProfiles): finish by the end of the booking
// at the cheapest or greenest times, or cap the power. Set up before arrival or during the charge.
import { useState } from "react";
import type { BookingRow, SmartMode } from "../../shared/model";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtMoney, fmtTime } from "../app/format";
import { Icon, Seg, Spinner } from "../ui/ui";

const N0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const STATUS: Record<string, { tone: "ok" | "warn" | "bad" | ""; label: string }> = {
  waiting: { tone: "", label: "Sends when charging starts" },
  sent: { tone: "warn", label: "Sent, awaiting charger" },
  active: { tone: "ok", label: "Charger following it" },
  rejected: { tone: "bad", label: "Rejected" },
  not_supported: { tone: "bad", label: "Not supported here" },
  too_often: { tone: "warn", label: "Try again shortly" },
  unknown_session: { tone: "bad", label: "Session not recognised" },
  failed: { tone: "bad", label: "Couldn't send" },
  cleared: { tone: "", label: "Off" },
};

export function SmartChargingCard({ booking, tz, onChange }: { booking: BookingRow; tz: string; onChange(b: BookingRow): void }) {
  const { api, fleetId, toast } = useApp();
  const sc = booking.smart_charging;
  const on = sc && sc.status !== "cleared" && sc.status !== "not_supported";
  const [mode, setMode] = useState<SmartMode>(sc?.mode ?? "cheapest");
  const [cap, setCap] = useState<number>(sc?.cap_kw ?? 150);
  const [target, setTarget] = useState<number>(sc?.target_soc ?? 90);
  const [busy, setBusy] = useState(false);
  const charging = booking.session?.status === "ACTIVE";
  const finished = booking.session && booking.session.status !== "ACTIVE" && booking.session.status !== "PENDING";
  if (finished && !sc) return null;

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<BookingRow>("POST", `/fleets/${fleetId}/bookings/${booking.id}/smart-charging`, { mode, cap_kw: mode === "cap" ? cap : undefined, target_soc: target });
      onChange(r);
      const s = r.smart_charging?.status;
      toast(s === "waiting" ? "Smart charging set: sent when charging starts" : s === "not_supported" ? "This operator doesn't support smart charging" : s === "sent" || s === "active" ? "Schedule sent to the charger" : r.smart_charging?.message ?? "Done", s === "not_supported" || s === "failed" || s === "rejected" ? "bad" : undefined);
    } catch (e) { toast(e instanceof ApiFailure ? e.message : "Couldn't set smart charging", "bad"); } finally { setBusy(false); }
  };
  const off = async () => {
    setBusy(true);
    try { onChange(await api<BookingRow>("DELETE", `/fleets/${fleetId}/bookings/${booking.id}/smart-charging`)); toast("Smart charging off: full power"); } catch (e) { toast(e instanceof ApiFailure ? e.message : "Couldn't switch it off", "bad"); } finally { setBusy(false); }
  };

  const st = sc ? STATUS[sc.status] : null;
  const est = sc?.estimate;
  return (
    <div className="panel smart-card">
      <div className="panel-head">
        <h3 className="row gap-6"><Icon name="zap" size="sm" />Smart charging</h3>
        {st && <span className={`right tag ${st.tone}`}>{st.label}</span>}
      </div>
      <div className="panel-body stack gap-12">
        {on && est ? (
          <div className="smart-est">
            <div><span className="xs muted">Ready by</span><b>{est.ready_at ? fmtTime(new Date(est.ready_at), tz) : "—"}</b></div>
            <div><span className="xs muted">Energy cost</span><b>{fmtMoney(est.cost)}</b>{est.baseline_cost - est.cost >= 0.5 && <span className="xs ok-text">saves {fmtMoney(est.baseline_cost - est.cost)}</span>}</div>
            <div><span className="xs muted">Grid CO₂</span><b>{N0.format(est.kg)} kg</b>{est.baseline_kg - est.kg >= 1 && <span className="xs ok-text">{N0.format(est.baseline_kg - est.kg)} kg less</span>}</div>
          </div>
        ) : null}
        {sc?.message && sc.status !== "cleared" && <p className="small muted" style={{ margin: 0 }}>{sc.message}{est?.short_kwh ? ` It may end ${N0.format(est.short_kwh)} kWh short of ${sc.target_soc}%.` : ""}</p>}
        {!finished && sc?.status === "not_supported" && <div><button className="btn sm ghost" disabled={busy} onClick={apply}>{busy ? <Spinner label="Checking" /> : <Icon name="refresh" size="sm" />}Try again</button></div>}
        {!finished && sc?.status !== "not_supported" && (
          <>
            <Seg<SmartMode> label="Smart charging mode" full value={mode} onChange={setMode} options={[{ value: "cheapest", label: "Cheapest" }, { value: "greenest", label: "Greenest" }, { value: "cap", label: "Limit power" }]} />
            <p className="xs muted" style={{ margin: 0 }}>
              {mode === "cap" ? "Charge at no more than this power, as soon as possible." : `Reach ${target}% by the end of the booking, charging in the ${mode === "cheapest" ? "cheapest" : "cleanest"} half-hours.`} The operator's charger follows the schedule over OCPI.
            </p>
            {mode === "cap"
              ? <label className="field"><span className="label">Up to {cap} kW</span><input className="range" type="range" min={20} max={Math.max(50, booking.power_required_kw ?? 400)} step={10} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></label>
              : <label className="field"><span className="label">Charge needed by the end: {target}%</span><input className="range" type="range" min={20} max={100} step={5} value={target} onChange={(e) => setTarget(Number(e.target.value))} /></label>}
            <div className="row gap-8">
              <button className="btn primary sm" disabled={busy} onClick={apply}>{busy ? <Spinner label="Sending" /> : null}{on ? "Update" : charging ? "Send to charger" : "Set up for this charge"}</button>
              {on && <button className="btn sm ghost" disabled={busy} onClick={off}>Switch off</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
