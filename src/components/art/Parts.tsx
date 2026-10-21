// Illustration parts: an electric HGV (articulated or rigid), the charger, cable and connector,
// the depot gate (barrier with ANPR camera or keypad), canopy and road. Colours come from CSS
// classes (see "illustrations" in app.css), so the art follows the brand colour and dark mode.
import { memo, type ReactNode } from "react";
import {
  BX, CAM_X, CX, G, GATE_FRONT, H, KEY_X, PARK_FRONT, TRUCKS, W, cablePath, connectorAt, easeOutBack,
  type AccessKind, type Frame, type StartKind, type TruckKind,
} from "./scene";

export type PortState = "idle" | "linked" | "charging" | "done";

function Wheel({ x, r, turn }: { x: number; r: number; turn: number }) {
  const deg = ((turn / r) * 180) / Math.PI;
  return (
    <g transform={`translate(${x} ${-r}) rotate(${deg.toFixed(1)})`}>
      <circle r={r} className="a-tyre" />
      <circle r={r * 0.6} className="a-rim" />
      <circle r={r * 0.22} className="a-hub" />
      {[0, 72, 144, 216, 288].map((a) => (
        <circle key={a} cx={Math.cos((a * Math.PI) / 180) * r * 0.42} cy={Math.sin((a * Math.PI) / 180) * r * 0.42} r={r * 0.075} className="a-hub" />
      ))}
    </g>
  );
}

/** Cab drawn in artic coordinates (x 262..332); `o` shifts it for the rigid. */
function Cab({ o, driver = true }: { o: number; driver?: boolean }) {
  return (
    <g transform={`translate(${o} 0)`}>
      {/* roof fairing */}
      <path d="M 266 -101 Q 270 -112 286 -113 H 312 Q 318 -113 318 -105 L 318 -101 Z" className="a-body" />
      <path d="M 266 -101 Q 270 -112 286 -113 H 312 Q 318 -113 318 -105" className="a-seam" />
      {/* cab body */}
      <path d="M 276 -104 H 318 Q 325 -104 327 -97 L 331 -54 V -31 H 270 V -98 Q 270 -104 276 -104 Z" className="a-body" />
      <path d="M 270 -58 H 330.6 V -31 H 270 Z" className="a-body-2" />
      <rect x={281} y={-97} width={31} height={61} rx={2} className="a-seam" />
      {/* side window with the driver */}
      <rect x={284} y={-94} width={24} height={22} rx={2.5} className="a-glass" />
      {driver && (
        <g className="a-driver">
          <circle cx={298} cy={-84.5} r={3.6} />
          <path d="M 291.5 -72 Q 292.5 -79.5 298 -79.5 Q 303.5 -79.5 304.5 -72 Z" />
        </g>
      )}
      <path d="M 287 -92 H 293 L 287.5 -76 Z" className="a-glare" />
      {/* windscreen edge, mirror, lights */}
      <path d="M 318.5 -100.5 L 325.5 -93.5 L 328.2 -66 H 320 Z" className="a-glass" />
      <rect x={328} y={-91} width={4.5} height={13} rx={1.6} className="a-trim" />
      <rect x={324} y={-87} width={5} height={2} className="a-trim" />
      <rect x={327.5} y={-52} width={4} height={21} rx={1} className="a-trim" />
      <rect x={326.5} y={-58} width={4.5} height={5} rx={1.2} className="a-headlight" />
      <rect x={286} y={-66} width={7} height={7} rx={1.8} className="a-livery" />
      <rect x={298} y={-35} width={14} height={3} rx={1} className="a-trim" />
      {/* front wheel arch */}
      <path d="M 291 -31 A 19 19 0 0 1 329 -31 Z" className="a-arch" />
    </g>
  );
}

function Port({ x, state }: { x: number; state: PortState }) {
  return (
    <g transform={`translate(${x} -40)`}>
      <rect x={-5.5} y={-5.5} width={11} height={11} rx={2.5} className="a-trim" />
      <circle r={3} className={`a-port ${state}`} />
      {(state === "linked" || state === "charging") && <circle r={7} className="a-port-ring" />}
    </g>
  );
}

