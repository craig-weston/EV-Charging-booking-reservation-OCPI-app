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
  FACILITY_LABEL, NO_FILTERS, TRUCKS, access, canPlug, matchCounts, rateHere, specFromPlate, specOf, truckWords, addMinutes, arrivalTimes, chargeFor, addressLine, breakCharge, checklist, directionsUrl, hasMcs, inBounds, isFiltered, keep, operatorCounts, order, search, siteFromHash, suitsTrucks, tier,
  type Bounds, type Check, type Filters, type Place, type Suggestion, type Tallies, type Truck, type TruckLike,
} from "./logic";
import { forgetTruck, lookupPlate, saveTruck, savedTrucks, type PlateDetails } from "../app/plates";
import { isUkPlate, plateSummary, profileOf, type TruckProfile } from "../../shared/plates";
import { normalizePlate } from "../../shared/util";
import {
  BOLT, IconArtic, IconBack, IconBay, IconBolt, IconCheck, IconClock, IconCross, IconDriveThrough, IconFleet, IconHeight, IconWeight, IconLocate, IconMegawatt, IconPin, IconPlug, IconQuestion, IconRigid, IconRoute, IconSearch, IconShare,
  IconBasket, IconBed, IconCup, IconFood, IconFuel, IconParking, IconPlay, IconWifi,
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
const isArtic = (t: TruckLike) => specOf(t).class === "artic";
const WELCOME_KEY = "depotcharge.map.welcomed";
/** The full app with sample trucks and operators, no account needed (see src/app/demo.ts). */
const DEMO_URL = "/?demo#/book";
/** The 17-second walkthrough of booking in the app (public/media), and what each step shows. */
const VIDEO = { src: "/media/how-booking-works.mp4", poster: "/media/how-booking-works.jpg", seconds: 17 };
const VIDEO_STEPS: [string, string][] = [
  ["Pick the truck and roughly when", "The fleet planner chooses a vehicle and a day."],
  ["Only bays that fit the truck", "Connector, power, length, height and load are matched."],
  ["Sent to the operator over OCPI", "The bay is requested with the number plate and charging ID."],
  ["Bay reserved in seconds", "The plate is added to the site's barrier list."],
  ["The driver gets a message", "A text or WhatsApp with a link: no app to install."],
  ["Everything they need at a glance", "Arrival window, directions and what happens at the gate."],
  ["Drive in, plug in, charge", "The barrier reads the plate and Plug & Charge starts the session."],
];
const seenWelcome = () => { try { return localStorage.getItem(WELCOME_KEY) === "1"; } catch { return false; } };

export function PublicMap() {
  const [file, setFile] = useState<OpenSitesFile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [tallies, setTallies] = useState<Tallies>({});
  const [brandName, setBrandName] = useState("Depotcharge");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [truck, setTruckState] = useState<Truck>(savedTruck);
  const setTruck = (t: Truck) => { setTruckState(t); try { localStorage.setItem(TRUCK_KEY, t); } catch { /* private mode: not remembered */ } };
  // Trucks found by number plate, saved in this browser.
  const [myTrucks, setMyTrucks] = useState<PlateDetails[]>(savedTrucks);
  const [myPlate, setMyPlate] = useState<string | null>(() => savedTrucks()[0]?.plate ?? null);
  const useMine = (t: PlateDetails) => { setMyPlate(t.plate); if (t.kind === "artic" || t.kind === "rigid") setTruck(t.kind); };
  const foundTruck = (t: PlateDetails) => { setMyTrucks(saveTruck(t)); useMine(t); };
  const editTruck = (t: PlateDetails) => setMyTrucks(saveTruck(t, false));
  const mine = myTrucks.find((t) => t.plate === myPlate) ?? null;
  /** What the map is set up for: the visitor's own truck if they've picked one, else a kind of truck. */
  const active: TruckLike = useMemo(() => (mine ? specFromPlate(mine) : truck), [mine, truck]);
  const dropTruck = (plate: string) => { const next = forgetTruck(plate); setMyTrucks(next); if (myPlate === plate) setMyPlate(null); };
  const [selectedId, setSelectedId] = useState<string | null>(() => siteFromHash(window.location.hash));
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [mapState, setMapState] = useState<"loading" | "ready" | "failed">("loading");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [locating, setLocating] = useState<"idle" | "busy" | "denied">("idle");
  // First visit (not a link to one site): a short welcome saying what this is.
  const [welcome, setWelcome] = useState(() => !seenWelcome() && !siteFromHash(window.location.hash));
  const [toast, setToast] = useState<string | null>(null);
  const [video, setVideo] = useState(false);
  const closeWelcome = () => { setWelcome(false); try { localStorage.setItem(WELCOME_KEY, "1"); } catch { /* not remembered */ } };
  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2200); };
  const shareMap = async () => {
    const url = `${window.location.origin}/map`;
    try {
      if (navigator.share && isNarrow()) { await navigator.share({ title: "Truck charging map", text: "Where your truck can charge: every public UK site, checked for HGVs.", url }); return; }
      await navigator.clipboard.writeText(url);
      flash("Map link copied. Share it with anyone: no account needed.");
    } catch { /* cancelled */ }
  };
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
  useEffect(() => { document.title = `Truck charging map · ${brandName}`; }, [brandName]);

  const all: OpenSite[] = file?.sites ?? [];
  const byId = useMemo(() => new Map(all.map((s) => [s.id, s])), [all]);
  const shown = useMemo(() => all.filter((s) => keep(s, filters, tallies[s.id], active)), [all, filters, tallies, active]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const inView = useMemo(() => {
    const list = bounds ? shown.filter((s) => inBounds(s, bounds)) : shown;
    return [...list].sort((a, b) => order(a, b, tallies, active));
  }, [shown, bounds, tallies, active]);
  const matched = useMemo(() => (mine ? matchCounts(all, tallies, active) : null), [mine, all, tallies, active]);
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
    src?.setData({ type: "FeatureCollection", features: shown.map((s) => point(s, { id: s.id, name: s.name, tier: tier(s, tallies[s.id], active) })) });
  }, [mapState, shown, tallies, active]);

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
    m?.getSource("selected")?.setData(selected ? { type: "FeatureCollection", features: [point(selected, { tier: tier(selected, tallies[selected.id], active) })] } : EMPTY);
    const want = selected ? `#site=${encodeURIComponent(selected.id)}` : "";
    if (window.location.hash !== want) history.replaceState(null, "", `${window.location.pathname}${window.location.search}${want}`);
    if (m && selected && flyNext.current) {
      m.flyTo({ center: [selected.lon, selected.lat], zoom: Math.max(m.getZoom(), 12.5), duration: reducedMotion() ? 0 : 900, essential: true });
    }
    flyNext.current = false;
  }, [mapState, selected, tallies, active]);

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

  const sources = file?.sources.filter((s) => s.count > 0) ?? [];
  return (
    <main className="pm">
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
          <h1>Truck charging map</h1>
          <button type="button" className="pm-iconbtn" onClick={() => void shareMap()} aria-label="Share this map" title="Share this map"><IconShare size={17} /></button>
        </header>

        <button type="button" className="pm-watch" onClick={() => setVideo(true)}>
          <span className="pm-watch-thumb" aria-hidden="true"><img src={VIDEO.poster} alt="" width="96" height="54" /><span><IconPlay /></span></span>
          <span><b>Watch how booking works</b><small>From picking a bay to plugging in · {VIDEO.seconds} seconds</small></span>
        </button>

        <SearchBox sites={all} places={CITIES} onPick={pick} />

        <PlateSearch onFound={foundTruck} />
        {myTrucks.length > 0 && (
          <ul className="pm-mytrucks" aria-label="Your trucks">
            {myTrucks.map((t) => {
              const on = myPlate === t.plate;
              return (
                <li key={t.plate} className={on ? "on" : ""}>
                  <button type="button" className="pm-mytruck" aria-pressed={on} onClick={() => useMine(t)}>
                    <span className="pm-plate">{t.plate}</span>
                    <span className="pm-mytruck-main"><b>{t.kind === "artic" ? "Artic" : t.kind === "rigid" ? "Rigid" : t.kind === "bus" ? "Bus or coach" : t.kind === "van" ? "Van" : "Vehicle"}{t.electric ? " · electric" : ""}</b><small>{plateSummary(t) || "Details from DVLA"}</small></span>
                  </button>
                  <button type="button" className="pm-mytruck-x" onClick={() => dropTruck(t.plate)} aria-label={`Remove ${t.plate}`}><IconCross size={14} /></button>
                </li>
              );
            })}
          </ul>
        )}
        {mine && <TruckCard t={mine} counts={matched} onChange={editTruck} />}
        {myTrucks.length > 0 && <p className="pm-mytrucks-note">Saved in this browser. <a href="/#/signup">Create an account</a> to add them to your fleet.</p>}

        <div className="pm-truck" role="radiogroup" aria-labelledby="pm-truck-label">
          <span className="pm-truck-label" id="pm-truck-label">Or pick a kind of truck</span>
          {(["artic", "rigid"] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={!mine && truck === t} className={!mine && truck === t ? "on" : ""} onClick={() => { setTruck(t); setMyPlate(null); }}>
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
          <Chip on={filters.trucks} onClick={() => setFilters((f) => ({ ...f, trucks: !f.trucks }))}>{isArtic(active) ? <IconArtic size={15} /> : <IconRigid size={15} />}Fits {truckWords(active)}</Chip>
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
            <SiteDetail key={selected.id} site={selected} tallies={tallies} truck={active} onWatch={() => setVideo(true)} sourceName={file?.sources.find((s) => s.id === selected.source)?.name ?? selected.source} onBack={() => setSelectedId(null)} />
          ) : loadError ? (
            <div className="pm-empty"><b>The sites couldn't load.</b><button type="button" className="pm-btn" onClick={loadSites}>Try again</button></div>
          ) : !file ? (
            <ul className="pm-list" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <li key={i} className="pm-skel" />)}</ul>
          ) : (
            <SiteList sites={inView} tallies={tallies} truck={active} total={shown.length} filtered={isFiltered(filters)} onPick={(id) => { flyNext.current = true; select(id); }} onClear={() => setFilters(NO_FILTERS)} />
          )}
        </div>

        <a className="pm-gateway" href={DEMO_URL}>
          <span className="pm-gateway-ico"><IconBolt size={16} /></span>
          <span><b>Run a fleet? Try the app free</b><small>Book bays, plan routes and charge at your depot with sample trucks. No sign-up.</small></span>
          <span className="pm-gateway-go" aria-hidden="true">→</span>
        </a>
        <footer className="pm-foot">
          <div className="pm-legend" aria-label="Key">
            <span><Pin tone="truck" />Fits {truckWords(active)}</span>
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
      {toast && <div className="pm-toast" role="status">{toast}</div>}
      {welcome && file && <Welcome total={file.sites.length} onClose={closeWelcome} onWatch={() => { closeWelcome(); setVideo(true); }} />}
      {video && <VideoDialog onClose={() => setVideo(false)} />}
    </main>
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

