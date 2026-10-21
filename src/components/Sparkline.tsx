// A 14-day sparkline for a stat tile: the previous period in the quiet grey, the current one in
// the brand colour with a light wash, an end dot, and a crosshair + tooltip on hover or keyboard.
import { useRef, useState } from "react";

export interface SparkPoint {
  label: string; // e.g. "Wed 15 Oct"
  value: number;
}

const W = 280;
const H = 44;
const PAD = 5; // room for the end dot and its ring

export function Sparkline({ points, split, format, title }: {
  points: SparkPoint[];
  /** Index of the first point of the current period. */
  split: number;
  format(v: number): string;
  /** What is plotted, for screen readers and the table view, e.g. "Energy per day". */
  title: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.value), 1);
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const path = (from: number, to: number) => points.slice(from, to + 1).map((p, k) => `${k ? "L" : "M"}${x(from + k).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points.length - 1;
  const area = `${path(split, last)} L${x(last).toFixed(1)},${H - PAD} L${x(split).toFixed(1)},${H - PAD} Z`;

  const pick = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const rel = ((clientX - r.left) / r.width) * W;
    setActive(Math.max(0, Math.min(last, Math.round(((rel - PAD) / (W - 2 * PAD)) * last))));
  };
  const a = active != null ? points[active] : null;

  return (
    <div
      ref={ref}
      className="spark"
      tabIndex={0}
      role="group"
      aria-label={`${title}, last ${points.length} days. Latest ${format(points[last].value)}. Arrow keys read each day.`}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerLeave={() => setActive(null)}
      onFocus={() => setActive((v) => v ?? last)}
      onBlur={() => setActive(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); setActive((v) => Math.max(0, (v ?? last) - 1)); }
        if (e.key === "ArrowRight") { e.preventDefault(); setActive((v) => Math.min(last, (v ?? last) + 1)); }
      }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="spark-area" d={area} />
        <path className="spark-prev" d={path(0, split)} vectorEffect="non-scaling-stroke" />
        <path className="spark-line" d={path(split, last)} vectorEffect="non-scaling-stroke" />
        {active != null && <line className="spark-cross" x1={x(active)} x2={x(active)} y1={2} y2={H - 2} vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* Dots are HTML so they stay round when the SVG stretches. */}
      <span className="spark-dot" style={{ left: `${(x(active ?? last) / W) * 100}%`, top: `${(y(points[active ?? last].value) / H) * 100}%` }} data-prev={active != null && active < split ? "" : undefined} aria-hidden="true" />
      {a && (
        <span className="spark-tip" style={{ left: `${Math.min(82, Math.max(18, (x(active!) / W) * 100))}%` }} aria-hidden="true">
          <b>{format(a.value)}</b>
          <span>{a.label}</span>
        </span>
      )}
      <span className="sr-only" aria-live="polite">{a ? `${a.label}: ${format(a.value)}` : ""}</span>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>{points.map((p) => <tr key={p.label}><th scope="row">{p.label}</th><td>{format(p.value)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
