// Battery level as a meter, one meaning per colour: green and flowing while charging, red and
// pulsing when a fault has stopped it, amber when low at rest, otherwise the brand colour. The
// reading is always written out too, so colour is never the only signal.
import { batteryBand } from "../app/kpis";

export type MeterMode = "charging" | "fault" | null;

export function BatteryMeter({ soc, mode, label }: { soc: number; mode?: MeterMode; label?: string }) {
  const band = batteryBand(soc);
  const pct = Math.max(0, Math.min(100, soc));
  const state = mode === "charging" ? ", charging" : mode === "fault" ? ", fault" : band === "low" ? ", low" : "";
  return (
    <div className={`battery-meter ${mode ?? band}`}>
      <div
        className="bm-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${Math.round(pct)}%${state}`}
        aria-label={label ?? "Battery"}
      >
        <div className="bm-fill" style={{ width: `${pct}%` }} />
        <span className="bm-mark" style={{ left: "80%" }} aria-hidden="true" />
      </div>
    </div>
  );
}