function SiteList({ sites, tallies, truck, total, filtered, onPick, onClear }: { sites: OpenSite[]; tallies: Tallies; truck: TruckLike; total: number; filtered: boolean; onPick(id: string): void; onClear(): void }) {
  if (!total) {
    return <div className="pm-empty"><b>No sites match these filters.</b>{filtered && <button type="button" className="pm-btn" onClick={onClear}>Clear filters</button>}</div>;
  }
  if (!sites.length) return <div className="pm-empty"><b>No sites in this part of the map.</b><span>Zoom out or search for a town.</span></div>;
  const list = sites.slice(0, LIST_MAX);
  const own = typeof truck !== "string";
  return (
    <>
      <p className="pm-count" role="status" aria-live="polite">{sites.length === total ? `${total.toLocaleString("en-GB")} sites` : `${sites.length.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} sites in view`}{sites.length > LIST_MAX ? `, showing the first ${LIST_MAX}` : ""}</p>
      <ul className="pm-list">
        {list.map((s, i) => {
          const t = tallies[s.id];
          const trucks = suitsTrucks(s, t, truck);
          const gain = own && canPlug(s, truck) ? breakCharge(s, truck) : null;
          return (
            <li key={s.id} style={{ animationDelay: `${Math.min(i, 14) * 28}ms` }}>
              <button type="button" className="pm-item" onClick={() => onPick(s.id)}>
                <Pin tone={tier(s, t, truck)} />
                <span className="pm-item-main">
                  <b>{s.name}</b>
                  <small>{[s.operator, s.city].filter(Boolean).join(" · ")}</small>
                  <span className="pm-tags">
                    {trucks && <span className="pm-tag ok">{isArtic(truck) ? <IconArtic size={13} /> : <IconRigid size={13} />}{s.hgv === "trucks" ? "Built for trucks" : "Fleets say it fits"}</span>}
                    {hasMcs(s) && <span className="pm-tag"><IconMegawatt size={13} />MCS</span>}
                    {s.drive_through && <span className="pm-tag"><IconDriveThrough size={13} />Drive-through</span>}
                    {s.open247 && <span className="pm-tag"><IconClock size={13} />24/7</span>}
                    {gain && <span className="pm-tag time"><IconBolt size={13} />+{gain.miles} mi in 45 min</span>}
                    <span className="pm-tag plain"><IconPlug size={13} />{s.evses}</span>
                  </span>
                </span>
                <span className="pm-kw"><b>{Math.round(own ? rateHere(s, truck) : s.max_kw)}</b><small>kW</small></span>
              </button>
            </li>
          );
        })}
      </ul>
      {sites.length > LIST_MAX && <p className="pm-more">Zoom in to see the rest.</p>}
    </>
  );
}