export function Truck({ kind, front, braking, port, plate }: { kind: TruckKind; front: number; braking: boolean; port: PortState; plate?: string }) {
  const spec = TRUCKS[kind];
  const left = front - spec.length;
  const turn = front; // wheels roll with distance travelled
  return (
    <g transform={`translate(${left.toFixed(2)} ${G})`} className="a-truck">
      <ellipse cx={spec.length / 2} cy={1} rx={spec.length / 2 + 6} ry={4} className="a-shadow" />
      {kind === "artic" ? (
        <>
          {/* trailer */}
          <rect x={0} y={-100} width={262} height={70} rx={3} className="a-body-2" />
          <rect x={0} y={-100} width={262} height={7} rx={3} className="a-body" />
          {Array.from({ length: 9 }, (_, i) => <line key={i} x1={(i + 1) * 26.2} y1={-93} x2={(i + 1) * 26.2} y2={-36} className="a-seam" />)}
          <rect x={0} y={-38} width={262} height={3} className="a-livery" />
          <rect x={1.5} y={-96} width={3} height={58} className="a-seam-fill" />
          <rect x={8} y={-30} width={254} height={6} className="a-chassis" />
          <rect x={-1} y={-29} width={6} height={11} className="a-chassis" />
          <rect x={-1.5} y={-47} width={3.5} height={7} rx={1} className={braking ? "a-brake on" : "a-brake"} />
          <rect x={13} y={-31} width={84} height={4} rx={1.5} className="a-trim" />
          <rect x={100} y={-26} width={94} height={2.5} className="a-trim" />
          <rect x={100} y={-20} width={94} height={2.5} className="a-trim" />
          <rect x={206} y={-30} width={5} height={18} className="a-trim" />
          <rect x={202.5} y={-13} width={12} height={3} rx={1} className="a-trim" />
          {/* tractor chassis, fifth wheel and batteries */}
          <rect x={232} y={-31} width={95} height={8} className="a-chassis" />
          <rect x={240} y={-35} width={24} height={5} rx={1} className="a-trim" />
          <rect x={262} y={-47} width={36} height={19} rx={3} className="a-battery" />
          <rect x={264} y={-45} width={32} height={2} rx={1} className="a-livery" />
          <Cab o={0} />
          <Port x={spec.port} state={port} />
        </>
      ) : (
        <>
          <rect x={0} y={-100} width={168} height={66} rx={3} className="a-body-2" />
          <rect x={0} y={-100} width={168} height={7} rx={3} className="a-body" />
          {Array.from({ length: 5 }, (_, i) => <line key={i} x1={(i + 1) * 28} y1={-93} x2={(i + 1) * 28} y2={-40} className="a-seam" />)}
          <rect x={0} y={-42} width={168} height={3} className="a-livery" />
          <rect x={4} y={-31} width={226} height={8} className="a-chassis" />
          <rect x={-1.5} y={-47} width={3.5} height={7} rx={1} className={braking ? "a-brake on" : "a-brake"} />
          <rect x={22} y={-36} width={44} height={4} rx={1.5} className="a-trim" />
          <rect x={92} y={-47} width={60} height={19} rx={3} className="a-battery" />
          <rect x={94} y={-45} width={56} height={2} rx={1} className="a-livery" />
          <Cab o={-98} />
          <Port x={spec.port} state={port} />
        </>
      )}
      {spec.wheels.map((w) => <Wheel key={w.x} x={w.x} r={w.r} turn={turn} />)}
      {plate && <title>{plate}</title>}
    </g>
  );
}

