// Battery level as a meter: the fill's colour follows the level (brand, then amber, then red) on a
// lighter track of the same colour, and the reading is always written out too.
import { batteryBand } from "../app/kpis";

export function BatteryMeter({ soc, live, label }: { soc: number; live?: boolean; label?: string }) {
  const band = batteryBand(soc);
  const pct = Math.max(0, Math.min(100, soc));
  return (
    <div className={`battery-meter ${band}${live ? " live" : ""}`}>
      <div
        className="bm-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${Math.round(pct)}%${band === "low" ? ", low" : ""}${live ? ", charging" : ""}`}
        aria-label={label ?? "Battery"}
      >
        <div className="bm-fill" style={{ width: `${pct}%` }} />
        <span className="bm-mark" style={{ left: "80%" }} aria-hidden="true" />
      </div>
    </div>
  );
}