function SiteDetail({ site, tallies, truck, sourceName, onBack, onWatch }: { site: OpenSite; tallies: Tallies; truck: TruckLike; sourceName: string; onBack(): void; onWatch(): void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const [trial, setTrial] = useState(false);
  // Focus the site's name (screen readers announce it) and bring the details into view.
  useEffect(() => {
    const h = heading.current;
    if (!h) return;
    h.focus({ preventScroll: true });
    h.closest(".pm-detail")?.scrollIntoView({ block: "start", behavior: "auto" });
  }, []);
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
          <em>{typeof truck === "string" ? `For a loaded ${TRUCKS[truck].label.toLowerCase()}` : `For ${truck.label} (${truck.battery_kwh} kWh, up to ${truck.maxKw} kW)`}, as an estimate. Charging slows as the battery fills.</em>
        </div>
      </div>

      <h3 className="pm-h3">{isArtic(truck) ? <IconArtic size={18} /> : <IconRigid size={18} />}HGV checklist for {truckWords(truck)}</h3>
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

      {trial ? <TrialBooking site={site} truck={truck} onClose={() => setTrial(false)} /> : (
        <div className="pm-actions">
          <button type="button" className="pm-btn primary" onClick={() => setTrial(true)}><IconBolt size={18} />Try booking this site</button>
          <a className="pm-btn" href={directionsUrl(site)} target="_blank" rel="noopener noreferrer"><IconRoute />Directions</a>
          <button type="button" className="pm-btn ghost" onClick={() => void share()}><IconShare />{copied ? "Link copied" : "Share"}</button>
        </div>
      )}
      {!trial && <p className="pm-note">See how booking a bay ahead works, in under a minute, with no account, or <button type="button" className="pm-link inline" onClick={onWatch}>watch the {VIDEO.seconds}-second video</button>. Already use the app? <a href="/#/book">Sign in to book</a>.</p>}

      <p className="pm-source">Data from {sourceName}{site.provider ? ` (${site.provider})` : ""}{site.updated ? `, last updated ${new Date(site.updated).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}.</p>
    </article>
  );
}

/** Find a truck by its number plate (DVLA): its kind and weight set up the map, and it's saved here. */
function PlateSearch({ onFound }: { onFound(t: PlateDetails): void }) {
  const [plate, setPlate] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);
  const go = async () => {
    if (!isUkPlate(plate)) { setMsg({ tone: "bad", text: "Enter a UK number plate, like PN74 EVH." }); return; }
    setBusy(true); setMsg(null);
    const r = await lookupPlate(window.location.origin, plate);
    setBusy(false);
    if (!r.ok) { setMsg({ tone: r.unavailable ? "info" : "bad", text: r.unavailable ? "Number-plate lookup isn't switched on yet. Pick a kind of truck below." : r.message }); return; }
    const d = r.details;
    if (!d.heavy) { setMsg({ tone: "info", text: `${d.plate} is a ${d.kind === "van" ? "van" : "car"}${d.make ? ` (${d.make})` : ""}. This map is for trucks: pick a kind below.` }); return; }
    onFound(d);
    setPlate("");
    setMsg({ tone: "ok", text: `Found ${d.plate}: ${[d.make, d.kind === "artic" ? "artic" : d.kind, d.gross_weight_kg ? `${Math.round(d.gross_weight_kg / 100) / 10} t` : null].filter(Boolean).join(", ")}${d.electric ? "" : ". It isn't electric today: the map shows what an electric one its size could use"}.` });
  };
  return (
    <form className="pm-platesearch" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <label htmlFor="pm-plate" className="pm-truck-label">Your truck's number plate</label>
      <div className="pm-platesearch-row">
        <span className="pm-plate-input">
          <span aria-hidden="true">UK</span>
          <input id="pm-plate" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase().slice(0, 9))} placeholder="PN74 EVH" autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby="pm-plate-msg" aria-invalid={msg?.tone === "bad" || undefined} />
        </span>
        <button type="submit" className="pm-btn" disabled={busy || !normalizePlate(plate)}>{busy ? <span className="pm-spin light" aria-hidden="true" /> : <IconSearch size={16} />}{busy ? "Finding…" : "Find"}</button>
      </div>
      <p id="pm-plate-msg" className={`pm-plate-msg ${msg?.tone ?? ""}`} role="status">{msg?.text ?? "We look it up with DVLA and set the map up for it."}</p>
    </form>
  );
}

/** The picked truck: what every site is matched against, with its figures to correct. */
function TruckCard({ t, counts, onChange }: { t: PlateDetails; counts: ReturnType<typeof matchCounts> | null; onChange(t: PlateDetails): void }) {
  const p = profileOf(t);
  const set = (k: keyof TruckProfile, v: number | boolean) => onChange({ ...t, profile: { ...p, [k]: v } });
  const own = (k: keyof TruckProfile) => t.profile != null && t.profile[k] !== profileOf({ ...t, profile: undefined })[k];
  const from = (k: keyof TruckProfile) => (own(k) ? "yours" : k === "weight_kg" && t.gross_weight_kg ? "DVLA" : "typical");
  const artic = t.kind === "artic";
  const rows: { k: keyof TruckProfile; icon: ReactNode; label: string; value: string }[] = [
    { k: "length_cm", icon: artic ? <IconArtic size={15} /> : <IconRigid size={15} />, label: "Length", value: `${(p.length_cm / 100).toFixed(1)} m` },
    { k: "height_cm", icon: <IconHeight size={15} />, label: "Height", value: `${(p.height_cm / 100).toFixed(2)} m` },
    { k: "weight_kg", icon: <IconWeight size={15} />, label: "Weight", value: `${Math.round(p.weight_kg / 100) / 10} t` },
    { k: "battery_kwh", icon: <IconBolt size={15} />, label: "Battery", value: `${p.battery_kwh} kWh` },
    { k: "max_kw", icon: <IconPlug size={15} />, label: "Charges at", value: `up to ${p.max_kw} kW${p.mcs ? " · MCS" : ""}` },
  ];
  return (
    <section className="pm-tcard" aria-labelledby="pm-tcard-title">
      <span className="pm-tcard-scan" aria-hidden="true" />
      <h2 id="pm-tcard-title"><small>Sites matched to</small><span className="pm-plate">{t.plate}</span></h2>
      <dl className="pm-tspec">
        {rows.map((r) => (
          <div key={r.k}><dt>{r.icon}{r.label}</dt><dd>{r.value}<small className={from(r.k)}>{from(r.k)}</small></dd></div>
        ))}
      </dl>
      {counts && (
        <ul className="pm-tmatch" aria-label="How the sites match this truck">
          <li><b>{counts.plug.toLocaleString("en-GB")}</b><span>sites it can charge at</span></li>
          <li><b>{counts.fast.toLocaleString("en-GB")}</b><span>add 100+ miles in a 45-min break</span></li>
          <li><b>{counts.fits.toLocaleString("en-GB")}</b><span>confirmed for its size</span></li>
        </ul>
      )}
      {!!counts?.tooSmall && <p className="pm-tnote">{counts.tooSmall} more ruled out: their bays are too small for it.</p>}
      <details className="pm-tedit">
        <summary>Correct its size or charging</summary>
        <div className="pm-tedit-grid">
          <Num label="Length" unit="m" value={p.length_cm / 100} step={0.1} min={4} max={25} onChange={(v) => set("length_cm", Math.round(v * 100))} />
          <Num label="Height" unit="m" value={p.height_cm / 100} step={0.05} min={2} max={5} onChange={(v) => set("height_cm", Math.round(v * 100))} />
          <Num label="Weight" unit="t" value={p.weight_kg / 1000} step={0.5} min={3.5} max={60} onChange={(v) => set("weight_kg", Math.round(v * 1000))} />
          <Num label="Battery" unit="kWh" value={p.battery_kwh} step={10} min={50} max={1200} onChange={(v) => set("battery_kwh", Math.round(v))} />
          <Num label="Top charging rate" unit="kW" value={p.max_kw} step={25} min={22} max={1500} onChange={(v) => set("max_kw", Math.round(v))} />
          <label className="pm-tcheck"><input type="checkbox" checked={p.mcs} onChange={(e) => set("mcs", e.target.checked)} />Takes megawatt (MCS) charging</label>
        </div>
        <p className="pm-tnote">DVLA gives the weight. It doesn't hold size or charging, so those start as typical for {artic ? "an electric artic" : "an electric rigid"} until you change them.</p>
      </details>
    </section>
  );
}

/** A number field that lets people type freely and only takes a value in range. */
function Num({ label, unit, value, step, min, max, onChange }: { label: string; unit: string; value: number; step: number; min: number; max: number; onChange(v: number): void }) {
  const [text, setText] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => { setText(String(Math.round(value * 100) / 100)); }, [value]);
  const commit = (v: string) => { const n = Number(v); if (v.trim() && Number.isFinite(n) && n >= min && n <= max) onChange(n); };
  return (
    <label className="pm-num">
      <span>{label}</span>
      <span className="pm-num-box">
        <input type="number" inputMode="decimal" value={text} step={step} min={min} max={max} onChange={(e) => { setText(e.target.value); commit(e.target.value); }} onBlur={() => setText(String(Math.round(value * 100) / 100))} />
        <em>{unit}</em>
      </span>
    </label>
  );
}

/** A trial booking: pick a time, "reserve" a bay, and see how the day would go. Nothing is booked. */
function TrialBooking({ site, truck, onClose }: { site: OpenSite; truck: TruckLike; onClose(): void }) {
  const [tomorrow, setTomorrow] = useState(() => new Date().getHours() >= 22);
  const times = useMemo(() => arrivalTimes(new Date(), tomorrow), [tomorrow]);
  const [at, setAt] = useState(() => (new Date().getHours() < 17 && !tomorrow ? "17:30" : times[0] ?? "06:00"));
  const [mins, setMins] = useState(45);
  const [ref] = useState(() => `TRY-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
  const [bay] = useState(() => 1 + Math.floor(Math.random() * Math.max(1, Math.min(site.evses, 8))));
  const [booked, setBooked] = useState(false);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!times.includes(at)) setAt(times[0] ?? "00:00"); }, [times, at]);
  useEffect(() => { panel.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }); }, [booked]);
  const gain = chargeFor(site, truck, mins);
  const reserve = () => { setBusy(true); setTimeout(() => { setBusy(false); setBooked(true); }, reducedMotion() ? 0 : 900); };
  const day = tomorrow ? "Tomorrow" : "Today";
  const steps = [
    { icon: <IconBay size={18} />, title: "Bay held for your truck", text: `Bay ${bay} is kept for you from ${at}. Running late? The app offers the next free slot.` },
    { icon: <IconCheck size={18} />, title: "The gate opens on the number plate", text: "A camera reads the plate. No code, no card, no call." },
    { icon: <IconPlug size={18} />, title: "Plug in. Charging starts by itself", text: "The charger recognises the truck (Plug & Charge). The driver just plugs in." },
    { icon: <IconBolt size={18} />, title: `About ${gain.kwh} kWh in ${mins} minutes`, text: `Roughly ${gain.miles} miles for ${typeof truck === "string" ? `a loaded ${TRUCKS[truck].label.toLowerCase()}` : truck.label}. Back on the road at ${addMinutes(at, mins)}.` },
    { icon: <IconFleet size={18} />, title: "One invoice to the fleet", text: "No driver payments or expense claims. Every charge on one statement." },
  ];
  if (!booked) {
    return (
      <div className="pm-trial" ref={panel}>
        <div className="pm-trial-head"><b>Trial booking</b><button type="button" className="pm-link" onClick={onClose}>Cancel</button></div>
        <div className="pm-trial-row">
          <span>Day</span>
          <div className="pm-seg" role="radiogroup" aria-label="Day">
            {[false, true].map((tm) => <button key={String(tm)} type="button" role="radio" aria-checked={tomorrow === tm} className={tomorrow === tm ? "on" : ""} onClick={() => setTomorrow(tm)}>{tm ? "Tomorrow" : "Today"}</button>)}
          </div>
        </div>
        <div className="pm-trial-row">
          <span>Arrive at</span>
          <label className="pm-select"><span className="sr-only">Arrival time</span><select value={at} onChange={(e) => setAt(e.target.value)}>{times.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        </div>
        <div className="pm-trial-row">
          <span>Charge for</span>
          <div className="pm-seg" role="radiogroup" aria-label="Charge for">
            {[30, 45, 60, 90].map((m) => <button key={m} type="button" role="radio" aria-checked={mins === m} className={mins === m ? "on" : ""} onClick={() => setMins(m)}>{m < 60 ? `${m}m` : m === 60 ? "1h" : "1h 30"}</button>)}
          </div>
        </div>
        <p className="pm-trial-gain"><IconBolt size={14} />Adds about <b>{gain.kwh} kWh</b>, roughly <b>{gain.miles} miles</b></p>
        <button type="button" className="pm-btn primary" onClick={reserve} disabled={busy}>{busy ? <span className="pm-spin" aria-hidden="true" /> : <IconBay size={18} />}{busy ? "Reserving…" : `Reserve a bay, ${day.toLowerCase()} ${at}`}</button>
        <p className="pm-note">This is a trial. Nothing is booked and no account is needed.</p>
      </div>
    );
  }
  return (
    <div className="pm-trial done" ref={panel} role="status">
      <div className="pm-booked">
        <span className="pm-booked-ico"><IconCheck size={26} /></span>
        <div><b>Bay reserved</b><small>{day} {at}–{addMinutes(at, mins)} · Bay {bay} · {ref}</small></div>
      </div>
      <p className="pm-trial-sub">Here's how it goes on the day:</p>
      <ol className="pm-steps">
        {steps.map((st, i) => (
          <li key={st.title} style={{ animationDelay: `${reducedMotion() ? 0 : 250 + i * 420}ms` }}>
            <span className="pm-step-ico">{st.icon}</span>
            <span><b>{st.title}</b><small>{st.text}</small></span>
          </li>
        ))}
      </ol>
      <div className="pm-trial-cta">
        <p><b>That was a trial.</b> {site.operator} doesn't take bookings through the app yet. Once an operator connects, booking works just like this.</p>
        <a className="pm-btn primary" href="/#/signup"><IconBolt size={18} />Create your account</a>
        <div className="pm-actions">
          <a className="pm-btn" href={DEMO_URL}>Explore the full app</a>
          <button type="button" className="pm-btn ghost" onClick={onClose}>Back to the site</button>
        </div>
        <p className="pm-note">"Explore the full app" opens it with sample trucks, bookings and depots. No sign-up.</p>
      </div>
    </div>
  );
}