export function Charger({ power, state }: { power: number; state: PortState }) {
  return (
    <g className="a-charger">
      <rect x={CX - 29} y={G - 8} width={58} height={8} rx={2} className="a-plinth" />
      <rect x={CX - 20} y={G - 133} width={40} height={125} rx={9} className="a-body a-outline" />
      <rect x={CX - 20} y={G - 124} width={5} height={108} rx={2.5} className={`a-strip ${state}`} />
      <rect x={CX - 12} y={G - 120} width={27} height={31} rx={4} className="a-screen" />
      {state === "idle" && (
        <g className="a-screen-ink" transform={`translate(${CX + 1.5} ${G - 104.5})`}>
          <path d="M -4 -6 V -2 M 4 -6 V -2 M -6 -2 H 6 V 1 Q 6 6 0 6 Q -6 6 -6 1 Z M 0 6 V 9" className="a-screen-line" />
        </g>
      )}
      {state === "charging" && power >= 1 && (
        <g>
          <text x={CX + 1.5} y={G - 103} className="a-kw" textAnchor="middle">{Math.round(power)}</text>
          <text x={CX + 1.5} y={G - 94.5} className="a-kw-unit" textAnchor="middle">kW</text>
        </g>
      )}
      {(state === "linked" || (state === "charging" && power < 1)) && (
        <g transform={`translate(${CX + 1.5} ${G - 104.5})`}>
          {[-6, 0, 6].map((dx, i) => <circle key={dx} cx={dx} r={1.8} className="a-dot" style={{ animationDelay: `${i * 0.15}s` }} />)}
        </g>
      )}
      {state === "done" && <path d={`M ${CX - 5} ${G - 104} l 4 4 l 8 -9`} className="a-screen-ok" />}
      <circle cx={CX + 1.5} cy={G - 80} r={2.3} className={`a-led ${state}`} />
      <rect x={CX - 27} y={G - 72} width={8} height={18} rx={2} className="a-trim" />
      <rect x={CX - 10} y={G - 40} width={23} height={3} rx={1.5} className="a-seam-fill" />
      <rect x={CX - 10} y={G - 34} width={23} height={3} rx={1.5} className="a-seam-fill" />
    </g>
  );
}

export function Cable({ k, energy, portX }: { k: number; energy: boolean; portX: number }) {
  const c = connectorAt(k, { x: portX + 1, y: G - 40 });
  const d = cablePath({ x: c.x + (k > 0.5 ? 6 : 0), y: c.y });
  return (
    <g>
      <path d={d} className="a-cable" />
      {energy && <path d={d} className="a-energy" />}
      <g transform={`translate(${c.x.toFixed(2)} ${c.y.toFixed(2)}) rotate(${c.angle.toFixed(1)})`}>
        <rect x={-2} y={-5} width={17} height={10} rx={3} className="a-plug" />
        <rect x={-5} y={-3.5} width={4} height={7} rx={1} className="a-plug-tip" />
      </g>
    </g>
  );
}

function Gate({ access, f }: { access: AccessKind; f: Frame }) {
  const angle = -84 * f.barrier;
  return (
    <g>
      {access === "plate" ? (
        <g>
          <rect x={CAM_X - 2} y={G - 132} width={4} height={132} className="a-trim" />
          <rect x={CAM_X - 20} y={G - 140} width={24} height={12} rx={3.5} className="a-body a-outline" />
          <rect x={CAM_X - 1} y={G - 142} width={6} height={4} rx={1} className="a-trim" />
          <circle cx={CAM_X - 19} cy={G - 134} r={3.2} className="a-lens" />
        </g>
      ) : (
        <g>
          <rect x={KEY_X - 3} y={G - 70} width={6} height={70} className="a-trim" />
          <rect x={KEY_X - 12} y={G - 96} width={24} height={28} rx={4} className="a-body a-outline" />
          <rect x={KEY_X - 9} y={G - 92} width={18} height={7} rx={1.5} className="a-screen" />
          {[0, 1, 2, 3].map((i) => <circle key={i} cx={KEY_X - 5.4 + i * 3.6} cy={G - 88.5} r={1.1} className={i < f.digits ? "a-key on" : "a-key"} />)}
          {[0, 1, 2].map((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={KEY_X - 8 + c * 6} y={G - 82 + r * 4.4} width={4} height={2.8} rx={0.8} className="a-seam-fill" />))}
        </g>
      )}
      <rect x={BX - 5} y={G - 50} width={10} height={50} rx={2.5} className="a-body-2 a-outline" />
      <g transform={`rotate(${angle.toFixed(1)} ${BX} ${G - 43})`}>
        <rect x={BX} y={G - 46} width={104} height={6} rx={3} className="a-barrier" />
        {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={BX + 8 + i * 19} y={G - 46} width={9} height={6} className="a-barrier-band" />)}
      </g>
      <circle cx={BX} cy={G - 43} r={4} className="a-trim" />
      <circle cx={BX} cy={G - 54} r={2.4} className={f.barrier > 0.05 ? "a-gate-led open" : "a-gate-led"} />
    </g>
  );
}

