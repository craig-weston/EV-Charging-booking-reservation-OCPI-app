// Offline schematic map of Great Britain (Natural Earth coastline + motorway network). No tile
// server, API key or third-party requests: it renders the same in production, previews and offline.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CITIES, LAND_OTHER, LAND_UK, MAP_H, MAP_W, MOTORWAYS, ROAD_LABELS, TRUNK_ROADS, latToY, lonToX } from "../map/ukmap";
import { Icon } from "../ui/ui";

export interface MapPin {
  key: string;
  lat: number;
  lon: number;
  label: string;
  /** "open" / "opensel": a public site from open data, shown but not bookable here. */
  state: "fit" | "unfit" | "sel" | "plain" | "open" | "opensel";
  /** Public sites: built for trucks, or bay size not published. */
  tone?: "trucks" | "check";
  /** A short price shown on the pin, e.g. "59p". */
  price?: string | null;
  /** The cheapest site: marked so it stands out. */
  best?: boolean;
  /** Lower draws its price first when pins crowd (e.g. cheaper first). */
  rank?: number;
}

interface View { cx: number; cy: number; s: number } // centre (map units) and map units per pixel

const PILL_H = 24;
const pillW = (t: string) => Math.round(t.length * 7.8 + 18);

type Box = { x0: number; y0: number; x1: number; y1: number };

/** Place names and road numbers a price tag (or its CHEAPEST caption) would cover: they're hidden,
 *  since the tag is what matters there. `tags` are in screen pixels from the view's corner. */
export function labelsUnderTags(tags: Box[], vb: { x: number; y: number }, u: number): { hiddenCities: Set<string>; hiddenRoads: Set<string> } {
  const covered = (b: Box) => tags.some((t) => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0);
  const hiddenCities = new Set(CITIES.filter((c) => {
    const sx = (c.x - vb.x) / u, sy = (c.y - vb.y) / u, fs = c.rank === 1 ? 12.5 : 11.5;
    return covered({ x0: sx - 3, y0: sy - 4 - fs, x1: sx + 5 + c.name.length * fs * 0.58, y1: sy + 3 });
  }).map((c) => c.name));
  const hiddenRoads = new Set(ROAD_LABELS.filter((r) => {
    const sx = (r.x - vb.x) / u, sy = (r.y - vb.y) / u, w = r.ref.length * 6.4 + 8;
    return covered({ x0: sx - w / 2, y0: sy - 7, x1: sx + w / 2, y1: sy + 7 });
  }).map((r) => r.ref));
  return { hiddenCities, hiddenRoads };
}