/** First visit: what this is, in three lines. */
function Welcome({ total, onClose, onWatch }: { total: number; onClose(): void; onWatch(): void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="pm-welcome" role="dialog" aria-modal="false" aria-labelledby="pm-welcome-title">
      <span className="pm-live"><i />Free · no account needed</span>
      <h2 id="pm-welcome-title">Find where your truck can charge</h2>
      <ul>
        <li><IconArtic size={20} /><span><b>{total.toLocaleString("en-GB")} public sites, checked for HGVs</b><small>Whether an artic fits, 24/7 opening, megawatt charging.</small></span></li>
        <li><IconClock size={20} /><span><b>Planned around the driver's break</b><small>What 45 minutes adds, in kWh and miles.</small></span></li>
        <li><IconBolt size={20} /><span><b>Book bays ahead, no cards</b><small>Try it on any site: pick one and press Try booking.</small></span></li>
      </ul>
      <div className="pm-welcome-actions">
        <button type="button" className="pm-btn primary" ref={close} onClick={onClose}>Explore the map</button>
        <a className="pm-btn" href={DEMO_URL}>Try the full app</a>
      </div>
      <button type="button" className="pm-link pm-welcome-watch" onClick={onWatch}><IconPlay />Watch how booking works ({VIDEO.seconds} seconds)</button>
    </div>
  );
}

