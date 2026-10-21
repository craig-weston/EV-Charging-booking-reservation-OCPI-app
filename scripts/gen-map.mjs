// Regenerates src/map/ukmap.ts — the offline GB base map (coastline, motorway/trunk
// network, cities) used by the network map. Only needed if you want to change the map.
//
// Data: Natural Earth (public domain) — https://github.com/nvkelso/natural-earth-vector
//   geojson/ne_50m_admin_0_countries.geojson
//   geojson/ne_10m_roads.geojson
//   geojson/ne_10m_populated_places_simple.geojson
//
// Usage: node scripts/gen-map.mjs <path-to-natural-earth-geojson-folder>

import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/gen-map.mjs <natural-earth-geojson-dir>");
  process.exit(1);
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

// ---- Projection: Web Mercator, fitted to the GB extent -------------------------
const EXTENT = { west: -8.4, east: 2.1, south: 49.8, north: 58.85 };
const W = 1000;
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => {
  const p = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + p / 2)) / Math.PI) / 2;
};
const scale = W / (mx(EXTENT.east) - mx(EXTENT.west));
const tx = -mx(EXTENT.west) * scale;
const ty = -my(EXTENT.north) * scale;
const H = Math.round(my(EXTENT.south) * scale + ty);
const project = ([lon, lat]) => [mx(lon) * scale + tx, my(lat) * scale + ty];

// ---- Douglas–Peucker simplification ---------------------------------------------
function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = (px - qx) ** 2 + (py - qy) ** 2;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
const r1 = (n) => Math.round(n * 10) / 10;
const toPath = (pts, close) =>
  pts.map((p, i) => `${i ? "L" : "M"}${r1(p[0])} ${r1(p[1])}`).join("") + (close ? "Z" : "");

const inView = ([x, y], m = 60) => x > -m && x < W + m && y > -m && y < H + m;

// ---- Land -----------------------------------------------------------------------
const countries = read("ne_50m_admin_0_countries.geojson").features;
function landPath(codes, tol, minArea) {
  let d = "";
  for (const f of countries) {
    if (!codes.includes(f.properties.ADM0_A3)) continue;
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const ring = poly[0].map(project);
      if (!ring.some((p) => inView(p))) continue;
      // drop tiny islets
      let area = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
        area += x1 * y2 - x2 * y1;
      }
      if (Math.abs(area / 2) < minArea) continue;
      d += toPath(simplify(ring, tol), true);
    }
  }
  return d;
}
const LAND_UK = landPath(["GBR", "IMN"], 0.55, 1.2);
const LAND_OTHER = landPath(["IRL", "FRA", "BEL", "NLD"], 0.9, 4);

