// Battery level as a meter, coloured by the charging key (as on charger lights): green when the
// truck can charge, blue and animated while it's charging, red when a fault has stopped it, and a
// calm neutral otherwise. The reading is always written out too, so colour is never the only signal.
import { batteryBand } from "../app/kpis";

export type MeterMode = "ready" | "charging" | "fault" | null;

export function BatteryMeter({ soc, mode, label }: { soc: number; mode?: MeterMode; label?: string }) {
  const pct = Math.max(0, Math.min(100, soc));
  const state = mode === "charging" ? ", charging" : mode === "fault" ? ", fault" : mode === "ready" ? ", ready to charge" : batteryBand(soc) === "low" ? ", low" : "";
  return (
    <div className={`battery-meter ${mode ?? ""}`}>
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

/** The colour key, shown wherever the colours are used. */
export function ChargeKey({ fault = true }: { fault?: boolean }) {
  return (
    <ul className="charge-key" aria-label="Colour key">
      <li><i aria-hidden="true" />Ready to charge</li>
      <li><i className="charging" aria-hidden="true" />Charging</li>
      {fault && <li><i className="fault" aria-hidden="true" />Fault</li>}
    </ul>
  );
}
