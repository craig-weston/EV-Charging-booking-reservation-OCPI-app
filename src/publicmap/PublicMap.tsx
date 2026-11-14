// The public charging map (/map): every public charging site from operators' open data on a street
// map, with search, filters, a list of what's in view and each site's details. "Book a slot" opens
// the app, which asks people to sign in first. No account is needed to look.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cleanOpenSites, type OpenSite, type OpenSitesFile } from "../../shared/opendata/sites";
import { CITIES } from "../map/ukmap";
import { applyBrand } from "../app/brand";
import type { Brand } from "../../shared/model";
import type { GeoJsonSource, LngLat, MapEvent, MapLibreModule, MapLike } from "./maplibre-types";
import {
  FACILITY_LABEL, NO_FILTERS, TRUCKS, access, addressLine, breakCharge, checklist, directionsUrl, hasMcs, inBounds, isFiltered, keep, operatorCounts, order, search, siteFromHash, suitsTrucks, tier,
  type Bounds, type Check, type Filters, type Place, type Suggestion, type Tallies, type Truck,
} from "./logic";
import {
  BOLT, IconArtic, IconBack, IconBay, IconBolt, IconCheck, IconClock, IconCross, IconDriveThrough, IconFleet, IconLocate, IconMegawatt, IconPin, IconPlug, IconQuestion, IconRigid, IconRoute, IconSearch, IconShare,
  IconBasket, IconBed, IconCup, IconFood, IconFuel, IconParking, IconWifi,
} from "./icons";

const VENDOR = "/vendor/maplibre-6.17.0";
const STYLE = "https://tiles.openfreemap.org/styles/positron";
/** Great Britain and Northern Ireland, as first shown. */
const UK: [LngLat, LngLat] = [[-8.2, 49.9], [1.8, 58.7]];
const LIST_MAX = 60;
/** Electric colours: mint for truck sites, electric blue for 350 kW+, neon cyan for the rest. */
const COLORS = { truck: "#38ffc7", ultra: "#3b82ff", rapid: "#00d4ff" };
/** Seen from high up first, then the camera flies in to the UK. */
const INTRO = { center: [-3.2, 54.2] as LngLat, zoom: 2.6 };
const EMPTY = { type: "FeatureCollection", features: [] as unknown[] };
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const isNarrow = () => window.matchMedia?.("(max-width: 859px)").matches ?? false;
const kw = (n: number) => `${Math.round(n)} kW`;
const TRUCK_KEY = "depotcharge.map.truck";
const savedTruck = (): Truck => { try { return localStorage.getItem(TRUCK_KEY) === "rigid" ? "rigid" : "artic"; } catch { return "artic"; } };
const truckWords = (t: Truck) => (t === "artic" ? "an artic" : "a rigid");

