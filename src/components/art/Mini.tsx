// Small, cropped views of the same depot scene: a truck on charge (live sessions), an empty bay
// and a parked truck (empty states). Only CSS ambient motion here: no timeline running.
import { useId } from "react";
import { G, PARK_FRONT, TRUCKS, type Frame, type TruckKind } from "./scene";
import { SceneLayers, Truck } from "./Parts";

const still = (over: Partial<Frame>): Frame => ({
  t: 15, front: PARK_FRONT, moving: false, braking: false, barrier: 0, beam: 0, scan: 0, digits: 0, idBubble: 0,
  connector: 0, handshake: 0, power: 0, level: 0.5, energy: false, done: false, receipt: 0, battery: 0, focus: 600, ...over,
});

const useArtId = () => `ar${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

/** A truck on charge with power flowing; `kw` shows on the charger screen. */
export function ChargingMini({ kw, truck = "artic", size = "sm", label }: { kw: number | null; truck?: TruckKind; size?: "sm" | "lg"; label?: string }) {
  const id = useArtId();
  const box = size === "sm" ? `488 ${G - 140} 206 152` : `400 ${G - 168} 372 184`;
  return (
    <svg className={`art mini ${size}`} viewBox={box} role="img" aria-label={label ?? `Charging${kw ? ` at about ${Math.round(kw)} kW` : ""}`}>
      <SceneLayers f={still({ connector: 1, energy: true, power: kw ?? 0 })} truck={truck} access="plate" start="PLUG_AND_CHARGE" plate="" id={id} showGate={false} bubbles={false} />
    </svg>
  );
}

/** An empty bay under the canopy, charger waiting. */
export function EmptyBayArt({ label = "A free charging bay" }: { label?: string }) {
  const id = useArtId();
  return (
    <svg className="art empty-art" viewBox={`470 ${G - 186} 300 204`} role="img" aria-label={label}>
      <SceneLayers f={still({})} truck="artic" access="plate" start="PLUG_AND_CHARGE" plate="" id={id} showTruck={false} showGate={false} bubbles={false} />
    </svg>
  );
}

/** A parked electric truck, side on. */
export function TruckArt({ truck = "artic", label = "Electric truck", port = "idle" }: { truck?: TruckKind; label?: string; port?: "idle" | "linked" | "charging" | "done" }) {
  const spec = TRUCKS[truck];
  const pad = 14;
  return (
    <svg className="art truck-art" viewBox={`${PARK_FRONT - spec.length - pad} ${G - 122} ${spec.length + pad * 2} 132`} role="img" aria-label={label}>
      <line x1={PARK_FRONT - spec.length - pad} y1={G + 0.5} x2={PARK_FRONT + pad} y2={G + 0.5} className="a-kerb" />
      <Truck kind={truck} front={PARK_FRONT} braking={false} port={port} />
    </svg>
  );
}