/** The booking walkthrough in a dialog, with what each step shows written out beneath it. */
function VideoDialog({ onClose }: { onClose(): void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [onClose]);
  return (
    <dialog className="pm-video" ref={dlg} aria-labelledby="pm-video-title" onClick={(e) => { if (e.target === dlg.current) onClose(); }}>
      <div className="pm-video-head">
        <h2 id="pm-video-title">How booking works</h2>
        <button type="button" className="pm-iconbtn" onClick={onClose} aria-label="Close the video"><IconCross size={18} /></button>
      </div>
      <video src={VIDEO.src} poster={VIDEO.poster} controls playsInline muted autoPlay={!reducedMotion()} preload="metadata" width="1200" height="676" aria-describedby="pm-video-steps" />
      <details className="pm-video-steps" open>
        <summary>What the video shows</summary>
        <ol id="pm-video-steps">
          {VIDEO_STEPS.map(([t, d]) => <li key={t}><b>{t}</b> {d}</li>)}
        </ol>
      </details>
      <div className="pm-actions">
        <a className="pm-btn primary" href={DEMO_URL}><IconBolt size={18} />Try it in the full app</a>
      </div>
    </dialog>
  );
}

const FACILITY_ICON: Record<string, () => ReactNode> = {
  CAFE: () => <IconCup size={16} />, RESTAURANT: () => <IconFood size={16} />, HOTEL: () => <IconBed size={16} />, FUEL_STATION: () => <IconFuel size={16} />,
  WIFI: () => <IconWifi size={16} />, PARKING_LOT: () => <IconParking size={16} />, SUPERMARKET: () => <IconBasket size={16} />,
};

const CHECK_ICON: Record<string, () => ReactNode> = {
  charge: () => <IconBolt size={18} />, hours: () => <IconClock size={18} />, bay: () => <IconBay size={18} />, drive: () => <IconDriveThrough size={18} />, mcs: () => <IconMegawatt size={18} />, fleets: () => <IconFleet size={18} />,
};

function CheckRow({ c }: { c: Check }) {
  return (
    <li className={`pm-check ${c.state}`}>
      <span className="pm-check-ico">{CHECK_ICON[c.key]?.()}</span>
      <span className="pm-check-main"><b>{c.label}</b><small>{c.text}</small></span>
      <span className="pm-check-state">{c.state === "ok" ? <IconCheck size={16} /> : c.state === "bad" ? <IconCross size={16} /> : <IconQuestion size={16} />}<span className="sr-only">{c.state === "ok" ? "Yes" : c.state === "bad" ? "No" : "Not known"}</span></span>
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

