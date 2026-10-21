// "How charging works" as a playable simulation: the truck arrives, the gate recognises it, it
// parks, plugs in, the charger identifies it (Plug & Charge or Autocharge), charges and leaves.
// Autoplays while on screen (never with reduced motion), and every step can be jumped to.
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { DURATION, H, STEPS, TRUCKS, W, frameAt, stepAt, type AccessKind, type StartKind, type TruckKind } from "./scene";
import { SceneLayers } from "./Parts";
import { Icon } from "../../ui/ui";

export type Audience = "driver" | "planner";

export function storyCopy(audience: Audience, access: AccessKind, start: StartKind): { title: string; text: string }[] {
  const d = audience === "driver";
  const pnc = start === "PLUG_AND_CHARGE";
  return [
    d ? { title: "Arrive in your slot", text: "Turn up any time in your booking window. The site is expecting your truck." }
      : { title: "Your driver arrives in the slot", text: "The operator holds a bay for the truck from the booked start time." },
    access === "plate"
      ? (d ? { title: "The camera reads your plate", text: "Booked trucks are let straight in. No card, no app, no intercom." }
        : { title: "The camera reads the plate", text: "Booked plates open the barrier automatically, so there are no cards to hand out." })
      : (d ? { title: "Key in your access code", text: "Use the code your fleet desk sent with this booking." }
        : { title: "Your driver keys in the gate code", text: "This site uses an access code. Send it with the driver's pass." }),
    d ? { title: "Pull up to a free charger", text: "Use a free bay of the type on your pass. Drive-through lanes mean no reversing." }
      : { title: "They pull up to a free charger", text: "Bays are matched to the truck's size, connector and load before you book." },
    pnc
      ? (d ? { title: "Plug in", text: "The charger checks your truck's Plug & Charge contract in about a second." }
        : { title: "Plug in, the truck identifies itself", text: "Its Plug & Charge contract tells the operator which fleet pays. No RFID card." })
      : (d ? { title: "Plug in", text: "The charger recognises your truck's vehicle ID straight away." }
        : { title: "Plug in, the truck identifies itself", text: "Autocharge reads the vehicle ID and the operator checks with this app that the truck is booked." }),
    d ? { title: "Charging starts by itself", text: "Take your break. Your fleet can see the session live." }
      : { title: "Charging starts by itself", text: "Power, energy and battery level appear live on the dashboard while the truck charges." },
    d ? { title: "Unplug and drive off", text: "Leave before your slot ends. The charge record goes straight to your fleet." }
      : { title: "Unplug and go", text: "The charge record arrives with the booking reference, ready for billing." },
  ];
}

export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const on = () => setReduce(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

/** True while the element is on screen and the tab is visible: animation pauses otherwise. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return inView && visible;
}

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function ChargeStory({
  truck = "artic", access = "plate", start = "PLUG_AND_CHARGE", plate = "PN74 EVH", maxKw = 350,
  audience = "planner", autoPlay = true, className = "",
}: {
  truck?: TruckKind;
  access?: AccessKind;
  start?: StartKind;
  plate?: string;
  maxKw?: number;
  audience?: Audience;
  autoPlay?: boolean;
  className?: string;
}) {
  const id = `st${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const reduce = useReducedMotion();
  const box = useRef<HTMLElement>(null);
  const onScreen = useOnScreen(box);
  const width = useWidth(box);
  const [playing, setPlaying] = useState(() => autoPlay && !reduce);
  const [t, setT] = useState(() => (autoPlay && !reduce ? 0 : STEPS[0].settle));

  useEffect(() => {
    if (!playing || !onScreen) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setT((x) => (x + dt) % DURATION);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, onScreen]);

  const spec = TRUCKS[truck];
  const f = useMemo(() => frameAt(t, { length: spec.length, maxKw }), [t, spec.length, maxKw]);
  const step = stepAt(t);
  const copy = storyCopy(audience, access, start);
  // On narrow screens the camera follows the action instead of shrinking the whole depot.
  const compact = width > 0 && width < 560;
  const vw = compact ? 420 : W;
  const vx = compact ? Math.max(0, Math.min(W - vw, f.focus - vw / 2)) : 0;
  const goTo = (i: number) => {
    const s = STEPS[(i + STEPS.length) % STEPS.length];
    setT(playing ? s.start : s.settle);
  };

  return (
    <figure className={`story ${className}`} ref={box}>
      <div className="story-stage">
        <svg className="art" viewBox={`${vx.toFixed(1)} 0 ${vw} ${H}`} role="img" aria-label={`Step ${step + 1} of ${STEPS.length}: ${copy[step].title}`}>
          <SceneLayers f={f} truck={truck} access={access} start={start} plate={plate} id={id} />
        </svg>
      </div>
      <div className="story-bar">
        <button type="button" className="btn sm ghost icon-only" onClick={() => { if (!playing && t >= DURATION - 0.05) setT(0); setPlaying(!playing); }} aria-label={playing ? "Pause" : "Play"}>
          <Icon name={playing ? "pause" : "play"} size="sm" />
        </button>
        <ol className="story-steps">
          {STEPS.map((s, i) => {
            const fill = i < step ? 1 : i > step ? 0 : (t - s.start) / (s.end - s.start);
            return (
              <li key={s.id}>
                <button type="button" onClick={() => goTo(i)} aria-label={`Step ${i + 1}: ${copy[i].title}`} aria-current={i === step ? "step" : undefined}>
                  <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, fill)).toFixed(3)})` }} />
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" className="btn sm ghost icon-only" onClick={() => goTo(step - 1)} aria-label="Previous step"><Icon name="chevronLeft" size="sm" /></button>
        <button type="button" className="btn sm ghost icon-only" onClick={() => goTo(step + 1)} aria-label="Next step"><Icon name="chevronRight" size="sm" /></button>
      </div>
      <figcaption className="story-caption" key={step}>
        <b>{copy[step].title}</b>
        <span>{copy[step].text}</span>
      </figcaption>
    </figure>
  );
}