export function PublicMap() {
  const [file, setFile] = useState<OpenSitesFile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [tallies, setTallies] = useState<Tallies>({});
  const [brandName, setBrandName] = useState("Depotcharge");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [truck, setTruckState] = useState<Truck>(savedTruck);
  const setTruck = (t: Truck) => { setTruckState(t); try { localStorage.setItem(TRUCK_KEY, t); } catch { /* private mode: not remembered */ } };
  const [selectedId, setSelectedId] = useState<string | null>(() => siteFromHash(window.location.hash));
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [mapState, setMapState] = useState<"loading" | "ready" | "failed">("loading");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [locating, setLocating] = useState<"idle" | "busy" | "denied">("idle");
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<MapLike | null>(null);
  const flyNext = useRef(!!selectedId);

  // ---- data: sites, fleets' reports, the brand
  const loadSites = useCallback(() => {
    setLoadError(false);
    fetch("/api/public/sites", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { data?: unknown }) => { const f = cleanOpenSites(j.data); if (!f) throw new Error("bad file"); setFile(f); })
      .catch(() => setLoadError(true));
  }, []);
  useEffect(() => {
    loadSites();
    fetch("/api/public/site-reports").then((r) => (r.ok ? r.json() : null)).then((j: { data?: Tallies } | null) => { if (j?.data) setTallies(j.data); }).catch(() => undefined);
    fetch("/api/config").then((r) => (r.ok ? r.json() : null)).then((j: { data?: { brand?: Brand } } | null) => {
      const b = j?.data?.brand;
      if (b?.name) { applyBrand(b); setBrandName(b.name); }
    }).catch(() => undefined);
  }, [loadSites]);
  useEffect(() => { document.title = `HGV charging map · ${brandName}`; }, [brandName]);

  const all: OpenSite[] = file?.sites ?? [];
  const byId = useMemo(() => new Map(all.map((s) => [s.id, s])), [all]);
  const shown = useMemo(() => all.filter((s) => keep(s, filters, tallies[s.id], truck)), [all, filters, tallies, truck]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const inView = useMemo(() => {
    const list = bounds ? shown.filter((s) => inBounds(s, bounds)) : shown;
    return [...list].sort((a, b) => order(a, b, tallies, truck));
  }, [shown, bounds, tallies, truck]);
  const operators = useMemo(() => operatorCounts(all), [all]);

  // ---- the map
  useEffect(() => {
    let gone = false;
    let m: MapLike | null = null;
    let stopPulse = () => {};
    (async () => {
      try {
        // A computed URL, so the bundler leaves it for the browser to load from /vendor.
        const lib = `${VENDOR}/maplibre-gl.mjs`;
        const ml = (await import(/* @vite-ignore */ lib)) as MapLibreModule;
        if (gone || !mapEl.current) return;
        ml.setWorkerUrl(`${VENDOR}/maplibre-gl-worker.mjs`);
        const mm = new ml.Map({
          container: mapEl.current,
          style: STYLE,
          ...(reducedMotion() ? { bounds: UK, fitBoundsOptions: { padding: padding(false) } } : INTRO),
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          cooperativeGestures: false,
        });
        m = mm;
        mm.touchZoomRotate.disableRotation();
        mm.keyboard.disableRotation();
        mm.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
        mm.on("error", () => undefined);
        mm.once("load", () => {
          if (gone) return;
          electrify(mm);
          addLayers(mm);
          map.current = mm;
          setMapState("ready");
          // The fly-in: from high above, down to the whole of the UK.
          if (!reducedMotion()) mm.fitBounds(UK, { padding: padding(false), duration: 2600, curve: 1.6, essential: true });
          stopPulse = pulse(mm);
          const b = mm.getBounds();
          setBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
        });
        mm.on("moveend", () => {
          const b = mm.getBounds();
          setBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
        });
        mm.on("click", "clusters", (e: MapEvent) => {
          const f = e.features?.[0];
          if (!f) return;
          const src = mm.getSource("sites") as GeoJsonSource;
          void src.getClusterExpansionZoom(Number(f.properties.cluster_id)).then((zoom) => mm.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.3, duration: reducedMotion() ? 0 : 500 }));
        });
        mm.on("click", "sites", (e: MapEvent) => {
          const id = e.features?.[0]?.properties.id;
          if (typeof id === "string") { flyNext.current = false; select(id); }
        });
        for (const layer of ["clusters", "sites"]) {
          mm.on("mouseenter", layer, () => { mm.getCanvas().style.cursor = "pointer"; });
          mm.on("mouseleave", layer, () => { mm.getCanvas().style.cursor = ""; });
        }
      } catch {
        if (!gone) setMapState("failed");
      }
    })();
    return () => { gone = true; stopPulse(); m?.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sites on the map follow the filters.
  useEffect(() => {
    const src = mapState === "ready" ? map.current?.getSource("sites") : undefined;
    src?.setData({ type: "FeatureCollection", features: shown.map((s) => point(s, { id: s.id, name: s.name, tier: tier(s, tallies[s.id], truck) })) });
  }, [mapState, shown, tallies, truck]);

  // Keep the map's centre clear of the panel (left on wide screens, the sheet on narrow ones).
  useEffect(() => {
    // Not mid-flight (the fly-in, a zoom to a site): changing the padding would stop the camera.
    const apply = () => { const m = map.current; if (m && !m.isMoving()) m.setPadding(padding(sheetOpen || !!selected)); };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [mapState, sheetOpen, selected]);

  // The chosen site: marked, in the address bar, and flown to when chosen from the list or search.
  useEffect(() => {
    const m = mapState === "ready" ? map.current : null;
    m?.getSource("selected")?.setData(selected ? { type: "FeatureCollection", features: [point(selected, { tier: tier(selected, tallies[selected.id], truck) })] } : EMPTY);
    const want = selected ? `#site=${encodeURIComponent(selected.id)}` : "";
    if (window.location.hash !== want) history.replaceState(null, "", `${window.location.pathname}${window.location.search}${want}`);
    if (m && selected && flyNext.current) {
      m.flyTo({ center: [selected.lon, selected.lat], zoom: Math.max(m.getZoom(), 12.5), duration: reducedMotion() ? 0 : 900, essential: true });
    }
    flyNext.current = false;
  }, [mapState, selected, tallies, truck]);

  useEffect(() => {
    const onHash = () => { flyNext.current = true; setSelectedId(siteFromHash(window.location.hash)); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id && isNarrow()) setSheetOpen(true);
  }, []);
  const pick = (s: Suggestion) => {
    if (s.kind === "site") { flyNext.current = true; select(s.site.id); return; }
    setSelectedId(null);
    map.current?.flyTo({ center: [s.place.lon, s.place.lat], zoom: 9.5, duration: reducedMotion() ? 0 : 900, essential: true });
    if (isNarrow()) setSheetOpen(true);
  };
  const nearMe = () => {
    if (!navigator.geolocation) { setLocating("denied"); return; }
    setLocating("busy");
    navigator.geolocation.getCurrentPosition((p) => {
      setLocating("idle");
      const at: LngLat = [p.coords.longitude, p.coords.latitude];
      map.current?.getSource("me")?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: at } }] });
      map.current?.flyTo({ center: at, zoom: 10, duration: reducedMotion() ? 0 : 900, essential: true });
    }, () => setLocating("denied"), { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 });
  };

  const total = all.length;
  const sources = file?.sources.filter((s) => s.count > 0) ?? [];
  return (
    <div className="pm">
      <div className={`pm-map${mapState === "ready" ? " ready" : ""}`} ref={mapEl} role="region" aria-label="Map of public charging sites" />
      {mapState === "failed" && (
        <div className="pm-mapfail" role="status">
          <b>The map couldn't load on this device.</b>
          <span>The list of sites still works.</span>
        </div>
      )}

      <aside className={`pm-panel${sheetOpen || selected ? " open" : ""}${selected ? " has-site" : ""}`} aria-label="Charging sites">
        <button type="button" className="pm-grab" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen} aria-label={sheetOpen ? "Show the map" : "Show the list"}><span /></button>
        <header className="pm-head">
          <a className="pm-brand" href="/map" aria-label={`${brandName} charging map`}>
            <span className="pm-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M13.2 2 4.5 13.6h6.1L9.8 22l8.7-11.6h-6.1z" fill="currentColor" /></svg></span>
            <span>{brandName}</span>
          </a>
          <a className="pm-signin" href="/#/">Sign in</a>
        </header>

        <div className="pm-intro">
          <span className="pm-live"><i />Live · built for HGV fleets</span>
          <h1>HGV charging map</h1>
          <p>{total ? <>Where your truck can charge. Every public UK site with <b>150 kW or more</b>, checked for HGVs: <b>{total.toLocaleString("en-GB")}</b> from operators' open data.</> : loadError ? "The sites couldn't load." : "Loading public charging sites…"}</p>
        </div>

        <SearchBox sites={all} places={CITIES} onPick={pick} />

        <div className="pm-truck" role="radiogroup" aria-label="Your truck">
          <span className="pm-truck-label">Your truck</span>
          {(["artic", "rigid"] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={truck === t} className={truck === t ? "on" : ""} onClick={() => setTruck(t)}>
              {t === "artic" ? <IconArtic size={22} /> : <IconRigid size={22} />}
              <span><b>{TRUCKS[t].label}</b><small>{(TRUCKS[t].length_cm / 100).toFixed(1)} m · {TRUCKS[t].weight_kg / 1000} t</small></span>
            </button>
          ))}
        </div>

        <div className="pm-filters" role="group" aria-label="Filters">
          <div className="pm-seg" role="radiogroup" aria-label="Power">
            {([150, 350] as const).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={filters.minKw === n} className={filters.minKw === n ? "on" : ""} onClick={() => setFilters((f) => ({ ...f, minKw: n }))}>{n} kW+</button>
            ))}
          </div>
          <Chip on={filters.trucks} onClick={() => setFilters((f) => ({ ...f, trucks: !f.trucks }))}>{truck === "artic" ? <IconArtic size={15} /> : <IconRigid size={15} />}Fits {truckWords(truck)}</Chip>
          <Chip on={filters.mcs} onClick={() => setFilters((f) => ({ ...f, mcs: !f.mcs }))}><IconMegawatt size={15} />Megawatt</Chip>
          <Chip on={filters.open247} onClick={() => setFilters((f) => ({ ...f, open247: !f.open247 }))}><IconClock size={15} />24/7</Chip>
          <label className="pm-select">
            <span className="sr-only">Operator</span>
            <select value={filters.operator} onChange={(e) => setFilters((f) => ({ ...f, operator: e.target.value }))}>
              <option value="">All operators</option>
              {operators.map((o) => <option key={o.name} value={o.name}>{o.name} ({o.count})</option>)}
            </select>
          </label>
          {isFiltered(filters) && <button type="button" className="pm-reset" onClick={() => setFilters(NO_FILTERS)}>Clear</button>}
        </div>

        <div className="pm-body">
          {selected ? (
            <SiteDetail key={selected.id} site={selected} tallies={tallies} truck={truck} sourceName={file?.sources.find((s) => s.id === selected.source)?.name ?? selected.source} onBack={() => setSelectedId(null)} />
          ) : loadError ? (
            <div className="pm-empty"><b>The sites couldn't load.</b><button type="button" className="pm-btn" onClick={loadSites}>Try again</button></div>
          ) : !file ? (
            <ul className="pm-list" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <li key={i} className="pm-skel" />)}</ul>
          ) : (
            <SiteList sites={inView} tallies={tallies} truck={truck} total={shown.length} filtered={isFiltered(filters)} onPick={(id) => { flyNext.current = true; select(id); }} onClear={() => setFilters(NO_FILTERS)} />
          )}
        </div>

        <footer className="pm-foot">
          <div className="pm-legend" aria-label="Key">
            <span><Pin tone="truck" />Fits {truckWords(truck)}</span>
            <span><Pin tone="ultra" />350 kW+</span>
            <span><Pin tone="rapid" />150 kW+</span>
          </div>
          <p>Sites: {sources.length ? sources.map((s) => s.name).join(", ") : "operators' open data"}{file ? `, updated ${new Date(file.generated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}. Open Charge Map data is CC BY 4.0.</p>
        </footer>
      </aside>
      <button type="button" className="pm-locate" onClick={nearMe} disabled={locating === "busy"} aria-label="Show sites near me">
        <IconLocate />{locating === "busy" ? "Finding you…" : "Near me"}
      </button>
      {locating === "denied" && <div className="pm-toast" role="status">Your location isn't available. Search for a town instead.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- map layers

function point(s: OpenSite, properties: Record<string, unknown>) {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [s.lon, s.lat] } };
}

function padding(sheet: boolean) {
  if (isNarrow()) return { top: 16, right: 16, left: 16, bottom: sheet ? Math.round(window.innerHeight * 0.7) : 192 };
  return { top: 24, right: 24, bottom: 24, left: 444 };
}

/** The basemap's own fonts (glyphs come from its server), regular and bold. */
function fonts(m: MapLike): { regular: string[]; bold: string[] } {
  const used = m.getStyle().layers.map((l) => l.layout?.["text-font"]).filter((f): f is string[] => Array.isArray(f) && f.every((x) => typeof x === "string"));
  const regular = used.find((f) => !/bold/i.test(f[0])) ?? used[0] ?? ["Noto Sans Regular"];
  const bold = used.find((f) => /bold/i.test(f[0])) ?? regular;
  return { regular, bold };
}

const TIER_COLOR = ["match", ["get", "tier"], "truck", COLORS.truck, "ultra", COLORS.ultra, COLORS.rapid];
const TIER_PIN = ["match", ["get", "tier"], "truck", "pin-truck", "ultra", "pin-ultra", "pin-rapid"];
const TRUCK_PATHS = ["M1.5 6.5h12v9h-12z", "M13.5 9.5h4.2l3.3 3.4v2.6h-7.5"];

/** A neon pin, drawn once on a canvas: a dark disc in a glowing ring, with a truck or a bolt. */
function pinImage(kind: "truck" | "bolt", color: string) {
  const ratio = 2, size = 40 * ratio, c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const mid = size / 2, r = 13 * ratio;
  ctx.shadowColor = color; ctx.shadowBlur = 9 * ratio;
  ctx.beginPath(); ctx.arc(mid, mid, r, 0, Math.PI * 2);
  ctx.fillStyle = "#04101f"; ctx.fill();
  ctx.lineWidth = 2.2 * ratio; ctx.strokeStyle = color; ctx.stroke();
  ctx.shadowBlur = 4 * ratio;
  const scale = (kind === "truck" ? 0.82 : 0.78) * ratio;
  ctx.save();
  ctx.translate(mid - 12 * scale, mid - 12 * scale + (kind === "truck" ? -0.6 * ratio : 0));
  ctx.scale(scale, scale);
  ctx.fillStyle = color; ctx.strokeStyle = color;
  if (kind === "bolt") ctx.fill(new Path2D(BOLT));
  else {
    ctx.lineWidth = 2.1; ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const d of TRUCK_PATHS) ctx.stroke(new Path2D(d));
    for (const x of [5, 9, 17.5]) { ctx.beginPath(); ctx.arc(x, 17.3, 1.9, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
  const img = ctx.getImageData(0, 0, size, size);
  return { image: { width: size, height: size, data: img.data }, pixelRatio: ratio };
}

function addLayers(m: MapLike) {
  const f = fonts(m);
  for (const [name, kind, color] of [["pin-truck", "truck", COLORS.truck], ["pin-ultra", "bolt", COLORS.ultra], ["pin-rapid", "bolt", COLORS.rapid]] as const) {
    if (m.hasImage(name)) continue;
    const p = pinImage(kind, color);
    m.addImage(name, p.image, { pixelRatio: p.pixelRatio });
  }
  m.addSource("sites", {
    type: "geojson", data: EMPTY, cluster: true, clusterRadius: 44, clusterMaxZoom: 11,
    clusterProperties: { trucks: ["+", ["case", ["==", ["get", "tier"], "truck"], 1, 0]] },
  });
  m.addSource("selected", { type: "geojson", data: EMPTY });
  m.addSource("me", { type: "geojson", data: EMPTY });
  const clusterR = ["step", ["get", "point_count"], 15, 10, 18, 40, 22, 120, 27];
  const hasTrucks = [">", ["get", "trucks"], 0];
  // Clusters: a dark core in a neon ring, with a soft glow that breathes (see pulse()).
  m.addLayer({
    id: "cluster-glow", type: "circle", source: "sites", filter: ["has", "point_count"],
    paint: { "circle-color": ["case", hasTrucks, COLORS.truck, COLORS.rapid], "circle-radius": ["+", clusterR, 10], "circle-blur": 0.9, "circle-opacity": 0.35 },
  });
  m.addLayer({
    id: "clusters", type: "circle", source: "sites", filter: ["has", "point_count"],
    paint: {
      "circle-color": "#06152a",
      "circle-radius": clusterR,
      "circle-stroke-color": ["case", hasTrucks, COLORS.truck, COLORS.rapid],
      "circle-stroke-width": 2,
    },
  });
  m.addLayer({
    id: "cluster-count", type: "symbol", source: "sites", filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": f.bold, "text-size": 13, "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#e8fbff", "text-halo-color": "rgba(0, 212, 255, 0.35)", "text-halo-width": 1, "text-halo-blur": 1 },
  });
  // Sites: a bright core with a neon glow.
  m.addLayer({
    id: "site-glow", type: "circle", source: "sites", filter: ["!", ["has", "point_count"]],
    paint: { "circle-color": TIER_COLOR, "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 8, 10, 13, 14, 18], "circle-blur": 1, "circle-opacity": 0.35 },
  });
  // Each site: a truck pin where it suits trucks, a bolt pin otherwise; small when zoomed out.
  m.addLayer({
    id: "sites", type: "symbol", source: "sites", filter: ["!", ["has", "point_count"]],
    layout: {
      "icon-image": TIER_PIN,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 9, 0.72, 13, 0.95],
      "icon-allow-overlap": true, "icon-ignore-placement": true,
      "symbol-sort-key": ["match", ["get", "tier"], "truck", 2, "ultra", 1, 0],
    },
  });
  m.addLayer({
    id: "site-names", type: "symbol", source: "sites", filter: ["!", ["has", "point_count"]], minzoom: 10.5,
    layout: { "text-field": ["get", "name"], "text-font": f.regular, "text-size": 12, "text-anchor": "top", "text-offset": [0, 1.5], "text-max-width": 10, "text-optional": true },
    paint: { "text-color": "#cfeeff", "text-halo-color": "#030812", "text-halo-width": 1.6 },
  });
  // The chosen site: a ring of light that keeps pulsing outwards.
  m.addLayer({ id: "selected-pulse", type: "circle", source: "selected", paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": 12, "circle-stroke-color": TIER_COLOR, "circle-stroke-width": 2, "circle-stroke-opacity": 0.8 } });
  m.addLayer({ id: "selected-glow", type: "circle", source: "selected", paint: { "circle-color": TIER_COLOR, "circle-radius": 22, "circle-blur": 1, "circle-opacity": 0.6 } });
  m.addLayer({ id: "selected-dot", type: "symbol", source: "selected", layout: { "icon-image": TIER_PIN, "icon-size": 1.3, "icon-allow-overlap": true, "icon-ignore-placement": true } });
  m.addLayer({ id: "me-halo", type: "circle", source: "me", paint: { "circle-color": "#9b8cff", "circle-opacity": 0.22, "circle-radius": 20, "circle-blur": 0.6 } });
  m.addLayer({ id: "me-dot", type: "circle", source: "me", paint: { "circle-color": "#9b8cff", "circle-radius": 7, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 } });
}

/** Recolours the light street map into a night map, so the neon pins stand out. */
function electrify(m: MapLike) {
  const set = (id: string, k: string, v: unknown) => { try { m.setPaintProperty(id, k, v); } catch { /* not this layer's property */ } };
  for (const l of m.getStyle().layers) {
    const id = l.id.toLowerCase();
    if (/poi|housenum|aerialway|ferry/.test(id)) { try { m.setLayoutProperty(l.id, "visibility", "none"); } catch { /* ignore */ } continue; }
    if (l.type === "background") set(l.id, "background-color", "#030812");
    else if (l.type === "fill") set(l.id, "fill-color", /water|ocean|sea|lake|river/.test(id) ? "#050f1f" : /building/.test(id) ? "#0b1628" : /park|wood|grass|green|forest/.test(id) ? "#06111c" : "#060c18");
    else if (l.type === "line") {
      // Motorways and trunk roads, where lorries run, stand out; minor roads stay in the dark.
      set(l.id, "line-color", /water|river|canal|stream/.test(id) ? "#0a2240" : /motorway/.test(id) ? "#1f5fa3" : /trunk/.test(id) ? "#18497f" : /primary|secondary/.test(id) ? "#10294a" : /boundary|admin/.test(id) ? "#24406e" : "#0c1a30");
    } else if (l.type === "symbol" && /shield/.test(id)) {
      // Road numbers (A1, M6) as neon text instead of the light map's white badges.
      try { m.setLayoutProperty(l.id, "icon-image", ""); } catch { /* ignore */ }
      set(l.id, "text-color", ["case", ["==", ["slice", ["to-string", ["get", "ref"]], 0, 1], "M"], "#6fb6ff", "#7fe0ff"]);
      set(l.id, "text-halo-color", "#030812");
      set(l.id, "text-halo-width", 2);
    } else if (l.type === "symbol") {
      const big = /place|city|town|country|state/.test(id);
      set(l.id, "text-color", big ? "#8fb3e6" : "#56709e");
      set(l.id, "text-halo-color", "#030812");
      set(l.id, "text-halo-width", 1.4);
    }
  }
}

/** Keeps the chosen site's ring pulsing and the clusters' glow breathing. Returns a stop function. */
function pulse(m: MapLike): () => void {
  if (reducedMotion()) return () => {};
  let frame = 0, last = 0;
  const tick = (t: number) => {
    frame = requestAnimationFrame(tick);
    if (t - last < 33) return; // ~30 fps is plenty
    last = t;
    const p = (t % 1800) / 1800;
    try {
      m.setPaintProperty("selected-pulse", "circle-radius", 11 + p * 30);
      m.setPaintProperty("selected-pulse", "circle-stroke-opacity", 0.85 * (1 - p));
      m.setPaintProperty("cluster-glow", "circle-opacity", 0.24 + 0.16 * (0.5 + 0.5 * Math.sin(t / 700)));
    } catch { /* map gone */ }
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

// ---------------------------------------------------------------- panel parts

function SearchBox({ sites, places, onPick }: { sites: OpenSite[]; places: Place[]; onPick(s: Suggestion): void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => search(q, sites, places), [q, sites, places]);
  const choose = (s: Suggestion) => { onPick(s); setQ(s.kind === "site" ? s.site.name : s.place.name); setOpen(false); };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && results[active]) { e.preventDefault(); choose(results[active]); }
    else if (e.key === "Escape") { setOpen(false); }
  };
  const showList = open && q.trim().length >= 2;
  return (
    <div className="pm-search">
      <span className="pm-search-icon"><IconSearch /></span>
      <input
        type="search" value={q} placeholder="Search a town, site or postcode" autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={showList} aria-controls="pm-results" aria-autocomplete="list" aria-label="Search a town, site or postcode"
        aria-activedescendant={showList && results[active] ? `pm-r${active}` : undefined}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey}
      />
      {showList && (
        <ul className="pm-results" id="pm-results" role="listbox">
          {results.length === 0 && <li className="pm-noresult">No towns or sites match “{q.trim()}”</li>}
          {results.map((r, i) => (
            <li key={r.kind === "site" ? r.site.id : `p-${r.place.name}`} id={`pm-r${i}`} role="option" aria-selected={i === active} className={i === active ? "active" : ""}
              onMouseDown={(e) => { e.preventDefault(); choose(r); }} onMouseEnter={() => setActive(i)}>
              {r.kind === "place"
                ? <><span className="pm-place"><IconPin size={15} /></span><span><b>{r.place.name}</b><small>Town</small></span></>
                : <><Pin tone={r.site.hgv === "trucks" ? "truck" : r.site.max_kw >= 350 ? "ultra" : "rapid"} /><span><b>{r.site.name}</b><small>{[r.site.operator, r.site.city].filter(Boolean).join(" · ")}</small></span><em>{kw(r.site.max_kw)}</em></>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SiteList({ sites, tallies, truck, total, filtered, onPick, onClear }: { sites: OpenSite[]; tallies: Tallies; truck: Truck; total: number; filtered: boolean; onPick(id: string): void; onClear(): void }) {
  if (!total) {
    return <div className="pm-empty"><b>No sites match these filters.</b>{filtered && <button type="button" className="pm-btn" onClick={onClear}>Clear filters</button>}</div>;
  }
  if (!sites.length) return <div className="pm-empty"><b>No sites in this part of the map.</b><span>Zoom out or search for a town.</span></div>;
  const list = sites.slice(0, LIST_MAX);
  return (
    <>
      <p className="pm-count" role="status" aria-live="polite">{sites.length === total ? `${total.toLocaleString("en-GB")} sites` : `${sites.length.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} sites in view`}{sites.length > LIST_MAX ? `, showing the first ${LIST_MAX}` : ""}</p>
      <ul className="pm-list">
        {list.map((s, i) => {
          const t = tallies[s.id];
          const trucks = suitsTrucks(s, t, truck);
          return (
            <li key={s.id} style={{ animationDelay: `${Math.min(i, 14) * 28}ms` }}>
              <button type="button" className="pm-item" onClick={() => onPick(s.id)}>
                <Pin tone={tier(s, t, truck)} />
                <span className="pm-item-main">
                  <b>{s.name}</b>
                  <small>{[s.operator, s.city].filter(Boolean).join(" · ")}</small>
                  <span className="pm-tags">
                    {trucks && <span className="pm-tag ok">{truck === "artic" ? <IconArtic size={13} /> : <IconRigid size={13} />}{s.hgv === "trucks" ? "Built for trucks" : "Fleets say it fits"}</span>}
                    {hasMcs(s) && <span className="pm-tag"><IconMegawatt size={13} />MCS</span>}
                    {s.drive_through && <span className="pm-tag"><IconDriveThrough size={13} />Drive-through</span>}
                    {s.open247 && <span className="pm-tag"><IconClock size={13} />24/7</span>}
                    <span className="pm-tag plain"><IconPlug size={13} />{s.evses}</span>
                  </span>
                </span>
                <span className="pm-kw"><b>{Math.round(s.max_kw)}</b><small>kW</small></span>
              </button>
            </li>
          );
        })}
      </ul>
      {sites.length > LIST_MAX && <p className="pm-more">Zoom in to see the rest.</p>}
    </>
  );
}

function SiteDetail({ site, tallies, truck, sourceName, onBack }: { site: OpenSite; tallies: Tallies; truck: Truck; sourceName: string; onBack(): void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const t = tallies[site.id];
  const a = access(site, t, truck);
  const checks = checklist(site, t, truck);
  const brk = breakCharge(site, truck);
  const addr = addressLine(site);
  const share = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked: the address bar has the link */ }
  };
  return (
    <article className="pm-detail" aria-labelledby="pm-site-name">
      <button type="button" className="pm-back" onClick={onBack}><IconBack />All sites</button>
      <div className="pm-title">
        <Pin tone={tier(site, t, truck)} big />
        <div>
          <h2 id="pm-site-name" ref={heading} tabIndex={-1}>{site.name}</h2>
          <p className="pm-op">{site.operator}</p>
        </div>
      </div>
      {addr && <p className="pm-addr">{addr}</p>}

      <div className={`pm-access ${a.tone}`}>
        {a.tone === "ok" ? <IconCheck size={20} /> : a.tone === "bad" ? <IconCross size={20} /> : <IconQuestion size={20} />}
        <div><b>{a.title}</b><span>{a.detail}</span></div>
      </div>

      <dl className="pm-facts">
        <div><dt><IconBolt size={13} />Top power</dt><dd>{kw(site.max_kw)}</dd></div>
        <div><dt><IconPlug size={13} />Chargers</dt><dd>{site.evses}</dd></div>
        <div className="wide"><dt><IconPlug size={13} />Connectors</dt><dd>{site.connectors.join(", ") || "Not published"}</dd></div>
      </dl>

      <div className="pm-break">
        <IconClock size={22} />
        <div>
          <small>A 45-minute driver's break here adds about</small>
          <b>{brk.kwh} kWh <span>≈ {brk.miles} miles</span></b>
          <em>For a loaded {TRUCKS[truck].label.toLowerCase()}, as an estimate. Charging slows as the battery fills.</em>
        </div>
      </div>

      <h3 className="pm-h3">{truck === "artic" ? <IconArtic size={18} /> : <IconRigid size={18} />}HGV checklist for {truckWords(truck)}</h3>
      <ul className="pm-checks">
        {checks.map((c) => <CheckRow key={c.key} c={c} />)}
      </ul>

      {!!site.facilities?.length && (
        <>
          <h3 className="pm-h3 plain">On site</h3>
          <ul className="pm-facilities">
            {site.facilities.map((f) => <li key={f}>{FACILITY_ICON[f]?.()}{FACILITY_LABEL[f] ?? f}</li>)}
          </ul>
        </>
      )}

      <div className="pm-actions">
        <a className="pm-btn primary" href="/#/book"><IconBolt size={18} />Book a slot</a>
        <a className="pm-btn" href={directionsUrl(site)} target="_blank" rel="noopener noreferrer"><IconRoute />Directions</a>
        <button type="button" className="pm-btn ghost" onClick={() => void share()}><IconShare />{copied ? "Link copied" : "Share"}</button>
      </div>
      <p className="pm-note">Booking opens in the app: sign in, or <a href="/#/signup">create an account</a>, to book charging and plan routes for your fleet.</p>

      <p className="pm-source">Data from {sourceName}{site.provider ? ` (${site.provider})` : ""}{site.updated ? `, last updated ${new Date(site.updated).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}.</p>
    </article>
  );
}