export function NetworkMap({ pins, near, onSelect, focusKey, fitKeys, hoverKey, onHover, legend, credit }: {
  pins: MapPin[];
  near?: { lat: number; lon: number } | null;
  onSelect?(key: string): void;
  focusKey?: string | null;
  fitKeys?: string[];
  /** A site highlighted elsewhere (e.g. hovered in the list). */
  hoverKey?: string | null;
  onHover?(key: string | null): void;
  /** A small key or summary in the corner. */
  legend?: ReactNode;
  /** Credit for data shown on the map, after the base map's. */
  credit?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 700 });
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ d: number; s: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 600, h: el.clientHeight || 700 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 600, h: el.clientHeight || 700 });
    return () => ro.disconnect();
  }, []);

  const clampS = useCallback((s: number) => {
    const minS = Math.max(MAP_W / size.w, MAP_H / size.h) / 10;
    const maxS = Math.max(MAP_W / size.w, MAP_H / size.h) * 1.15;
    return Math.min(maxS, Math.max(minS, s));
  }, [size]);

  const fit = useCallback((keys?: string[]) => {
    const sel = keys?.length ? pins.filter((p) => keys.includes(p.key)) : pins;
    if (!sel.length) {
      setView({ cx: MAP_W / 2, cy: MAP_H * 0.62, s: clampS(Math.max(MAP_W / size.w, MAP_H / size.h)) });
      return;
    }
    const xs = sel.map((p) => lonToX(p.lon));
    const ys = sel.map((p) => latToY(p.lat));
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const s = clampS(Math.max((x1 - x0 + 160) / size.w, (y1 - y0 + 160) / size.h, MAP_W / size.w / 4));
    setView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s });
  }, [pins, size, clampS]);

  // initial fit (and refit when the container changes a lot)
  const fitSig = (fitKeys ?? pins.map((p) => p.key)).join(",");
  useEffect(() => {
    fit(fitKeys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSig, size.w > 0 && size.h > 0 ? Math.round(size.w / 200) + "x" + Math.round(size.h / 200) : ""]);

  // pan to a focused pin when it is outside the middle of the view
  useEffect(() => {
    if (!focusKey || !view) return;
    const p = pins.find((x) => x.key === focusKey);
    if (!p) return;
    const x = lonToX(p.lon), y = latToY(p.lat);
    const halfW = (size.w * view.s) / 2, halfH = (size.h * view.s) / 2;
    if (Math.abs(x - view.cx) > halfW * 0.6 || Math.abs(y - view.cy) > halfH * 0.6) setView({ ...view, cx: x, cy: y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const v = view ?? { cx: MAP_W / 2, cy: MAP_H / 2, s: Math.max(MAP_W / size.w, MAP_H / size.h) };
  const vb = { x: v.cx - (size.w * v.s) / 2, y: v.cy - (size.h * v.s) / 2, w: size.w * v.s, h: size.h * v.s };
  const k = MAP_W / size.w / v.s; // zoom factor relative to "whole width"

  const zoomAt = (factor: number, px?: number, py?: number) => {
    setView((cur) => {
      const c = cur ?? v;
      const s = clampS(c.s / factor);
      const ox = px ?? size.w / 2, oy = py ?? size.h / 2;
      const mx = c.cx - (size.w * c.s) / 2 + ox * c.s;
      const my = c.cy - (size.h * c.s) / 2 + oy * c.s;
      return { s, cx: mx - (ox - size.w / 2) * s, cy: my - (oy - size.h / 2) * s };
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  // React's onWheel is passive; prevent page scroll with a native listener.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: v.s };
    } else drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const s = clampS(pinchStart.current.s * (pinchStart.current.d / d));
      setView((c) => ({ ...(c ?? v), s }));
      return;
    }
    const dr = drag.current;
    if (!dr || dr.id !== e.pointerId) return;
    const dx = e.clientX - dr.x, dy = e.clientY - dr.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dr.moved = true;
    dr.x = e.clientX;
    dr.y = e.clientY;
    setView((c) => {
      const cur = c ?? v;
      return { ...cur, cx: cur.cx - dx * cur.s, cy: cur.cy - dy * cur.s };
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (drag.current?.id === e.pointerId) setTimeout(() => (drag.current = null), 0);
  };

  const u = v.s; // one screen pixel in map units
  const cityRank = k > 4 ? 4 : k > 2.4 ? 3 : k > 1.5 ? 2 : 1;
  const sortedPins = useMemo(() => {
    const order = { open: -1, unfit: 0, plain: 1, fit: 2, opensel: 3, sel: 3 } as const;
    return [...pins].sort((a, b) => order[a.state] - order[b.state]);
  }, [pins]);

  // Price tags where they fit: the selected, hovered and cheapest sites first, then cheaper before
  // dearer. A tag that would cover another becomes a dot (its price shows on hover).
  const placed = useMemo(() => {
    const scr = (p: MapPin) => ({ sx: (lonToX(p.lon) - vb.x) / u, sy: (latToY(p.lat) - vb.y) / u });
    const prio = (p: MapPin) => (p.state === "sel" ? -3 : p.key === hoverKey ? -2 : p.best ? -1 : 0) * 1e6 + (p.rank ?? 1e5);
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const pill = new Map<string, boolean>();
    for (const p of [...pins].filter((x) => x.price && x.state !== "unfit").sort((a, b) => prio(a) - prio(b))) {
      const { sx, sy } = scr(p);
      const w = pillW(p.price!), r = { x0: sx - w / 2 - 3, y0: sy - 9 - PILL_H - (p.best ? 14 : 3), x1: sx + w / 2 + 3, y1: sy + 3 };
      const clash = taken.some((t) => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
      pill.set(p.key, !clash);
      if (!clash) taken.push(r);
    }
    // Draw order: public sites, unfit, then dots, then tags, with the important ones last (on top).
    // Public sites outside the view aren't drawn (there can be thousands).
    const pad = 30 * u;
    const inView = (x: number, y: number) => x > vb.x - pad && x < vb.x + vb.w + pad && y > vb.y - pad && y < vb.y + vb.h + pad;
    const layer = (q: MapPin) => (q.state === "open" ? -2 : q.state === "unfit" ? -1 : 0);
    const list = sortedPins.map((p) => ({ p, x: lonToX(p.lon), y: latToY(p.lat), pill: pill.get(p.key) ?? false }))
      .filter((q) => q.p.state !== "open" || inView(q.x, q.y))
      .sort((a, b) => layer(a.p) - layer(b.p) || Number(a.pill) - Number(b.pill) || prio(b.p) - prio(a.p));
    return { list, ...labelsUnderTags(taken, vb, u) };
  }, [pins, sortedPins, hoverKey, vb.x, vb.y, vb.w, vb.h, u]);

  return (
    <div className="map" ref={box} onWheel={onWheel}>
      <svg
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        role="group" aria-label="Map of charging sites"
      >
        <path className="land-other" d={LAND_OTHER} />
        <path className="land" d={LAND_UK} />
        {k > 1.25 && <path className="trunk" d={TRUNK_ROADS} />}
        <path className="motorway" d={MOTORWAYS} />
        {k > 1.15 && ROAD_LABELS.filter((r) => !placed.hiddenRoads.has(r.ref)).map((r) => {
          const w = (r.ref.length * 6.4 + 8) * u, h = 14 * u;
          return (
            <g key={r.ref} className="road-label" transform={`translate(${r.x} ${r.y})`}>
              <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={2.5 * u} />
              <text textAnchor="middle" dominantBaseline="central" fontSize={10.5 * u}>{r.ref}</text>
            </g>
          );
        })}
        {CITIES.filter((c) => c.rank <= cityRank && !placed.hiddenCities.has(c.name)).map((c) => (
          <g key={c.name} className="city">
            <circle cx={c.x} cy={c.y} r={2 * u} />
            <text x={c.x + 5 * u} y={c.y - 4 * u} fontSize={(c.rank === 1 ? 12.5 : 11.5) * u}>{c.name}</text>
          </g>
        ))}
        {near && (
          <g className="near">
            <circle cx={lonToX(near.lon)} cy={latToY(near.lat)} r={16 * u} strokeWidth={1.5} />
          </g>
        )}
        {placed.list.map(({ p, x, y, pill }) => {
          const hot = p.key === hoverKey;
          if (p.state === "open" || p.state === "opensel") {
            const sel = p.state === "opensel";
            const r = (sel ? 7 : hot ? 6 : k > 2.4 ? 5 : 4) * u;
            return (
              <g key={p.key} className={`pin open ${p.tone ?? "check"}${sel ? " sel" : ""}${hot ? " hot" : ""}`} transform={`translate(${x} ${y})`}
                role="button" tabIndex={0} aria-label={`${p.label}, public site, not bookable here yet`}
                onClick={() => { if (!drag.current?.moved) onSelect?.(p.key); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(p.key); } }}
                onMouseEnter={() => onHover?.(p.key)} onMouseLeave={() => onHover?.(null)} onFocus={() => onHover?.(p.key)} onBlur={() => onHover?.(null)}>
                <rect className="ring" x={-r} y={-r} width={2 * r} height={2 * r} rx={1.5 * u} transform="rotate(45)" strokeWidth={1.75} />
                {(sel || hot) && <text x={r + 6 * u} y={4 * u} fontSize={12.5 * u}>{p.label}</text>}
              </g>
            );
          }
          const priced = !!p.price && p.state !== "unfit";
          const cls = `pin ${p.state}${p.best ? " best" : ""}${hot ? " hot" : ""}${priced ? (pill ? " pill" : " dot") : ""}`;
          const act = {
            role: "button" as const, tabIndex: 0, "aria-label": `${p.label}${p.price ? `, ${p.price} per kWh` : ""}${p.best ? ", cheapest" : ""}`,
            onClick: () => { if (!drag.current?.moved) onSelect?.(p.key); },
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(p.key); } },
            onMouseEnter: () => onHover?.(p.key), onMouseLeave: () => onHover?.(null), onFocus: () => onHover?.(p.key), onBlur: () => onHover?.(null),
          };
          const name = (p.state === "sel" || hot || (!priced && k > 2.2 && p.state !== "unfit")) ? p.label : null;
          if (priced && pill) {
            const w = pillW(p.price!) * u, h = PILL_H * u, lift = 9 * u;
            return (
              <g key={p.key} className={cls} transform={`translate(${x} ${y})`} {...act}>
                <circle className="spot" r={3 * u} />
                <path className="tail" d={`M ${-5 * u} ${-lift - 0.5 * u} L 0 ${-3 * u} L ${5 * u} ${-lift - 0.5 * u} Z`} />
                <rect className="ptag-shadow" x={-w / 2} y={-lift - h + 1.5 * u} width={w} height={h} rx={h / 2} />
                <rect className="ptag" x={-w / 2} y={-lift - h} width={w} height={h} rx={h / 2} />
                <text className="price" x={0} y={-lift - h / 2} textAnchor="middle" dominantBaseline="central" fontSize={13 * u}>{p.price}</text>
                {p.best && <text className="best-cap" x={0} y={-lift - h - 6 * u} textAnchor="middle" fontSize={10.5 * u}>CHEAPEST</text>}
                {name && <text className="name" x={0} y={14 * u} textAnchor="middle" fontSize={12 * u}>{name}</text>}
              </g>
            );
          }
          const r = (p.state === "sel" ? 8 : p.state === "unfit" ? 4.5 : priced ? 5.5 : 6) * u;
          return (
            <g key={p.key} className={cls} transform={`translate(${x} ${y})`} {...act}>
              <circle className="ring" r={r} strokeWidth={2} />
              {name && <text x={r + 5 * u} y={4 * u} fontSize={12.5 * u}>{name}</text>}
            </g>
          );
        })}
      </svg>
      <div className="map-ctrl">
        <button className="btn sm icon-only" onClick={() => zoomAt(1.5)} aria-label="Zoom in"><Icon name="plus" size="sm" /></button>
        <button className="btn sm icon-only" onClick={() => zoomAt(1 / 1.5)} aria-label="Zoom out"><Icon name="minus" size="sm" /></button>
        <button className="btn sm icon-only" onClick={() => fit(fitKeys)} aria-label="Show all sites"><Icon name="layers" size="sm" /></button>
      </div>
      {legend && <div className="map-legend">{legend}</div>}
      <div className="map-note">Natural Earth{credit ? <> · {credit}</> : null}</div>
    </div>
  );
}
