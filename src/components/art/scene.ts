// The charging story as a timeline: every frame of the illustration is a pure function of time,
// so the simulation can autoplay, scrub to any step, or freeze on a settled frame (reduced motion).
// Scene units are roughly 20 per metre; y grows downwards and the road is at y = G.

export const W = 760;
export const H = 240;
export const G = 206; // road level
export const BX = 252; // barrier post
export const CAM_X = 300; // ANPR camera pole, clear of the raised barrier arm
export const KEY_X = 233; // gate keypad, within reach of the cab window
export const CX = 652; // charger centre
export const GATE_FRONT = 218; // truck nose when waiting at the barrier
export const PARK_FRONT = 604; // truck nose when parked at the charger
export const HOLSTER = { x: CX - 23, y: G - 62 };
export const CABLE_ROOT = { x: CX - 21, y: G - 92 };

export type TruckKind = "artic" | "rigid";
export type AccessKind = "plate" | "code";
export type StartKind = "PLUG_AND_CHARGE" | "AUTOCHARGE";

export const TRUCKS: Record<TruckKind, { length: number; port: number; wheels: { x: number; r: number }[] }> = {
  artic: { length: 330, port: 292, wheels: [{ x: 30, r: 13 }, { x: 56, r: 13 }, { x: 82, r: 13 }, { x: 246, r: 14 }, { x: 310, r: 14 }] },
  rigid: { length: 232, port: 194, wheels: [{ x: 44, r: 14 }, { x: 212, r: 14 }] },
};

export interface Step {
  id: "arrive" | "identify" | "park" | "plug" | "charge" | "leave";
  start: number;
  end: number;
  /** The frame shown for this step when not animating. */
  settle: number;
}

export const STEPS: Step[] = [
  { id: "arrive", start: 0, end: 3.4, settle: 3.1 },
  { id: "identify", start: 3.4, end: 6.6, settle: 6.2 },
  { id: "park", start: 6.6, end: 10.4, settle: 10.3 },
  { id: "plug", start: 10.4, end: 13.2, settle: 12.9 },
  { id: "charge", start: 13.2, end: 18.6, settle: 17.2 },
  { id: "leave", start: 18.6, end: 23, settle: 21.6 },
];
export const DURATION = 23;

export const stepAt = (t: number) => Math.max(0, STEPS.findIndex((s) => t >= s.start && t < s.end));

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Progress through [a, b], 0..1. */
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeIn = (x: number) => x * x * x;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Rises over [a, a+f], holds, falls over [b-f, b]. */
const window01 = (t: number, a: number, b: number, f = 0.35) => Math.min(seg(t, a, a + f), 1 - seg(t, b - f, b));

export interface Frame {
  t: number;
  front: number; // truck nose x
  moving: boolean;
  braking: boolean;
  barrier: number; // 0 closed, 1 open
  beam: number; // ANPR beam strength
  scan: number; // 0..1 sweep position
  digits: number; // keypad digits entered
  idBubble: number; // plate/code accepted bubble
  connector: number; // 0 in holster, 1 in the truck's port
  handshake: number; // contract / vehicle ID bubble
  power: number; // kW on the charger screen
  level: number; // battery state of charge 0..1
  energy: boolean; // power flowing
  done: boolean; // session finished
  receipt: number; // charge record bubble
  battery: number; // battery pill visibility
  focus: number; // camera centre for cropped (compact) views
}

export function frameAt(t: number, opts: { length: number; maxKw: number }): Frame {
  const offLeft = -opts.length - 40;
  let front: number;
  if (t < 0.2) front = offLeft;
  else if (t < 3) front = lerp(offLeft, GATE_FRONT, easeOut(seg(t, 0.2, 3)));
  else if (t < 6.8) front = GATE_FRONT;
  else if (t < 10) front = lerp(GATE_FRONT, PARK_FRONT, easeInOut(seg(t, 6.8, 10)));
  else if (t < 20) front = PARK_FRONT;
  else front = lerp(PARK_FRONT, W + opts.length + 40, easeIn(seg(t, 20, 22.8)));

  const moving = (t > 0.2 && t < 3) || (t > 6.8 && t < 10) || (t > 20 && t < 22.8);
  const braking = (t > 2.1 && t < 3.6) || (t > 9.1 && t < 10.6);
  const open = easeInOut(seg(t, 5.2, 6)) * (1 - easeInOut(seg(t, 9.8, 10.5)));
  const power = opts.maxKw * easeOut(seg(t, 13.3, 14.3)) * (1 - seg(t, 18.2, 18.7)) * (1 + 0.012 * Math.sin(t * 7));
  const charging = t >= 13.3 && t < 18.6;
  const focus = t < 6.8 ? 250 : t < 10 ? lerp(250, 600, easeInOut(seg(t, 6.8, 10))) : 600;

  return {
    t,
    front,
    moving,
    braking,
    barrier: open,
    beam: window01(t, 3.6, 5.3, 0.25),
    scan: seg(t, 3.7, 5.1),
    digits: Math.min(4, Math.floor(seg(t, 3.7, 4.9) * 5)),
    idBubble: window01(t, 4.5, 7, 0.3),
    connector: easeInOut(seg(t, 10.6, 11.6)) * (1 - easeInOut(seg(t, 18.8, 19.6))),
    handshake: window01(t, 11.7, 13.7, 0.3),
    power: charging ? power : 0,
    level: 0.22 + 0.58 * seg(t, 13.3, 18.4),
    energy: charging,
    done: t >= 18.6,
    receipt: window01(t, 20.2, 23.2, 0.3),
    battery: window01(t, 13.2, 19.4, 0.4),
    focus,
  };
}

/** Where the connector is: from the holster, along a lifted arc, to the truck's port. */
export function connectorAt(k: number, port: { x: number; y: number }) {
  return {
    x: lerp(HOLSTER.x, port.x, k),
    y: lerp(HOLSTER.y, port.y, k) - 26 * Math.sin(Math.PI * k),
    angle: lerp(90, 0, k),
  };
}

/** The cable hangs from the charger to the connector with a droop toward the road. */
export function cablePath(to: { x: number; y: number }) {
  const r = CABLE_ROOT;
  const midX = (r.x + to.x) / 2;
  const low = Math.min(G - 8, Math.max(r.y, to.y) + 38);
  return `M ${r.x} ${r.y} C ${r.x - 6} ${low} ${midX} ${low} ${to.x} ${to.y}`;
}

export function easeOutBack(x: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function truckKindOf(vehicleType: string | null | undefined): TruckKind {
  return vehicleType === "RIGID" || vehicleType === "VAN" || vehicleType === "BUS" ? "rigid" : "artic";
}

/** Plate recognition unless the site only offers codes. */
export function accessKindOf(methods: readonly string[] | null | undefined): AccessKind {
  return !methods?.length || methods.includes("LICENSE_PLATE") || methods.includes("OPEN") ? "plate" : "code";
}