const FACILITY_ICON: Record<string, () => ReactNode> = {
  CAFE: () => <IconCup size={16} />, RESTAURANT: () => <IconFood size={16} />, HOTEL: () => <IconBed size={16} />, FUEL_STATION: () => <IconFuel size={16} />,
  WIFI: () => <IconWifi size={16} />, PARKING_LOT: () => <IconParking size={16} />, SUPERMARKET: () => <IconBasket size={16} />,
};

const CHECK_ICON: Record<string, () => ReactNode> = {
  hours: () => <IconClock size={18} />, bay: () => <IconBay size={18} />, drive: () => <IconDriveThrough size={18} />, mcs: () => <IconMegawatt size={18} />, fleets: () => <IconFleet size={18} />,
};

function CheckRow({ c }: { c: Check }) {
  return (
    <li className={`pm-check ${c.state}`}>
      <span className="pm-check-ico">{CHECK_ICON[c.key]?.()}</span>
      <span className="pm-check-main"><b>{c.label}</b><small>{c.text}</small></span>
      <span className="pm-check-state" aria-label={c.state === "ok" ? "Yes" : c.state === "bad" ? "No" : "Unknown"}>{c.state === "ok" ? <IconCheck size={16} /> : c.state === "bad" ? <IconCross size={16} /> : <IconQuestion size={16} />}</span>
    </li>
  );
}

/** A small neon pin like the ones on the map: a truck for sites that suit trucks, a bolt for the rest. */
function Pin({ tone, big }: { tone: "truck" | "ultra" | "rapid"; big?: boolean }) {
  return <span className={`pm-pin ${tone}${big ? " big" : ""}`} aria-hidden="true">{tone === "truck" ? <IconArtic size={big ? 20 : 13} /> : <IconBolt size={big ? 18 : 12} />}</span>;
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return <button type="button" className={`pm-chip${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>{children}</button>;
}

