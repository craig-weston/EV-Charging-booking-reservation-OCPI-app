// The trip on a map: the lorry route (or the straight-line estimate, dashed), where it starts and
// ends, and each charging stop, numbered as in the list beside it.
import { useEffect, useRef, useState } from "react";
import { LAND_OTHER, LAND_UK, MOTORWAYS, latToY, lonToX } from "../map/ukmap";

interface Point { name: string; lat: number; lon: number }

export function TripMap({ line, from, to, stops, real }: { line: [number, number][] | null; from: Point; to: Point; stops: Point[]; real: boolean }) {
  // Labels and markers keep the same size on screen, whatever the map's width.
  const box = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setPx(el.clientWidth || 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const path = (line && line.length > 1 ? line : [[from.lat, from.lon], [to.lat, to.lon]] as [number, number][]).map(([lat, lon]) => [lonToX(lon), latToY(lat)] as const);
  const all = [...path, ...stops.map((s) => [lonToX(s.lon), latToY(s.lat)] as const)];
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  // Frame the trip with some room around it, at the map's own shape (16:9).
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(30, (x1 - x0 + y1 - y0) * 0.12);
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  const ratio = 16 / 9;
  let w = x1 - x0, h = y1 - y0;
  if (w / h < ratio) { const nw = h * ratio; x0 -= (nw - w) / 2; w = nw; } else { const nh = w / ratio; y0 -= (nh - h) / 2; h = nh; }
  const u = w / Math.max(200, px); // one screen pixel
  const end = (p: Point, label: "start" | "end") => {
    const x = lonToX(p.lon), y = latToY(p.lat);
    return (
      <g className={`trip-map-end ${label}`} key={label}>
        <circle cx={x} cy={y} r={5.5 * u} />
        <text x={x + 9 * u} y={y + 4 * u} fontSize={12.5 * u}>{p.name}</text>
      </g>
    );
  };
  return (
    <div className="map trip-map" ref={box}>
      <svg viewBox={`${x0} ${y0} ${w} ${h}`} role="img" aria-label={`Map of the trip from ${from.name} to ${to.name}${real ? " by lorry roads" : " (straight-line estimate)"}, with ${stops.length} charging ${stops.length === 1 ? "stop" : "stops"}`}>
        <path className="land-other" d={LAND_OTHER} />
        <path className="land" d={LAND_UK} />
        <path className="motorway" d={MOTORWAYS} />
        <polyline className={`trip-line${real ? "" : " estimate"}`} points={path.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")} />
        {end(from, "start")}
        {end(to, "end")}
        {stops.map((s, i) => {
          const x = lonToX(s.lon), y = latToY(s.lat);
          return (
            <g key={`${s.name}-${i}`} className="trip-map-stop">
              <circle cx={x} cy={y} r={9 * u} />
              <text x={x} y={y} fontSize={10.5 * u} textAnchor="middle" dominantBaseline="central">{i + 1}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
