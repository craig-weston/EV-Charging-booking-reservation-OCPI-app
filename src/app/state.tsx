import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { subscribeFleet } from "./realtime";
import type { AppConfig, BookingEvent, BookingRow, Brand, Driver, Fleet, Membership, NetworkSnapshot, Vehicle } from "../../shared/model";
import type { Backend } from "./backend";
import { applyBrand } from "./brand";

export type Theme = "system" | "light" | "dark";

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "bad";
}

export interface Me {
  user: { id: string; email: string | null };
  memberships: Membership[];
  is_admin: boolean;
  /** Two-step verification: enrolled factor, this session's level, and whether admin work needs it. */
  mfa?: { enrolled: boolean; aal: "aal1" | "aal2"; admin_required: boolean };
}

/** What still stands between this session and the fleet's data: a code to enter, or an authenticator to add. */
export type MfaGate = "challenge" | "enrol" | null;

interface AppState {
  backend: Backend;
  config: AppConfig;
  /** Re-reads the public configuration (company details, certificates) after an admin changes it. */
  refreshConfig(): Promise<void>;
  mfaGate: MfaGate;
  brand: Brand;
  setBrand(b: Brand): void;
  theme: Theme;
  setTheme(t: Theme): void;
  me: Me | null;
  meError: string | null;
  fleetId: string | null;
  setFleetId(id: string): void;
  fleet: Fleet | null;
  vehicles: Vehicle[];
  drivers: Driver[];
  bookings: BookingRow[];
  events: BookingEvent[];
  network: NetworkSnapshot | null;
  loaded: { fleet: boolean; bookings: boolean; network: boolean };
  serverSkewMs: number;
  now: Date;
  refreshMe(): Promise<void>;
  refreshFleet(): Promise<void>;
  refreshBookings(): Promise<void>;
  refreshNetwork(): Promise<void>;
  upsertBooking(b: BookingRow): void;
  toasts: Toast[];
  toast(text: string, tone?: Toast["tone"]): void;
  api: Backend["api"];
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("depotcharge.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function AppProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(backend.config);
  const [brand, setBrandState] = useState<Brand>(backend.config.brand);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [fleetId, setFleetIdState] = useState<string | null>(null);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [events, setEvents] = useState<BookingEvent[]>([]);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(null);
  const [loaded, setLoaded] = useState({ fleet: false, bookings: false, network: false });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [serverSkewMs, setSkew] = useState(0);
  const toastId = useRef(1);

  useEffect(() => applyBrand(brand, theme), [brand, theme]);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => applyBrand(brand, theme);
    mq?.addEventListener?.("change", on);
    return () => mq?.removeEventListener?.("change", on);
  }, [brand, theme]);
  useEffect(() => {
    document.title = brand.name;
  }, [brand.name]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = toastId.current++;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 7000 : 4200);
  }, []);

  const api = backend.api;

  const refreshConfig = useCallback(async () => {
    const c = await api<AppConfig>("GET", "/config");
    // Keep what the backend decided at boot (mode, and the demo's placeholder OCPI address).
    const next: AppConfig = { ...c, mode: backend.config.mode, ocpi_versions_url: backend.config.ocpi_versions_url, brand: backend.config.brand };
    Object.assign(backend.config, next); // public pages (legal, pass) read backend.config directly
    setConfig({ ...next });
  }, [api, backend]);

  const refreshMe = useCallback(async () => {
    try {
      const m = await api<Me>("GET", "/me");
      setMe(m);
      setMeError(null);
      let preferred: string | null = null;
      try { preferred = localStorage.getItem("depotcharge.fleet"); } catch { /* ignore */ }
      const ids = m.memberships.map((x) => x.fleet_id);
      setFleetIdState((cur) => (cur && ids.includes(cur) ? cur : preferred && ids.includes(preferred) ? preferred : ids[0] ?? null));
    } catch (e) {
      setMeError(e instanceof Error ? e.message : "Could not load your account");
    }
  }, [api]);

  const refreshFleet = useCallback(async () => {
    if (!fleetId) return;
    const [f, v, d] = await Promise.all([
      api<Fleet>("GET", `/fleets/${fleetId}`),
      api<Vehicle[]>("GET", `/fleets/${fleetId}/vehicles`),
      api<Driver[]>("GET", `/fleets/${fleetId}/drivers`),
    ]);
    setFleet(f);
    setVehicles(v);
    setDrivers(d);
    setLoaded((l) => ({ ...l, fleet: true }));
  }, [api, fleetId]);

  const refreshBookings = useCallback(async () => {
    if (!fleetId) return;
    const from = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const r = await api<{ bookings: BookingRow[]; events: BookingEvent[]; server_time: string }>("GET", `/fleets/${fleetId}/bookings?from=${encodeURIComponent(from)}`);
    setBookings(r.bookings);
    setEvents(r.events);
    setSkew(new Date(r.server_time).getTime() - Date.now());
    setLoaded((l) => ({ ...l, bookings: true }));
  }, [api, fleetId]);

  const refreshNetwork = useCallback(async () => {
    const n = await api<NetworkSnapshot>("GET", "/network");
    setNetwork(n);
    setLoaded((l) => ({ ...l, network: true }));
  }, [api]);

  const upsertBooking = useCallback((b: BookingRow) => {
    setBookings((list) => {
      const i = list.findIndex((x) => x.id === b.id);
      if (i < 0) return [...list, b].sort((a, c) => a.start_at.localeCompare(c.start_at));
      const next = list.slice();
      next[i] = b;
      return next;
    });
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  // An account with an authenticator must use it, and a fleet can require one: until then the
  // API answers only /me, so nothing else is loaded.
  const membership = me?.memberships.find((m) => m.fleet_id === fleetId) ?? null;
  const mfaGate: MfaGate = !me?.mfa || !backend.auth || me.mfa.aal === "aal2" ? null : me.mfa.enrolled ? "challenge" : membership?.require_mfa ? "enrol" : null;

  useEffect(() => {
    if (!fleetId || mfaGate) return;
    try { localStorage.setItem("depotcharge.fleet", fleetId); } catch { /* ignore */ }
    setLoaded({ fleet: false, bookings: false, network: false });
    void refreshFleet().catch((e) => toast(e.message, "bad"));
    void refreshBookings().catch((e) => toast(e.message, "bad"));
    void refreshNetwork().catch((e) => toast(e.message, "bad"));
  }, [fleetId, mfaGate, refreshFleet, refreshBookings, refreshNetwork, toast]);

  // Live updates: push in demo mode; in live mode Supabase Realtime pushes, with polling as a
  // safety net (and as the fallback, faster while a CPO is still deciding, if the socket is down).
  const busy = bookings.some((b) => b.reservation_status === "PENDING" || b.pending_action || b.session?.status === "ACTIVE");
  const [pushed, setPushed] = useState(false);
  useEffect(() => {
    const auth = backend.auth;
    if (!fleetId || mfaGate || backend.onChange || !auth || !config.supabase_url || !config.supabase_anon_key) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const stop = subscribeFleet({
      supabaseUrl: config.supabase_url, anonKey: config.supabase_anon_key, fleetId, token: () => auth.token(),
      onStatus: setPushed,
      onChange: () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => void refreshBookings().catch(() => undefined), 300);
      },
    });
    return () => { stop(); if (t) clearTimeout(t); setPushed(false); };
  }, [backend, config.supabase_url, config.supabase_anon_key, fleetId, mfaGate, refreshBookings]);
  useEffect(() => {
    if (!fleetId || mfaGate) return;
    if (backend.onChange) {
      let t: ReturnType<typeof setTimeout> | null = null;
      const off = backend.onChange(() => {
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          void refreshBookings().catch(() => undefined);
          void refreshNetwork().catch(() => undefined);
        }, 250);
      });
      return () => { off(); if (t) clearTimeout(t); };
    }
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void refreshBookings().catch(() => undefined);
    }, pushed ? (busy ? 30_000 : 120_000) : busy ? 4000 : 20000);
    const nv = setInterval(() => {
      if (document.visibilityState === "visible") void refreshNetwork().catch(() => undefined);
    }, 120_000);
    const vis = () => { if (document.visibilityState === "visible") void refreshBookings().catch(() => undefined); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(iv); clearInterval(nv); document.removeEventListener("visibilitychange", vis); };
  }, [backend, fleetId, mfaGate, busy, pushed, refreshBookings, refreshNetwork]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem("depotcharge.theme", t); } catch { /* ignore */ }
  }, []);

  const value = useMemo<AppState>(() => ({
    backend, config, refreshConfig, mfaGate, brand, setBrand: setBrandState, theme, setTheme, me, meError, fleetId,
    setFleetId: setFleetIdState, fleet, vehicles, drivers, bookings, events, network, loaded, serverSkewMs, now,
    refreshMe, refreshFleet, refreshBookings, refreshNetwork, upsertBooking, toasts, toast, api,
  }), [backend, config, refreshConfig, mfaGate, brand, theme, setTheme, me, meError, fleetId, fleet, vehicles, drivers, bookings, events, network, loaded, serverSkewMs, now, refreshMe, refreshFleet, refreshBookings, refreshNetwork, upsertBooking, toasts, toast, api]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