// ---- Roads (GB only) ------------------------------------------------------------
const gb = countries.find((f) => f.properties.ADM0_A3 === "GBR").geometry.coordinates;
function inGB([lon, lat]) {
  return gb.some((poly) => {
    const ring = poly[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j];
      if (y1 > lat !== y2 > lat && lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  });
}
const roads = read("ne_10m_roads.geojson").features;
const lines = { motorway: [], trunk: [] };
const refLines = []; // for label snapping
for (const f of roads) {
  const p = f.properties;
  if (!["Major Highway", "Secondary Highway"].includes(p.type)) continue;
  const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const all = parts.flat();
  if (!all.some(([lon, lat]) => lon > -8.4 && lon < 2.1 && lat > 49.8 && lat < 59)) continue;
  if (all.filter(inGB).length / all.length < 0.5) continue;
  const cls = p.type === "Major Highway" || p.expressway === 1 ? "motorway" : "trunk";
  for (const part of parts) {
    const pts = simplify(part.map(project), 0.7);
    lines[cls].push(toPath(pts, false));
    if (cls === "motorway") refLines.push(pts);
  }
}

// ---- Road labels: hint coordinates snapped onto the nearest motorway vertex ------
const LABEL_HINTS = [
  ["M1", 52.62, -1.21], ["M6", 52.83, -2.12], ["M5", 52.08, -2.17], ["M4", 51.53, -1.84],
  ["M25", 51.71, -0.33], ["M62", 53.66, -1.82], ["A1(M)", 53.15, -0.75], ["M74", 55.3, -3.45],
  ["A14", 52.34, -0.4], ["M11", 51.95, 0.2], ["M20", 51.26, 0.62], ["M40", 51.86, -1.13],
  ["M18", 53.47, -1.15], ["M3", 51.2, -1.22], ["M42", 52.42, -1.76], ["M56", 53.34, -2.55],
  ["M90", 56.3, -3.4], ["M180", 53.57, -0.62],
];
const ROAD_LABELS = LABEL_HINTS.map(([ref, lat, lon]) => {
  const [hx, hy] = project([lon, lat]);
  let best = [hx, hy], bd = Infinity;
  for (const pts of refLines) for (const [x, y] of pts) {
    const d = (x - hx) ** 2 + (y - hy) ** 2;
    if (d < bd) { bd = d; best = [x, y]; }
  }
  return { ref, x: r1(best[0]), y: r1(best[1]) };
});

// ---- Cities -----------------------------------------------------------------------
const places = read("ne_10m_populated_places_simple.geojson").features
  .map((f) => f.properties)
  .filter((p) => p.adm0_a3 === "GBR");
const WANT = {
  London: 1, Birmingham: 1, Manchester: 1, Glasgow: 1, Leeds: 2, Newcastle: 2, Liverpool: 2,
  Edinburgh: 2, Cardiff: 2, Bristol: 2, Sheffield: 2, Nottingham: 2, Southampton: 2, Belfast: 2,
  Leicester: 3, Coventry: 3, "Kingston upon Hull": 3, Plymouth: 3, Norwich: 3, Aberdeen: 3,
  Cambridge: 3, Oxford: 3, Ipswich: 3, Peterborough: 3, Carlisle: 3, Exeter: 3, Dover: 3,
  Stoke: 3, York: 3, Dundee: 3, Inverness: 3, Swansea: 3, Preston: 3, Middlesbrough: 3, Reading: 3,
};
const EXTRA = [
  ["Northampton", 52.2405, -0.9027, 3], ["Milton Keynes", 52.0406, -0.7594, 3],
  ["Daventry", 52.2566, -1.16, 4], ["Felixstowe", 51.963, 1.351, 4], ["Warrington", 53.39, -2.597, 4],
  ["Doncaster", 53.5228, -1.1285, 4], ["Preston", 53.7632, -2.7031, 3], ["Lutterworth", 52.4555, -1.2003, 4],
  ["Thurrock", 51.4935, 0.3529, 4], ["Avonmouth", 51.5046, -2.6996, 4], ["Motherwell", 55.7896, -3.9919, 4],
  ["Wakefield", 53.683, -1.4977, 4], ["Corby", 52.4914, -0.6965, 4],
];
const seen = new Set();
const CITIES = [];
for (const p of places) {
  if (!(p.name in WANT) || seen.has(p.name)) continue;
  seen.add(p.name);
  const [x, y] = project([p.longitude, p.latitude]);
  CITIES.push({ name: p.name.replace("Kingston upon Hull", "Hull"), lat: +p.latitude.toFixed(4), lon: +p.longitude.toFixed(4), x: r1(x), y: r1(y), rank: WANT[p.name] });
}
for (const [name, lat, lon, rank] of EXTRA) {
  if (seen.has(name)) continue;
  const [x, y] = project([lon, lat]);
  CITIES.push({ name, lat, lon, x: r1(x), y: r1(y), rank });
}
CITIES.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

// ---- Emit -------------------------------------------------------------------------
const out = `// GENERATED by scripts/gen-map.mjs from Natural Earth (public domain). Do not edit.
// Web Mercator, fitted to Great Britain. x = lonToX(lon), y = latToY(lat) in a ${W}×${H} viewBox.

export const MAP_W = ${W};
export const MAP_H = ${H};
const S = ${scale};
const TX = ${tx};
const TY = ${ty};
export function lonToX(lon: number): number { return ((lon + 180) / 360) * S + TX; }
export function latToY(lat: number): number {
  const p = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(Math.PI / 4 + p / 2)) / Math.PI) / 2) * S + TY;
}
export function xToLon(x: number): number { return ((x - TX) / S) * 360 - 180; }
export function yToLat(y: number): number {
  const n = Math.PI - 2 * Math.PI * ((y - TY) / S);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export const LAND_UK = ${JSON.stringify(LAND_UK)};
export const LAND_OTHER = ${JSON.stringify(LAND_OTHER)};
export const MOTORWAYS = ${JSON.stringify(lines.motorway.join(""))};
export const TRUNK_ROADS = ${JSON.stringify(lines.trunk.join(""))};
export const ROAD_LABELS: { ref: string; x: number; y: number }[] = ${JSON.stringify(ROAD_LABELS)};
export const CITIES: { name: string; lat: number; lon: number; x: number; y: number; rank: number }[] = ${JSON.stringify(CITIES)};
`;
const target = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "map", "ukmap.ts");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);
console.log(`wrote ${target} (${(out.length / 1024).toFixed(1)} KB), ${W}x${H}, cities=${CITIES.length}`);