function Beam({ f, id }: { f: Frame; id: string }) {
  if (f.beam <= 0.01) return null;
  const lens = { x: CAM_X - 21, y: G - 134 };
  const top = G - 76;
  const bottom = G - 30;
  const tx = GATE_FRONT + 3;
  const sy = top + (bottom - top) * (0.5 - 0.5 * Math.cos(f.scan * Math.PI * 3));
  return (
    <g opacity={f.beam}>
      <polygon points={`${lens.x},${lens.y} ${tx},${top} ${tx},${bottom}`} fill={`url(#${id}-beam)`} />
      <line x1={lens.x} y1={lens.y} x2={tx} y2={sy} className="a-scan" />
      <circle cx={tx} cy={sy} r={2.2} className="a-scan-dot" />
    </g>
  );
}

// Static layers are memoised: the story re-renders every animation frame.
const Backdrop = memo(function Backdrop({ id }: { id: string }) {
  return (
    <g>
      <rect x={-200} y={0} width={W + 400} height={G} fill={`url(#${id}-sky)`} />
      {/* warehouse behind the gate */}
      <path d={`M -40 ${G} V ${G - 74} L 60 ${G - 92} L 170 ${G - 74} V ${G} Z`} className="a-far" />
      {[0, 1, 2].map((i) => <rect key={i} x={-14 + i * 54} y={G - 50} width={38} height={50} className="a-far-2" />)}
      {/* charging canopy */}
      <rect x={506} y={G - 166} width={7} height={166} className="a-column" />
      <rect x={751} y={G - 166} width={7} height={166} className="a-column" />
      {[548, 628, 708].map((x) => <polygon key={x} points={`${x - 10},${G - 160} ${x + 10},${G - 160} ${x + 46},${G} ${x - 46},${G}`} className="a-cone" />)}
      <rect x={496} y={G - 178} width={276} height={12} rx={2} className="a-roof" />
      <rect x={496} y={G - 166} width={276} height={3} className="a-strip charging" />
      {[548, 628, 708].map((x) => <rect key={x} x={x - 10} y={G - 163} width={20} height={3} rx={1.5} className="a-lamp" />)}
      <g transform={`translate(712 ${G - 150})`}>
        <rect x={-15} y={0} width={30} height={16} rx={3} className="a-sign" />
        <text x={0} y={11.5} textAnchor="middle" className="a-sign-text">M2</text>
        <line x1={0} y1={-12} x2={0} y2={0} className="a-seam" />
      </g>
    </g>
  );
});

const Road = memo(function Road() {
  return (
    <g>
      <rect x={-200} y={G} width={W + 400} height={H - G} className="a-road" />
      <line x1={-200} y1={G + 0.5} x2={W + 200} y2={G + 0.5} className="a-kerb" />
      <line x1={-200} y1={G + 17} x2={W + 200} y2={G + 17} className="a-lane" />
      <rect x={516} y={G + 3} width={226} height={9} rx={1} className="a-bay" />
    </g>
  );
});

export function Bubble({ x, y, k, w, children, flip }: { x: number; y: number; k: number; w: number; children: ReactNode; flip?: boolean }) {
  if (k <= 0.01) return null;
  const s = 0.55 + 0.45 * easeOutBack(Math.min(1, k));
  const left = flip ? -w + 18 : -w / 2;
  return (
    <g transform={`translate(${x} ${y}) scale(${s.toFixed(3)})`} opacity={Math.min(1, k * 1.6)} className="a-bubble">
      <rect x={left} y={-40} width={w} height={30} rx={10} className="a-bubble-bg" />
      <path d="M -6 -10.5 L 0 -3 L 6 -10.5 Z" className="a-bubble-bg" />
      <g transform={`translate(${left} -40)`}>{children}</g>
    </g>
  );
}

function OkTick({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={7} className="a-ok" />
      <path d="M -3 0 L -0.8 2.4 L 3.4 -2.4" className="a-ok-tick" />
    </g>
  );
}

function BatteryPill({ x, y, level, k }: { x: number; y: number; level: number; k: number }) {
  if (k <= 0.01) return null;
  return (
    <g transform={`translate(${x} ${y})`} opacity={k}>
      <rect x={0} y={0} width={78} height={24} rx={12} className="a-bubble-bg" />
      <rect x={9} y={7} width={30} height={10} rx={2.5} className="a-batt" />
      <rect x={39.5} y={10} width={2.5} height={4} rx={1} className="a-batt-cap" />
      <rect x={10.5} y={8.5} width={Math.max(1, 27 * level)} height={7} rx={1.5} className="a-batt-fill" />
      <text x={48} y={16.5} className="a-text strong">{Math.round(level * 100)}%</text>
    </g>
  );
}

export interface SceneProps {
  f: Frame;
  truck: TruckKind;
  access: AccessKind;
  start: StartKind;
  plate: string;
  id: string;
  showTruck?: boolean;
  showGate?: boolean;
  bubbles?: boolean;
}

/** One frame of the depot: gate, road, canopy, truck, charger, cable and status bubbles. */
export function SceneLayers({ f, truck, access, start, plate, id, showTruck = true, showGate = true, bubbles = true }: SceneProps) {
  const spec = TRUCKS[truck];
  const portParked = PARK_FRONT - spec.length + spec.port;
  const state: PortState = f.done ? (f.connector > 0.02 ? "done" : "idle") : f.energy ? "charging" : f.connector > 0.98 ? "linked" : "idle";
  const chargerState: PortState = f.done && f.t < 20.2 ? "done" : state;
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="a-sky-top" />
          <stop offset="1" className="a-sky-bottom" />
        </linearGradient>
        <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" className="a-beam-a" />
          <stop offset="1" className="a-beam-b" />
        </linearGradient>
      </defs>
      <Backdrop id={id} />
      <Road />
      {showGate && <Gate access={access} f={f} />}
      {showGate && access === "plate" && <Beam f={f} id={id} />}
      {showTruck && <Truck kind={truck} front={f.front} braking={f.braking} port={f.connector > 0.98 ? state : "idle"} plate={plate} />}
      <Charger power={f.power} state={chargerState} />
      <Cable k={f.connector} energy={f.energy} portX={portParked} />
      {bubbles && (
        <>
          {access === "plate" ? (
            <Bubble x={CAM_X - 12} y={G - 146} k={f.idBubble} w={156}>
              <rect x={10} y={7} width={70} height={16} rx={2.5} className="a-plate" />
              <text x={45} y={19} textAnchor="middle" className="a-plate-text">{plate}</text>
              <OkTick x={93} y={15} />
              <text x={104} y={19} className="a-text">Booked</text>
            </Bubble>
          ) : (
            <Bubble x={KEY_X} y={G - 100} k={f.idBubble} w={124}>
              <OkTick x={16} y={15} />
              <text x={28} y={19} className="a-text">Code accepted</text>
            </Bubble>
          )}
          <Bubble x={portParked} y={G - 120} k={f.handshake} w={start === "PLUG_AND_CHARGE" ? 168 : 150}>
            <OkTick x={16} y={15} />
            <text x={28} y={19} className="a-text">{start === "PLUG_AND_CHARGE" ? "Plug & Charge contract OK" : "Vehicle ID recognised"}</text>
          </Bubble>
          <Bubble x={CX - 6} y={G - 140} k={f.receipt} w={170} flip>
            <OkTick x={16} y={15} />
            <text x={28} y={19} className="a-text">Charge record to your fleet</text>
          </Bubble>
          <BatteryPill x={PARK_FRONT - 92} y={G - 150} level={f.level} k={f.battery} />
        </>
      )}
    </>
  );
}
