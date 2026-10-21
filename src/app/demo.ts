// Demo mode: the full server (API, OCPI interface and CPO simulator) runs in this browser tab with
// an in-memory store saved to localStorage. Used when no Supabase project is configured, and for
// previews. Data never leaves the browser.
import type { AppConfig, BookingRow, Driver, Fleet, NetworkSnapshot, Vehicle } from "../../shared/model";
import { DEFAULT_BRAND } from "../../shared/model";
import type { BookingLocation } from "../../shared/ocpi/types";
import { suggestSlots } from "../../shared/booking/slots";
import { MINUTE, addLocalDays, localToUtc, localDateKey, startOfLocalDay } from "../../shared/util";
import { createLocalCtx, dispatch } from "../../server/dispatch";
import { MemoryStore, type MemoryData } from "../../server/store/memory";
import { tick } from "../../server/sim/cpo";
import { ApiFailure, type Backend } from "./backend";

const STORAGE_KEY = "depotcharge.demo.v1";
// The demo user counts as signed in with a second factor, so security settings can be tried out.
const USER = { id: "demo-user", email: "planner@example.com", aal: "aal2" as const, mfa: false };

function loadData(): MemoryData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as MemoryData;
    return Array.isArray(d.fleets) && d.fleets.length ? d : null;
  } catch {
    return null;
  }
}

function saveData(store: MemoryStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.data));
  } catch {
    // Quota: keep fewer log entries and try once more.
    try {
      store.data.logs = store.data.logs.slice(-60);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.data));
    } catch { /* storage unavailable — demo still works for this tab */ }
  }
}

/** Lets the seed turn the clock back to create a believable two-week history. */
export interface DemoClock {
  set(d: Date | null): void;
  now(): Date;
}

export async function createDemoBackend(base?: Partial<AppConfig>): Promise<Backend> {
  const saved = loadData();
  const store = new MemoryStore(saved ?? undefined);
  store.maxLogs = 160;
  let fakeNow: number | null = null;
  const ctx = createLocalCtx({
    store,
    baseUrl: "https://demo.depotcharge.local",
    user: USER,
    simDelayMs: 0,
    now: () => (fakeNow != null ? new Date(fakeNow) : new Date()),
    env: { OCPI_COUNTRY_CODE: base?.party?.country_code ?? "GB", OCPI_PARTY_ID: base?.party?.party_id ?? "DPC", OCPI_BUSINESS_NAME: base?.party?.name ?? "Depotcharge", ENABLE_CPO_SIMULATOR: "true" },
  });
  const clock: DemoClock = { set: (d) => { fakeNow = d ? d.getTime() : null; }, now: () => ctx.now() };

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await dispatch(new Request(`${ctx.baseUrl}/api${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }), ctx);
    const json = (await res.json()) as { data?: T; error?: { message: string; code?: string } };
    if (!res.ok) throw new ApiFailure(res.status, json.error?.message ?? "Request failed", json.error?.code);
    return json.data as T;
  };

  if (!saved) {
    store.data.admins.push(USER.id);
    if (base?.brand) await store.setBrand({ ...DEFAULT_BRAND, ...base.brand });
    try {
      await seed(api, clock, () => ctx.flush(), store, async () => { await tick(ctx); await ctx.flush(); });
    } finally {
      clock.set(null);
    }
    await ctx.flush();
  }
  ctx.simDelayMs = 1600; // feel the asynchronous CPO confirmation from now on

  let timer: ReturnType<typeof setTimeout> | null = null;
  store.onChange(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveData(store), 400);
  });
  saveData(store);
  // Let simulated time pass: sessions accumulate energy, no-shows get released.
  setInterval(() => void tick(ctx).catch(() => undefined), 15_000);

  const config = await api<AppConfig>("GET", "/config");
  return {
    mode: "demo",
    config: { ...config, mode: "demo", ocpi_versions_url: "https://your-domain.example/ocpi/versions" },
    auth: null,
    api,
    onChange: (cb) => store.onChange(cb),
    async reset() {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      window.location.reload();
    },
  };
}

type Api = <T>(m: string, p: string, b?: unknown) => Promise<T>;

/** A believable starting point: a fleet, two weeks of charging history and today's bookings. */
async function seed(api: Api, clock: DemoClock, flush: () => Promise<void>, store: MemoryStore, tickNow: () => Promise<void>) {
  const fleet = await api<Fleet>("POST", "/fleets", { name: "Demo Haulage Ltd", sample: true, accept_terms: true });
  await api("PATCH", `/fleets/${fleet.id}`, { desk_phone: "0161 496 0000" });
  const vehicles = await api<Vehicle[]>("GET", `/fleets/${fleet.id}/vehicles`);
  const drivers = await api<Driver[]>("GET", `/fleets/${fleet.id}/drivers`);
  await seedHistory(api, clock, flush, store, fleet, vehicles, drivers).catch((e) => console.warn("demo history skipped", e));
  await seedChargingNow(api, clock, flush, store, fleet, vehicles, drivers).catch((e) => console.warn("demo session skipped", e));
  clock.set(null);
  const now = clock.now();
  await api("POST", "/admin/simulator/connect");
  const net = await api<NetworkSnapshot>("GET", "/network");
  const v = (name: string) => vehicles.find((x) => x.name === name)!;
  const bl = (id: string) => net.booking_locations.find((b) => b.id === id)?.data as BookingLocation | undefined;
  const tz = "Europe/London";
  const today = startOfLocalDay(now, tz);
  const tomorrow = addLocalDays(today, 1, tz);
  const at = (day: Date, hh: number, mm = 0) => {
    const [y, m, d] = localDateKey(new Date(day.getTime() + 12 * 60 * MINUTE), tz).split("-").map(Number);
    return localToUtc(y, m, d, hh, mm, tz);
  };

  const book = async (vehicle: string, blId: string, desired: Date, minutes: number, driverIdx?: number) => {
    const b = bl(blId);
    if (!b) return null;
    const s = suggestSlots(b, desired, minutes, now, { count: 1, horizonMin: 6 * 60 })[0];
    if (!s) return null;
    try {
      const row = await api<BookingRow>("POST", `/fleets/${fleet.id}/bookings`, {
        vehicle_id: v(vehicle).id, driver_id: driverIdx != null ? drivers[driverIdx]?.id ?? null : null,
        cpo_country_code: b.country_code, cpo_party_id: b.party_id, booking_location_id: b.id,
        start_at: s.start.toISOString(), end_at: s.end.toISOString(), power_required_kw: null,
      });
      await flush(); // let the simulated CPO confirm before the next step
      return row;
    } catch {
      return null;
    }
  };

  await book("Tractor 01", "VHL-DAV-MCS", new Date(now.getTime() + 3 * 60 * MINUTE), 45, 1);
  await book("Rigid 03", "DSN-NTH-CCS", at(today, 21, 0), 180, 2);
  await book("Tanker 05", "VHL-FXT-MCS", at(tomorrow, 7, 30), 60);
  const lut = await book("Reefer 04", "VHL-LUT-CCS", at(tomorrow, 11, 0), 60);
  if (lut) {
    try { await api("POST", "/admin/simulator/action", { action: "cpo_cancel", booking_id: lut.id, reason: "BROKEN_CHARGER" }); await flush(); } catch { /* ignore */ }
  }
  await tickNow().catch(() => undefined); // the live session's first meter reading
}

/** One truck on charge right now: booked and arrived about twenty minutes ago. */
async function seedChargingNow(api: Api, clock: DemoClock, flush: () => Promise<void>, store: MemoryStore, fleet: Fleet, vehicles: Vehicle[], drivers: Driver[]) {
  clock.set(null);
  const real = clock.now().getTime();
  const vehicle = vehicles.find((x) => x.name === "Tractor 02");
  if (!vehicle) return;
  clock.set(new Date(real - 50 * MINUTE));
  await api("POST", "/admin/simulator/connect");
  const bl = (await store.listObjects<BookingLocation>("booking_locations")).find((o) => o.id === "KCH-LYM-CCS")?.data;
  const slot = bl ? suggestSlots(bl, new Date(real - 25 * MINUTE), 60, clock.now(), { count: 1, horizonMin: 3 * 60 })[0] : undefined;
  if (!bl || !slot) return;
  const row = await api<BookingRow>("POST", `/fleets/${fleet.id}/bookings`, {
    vehicle_id: vehicle.id, driver_id: drivers[0]?.id ?? null, cpo_country_code: bl.country_code, cpo_party_id: bl.party_id,
    booking_location_id: bl.id, start_at: slot.start.toISOString(), end_at: slot.end.toISOString(), power_required_kw: null,
  });
  await flush();
  clock.set(new Date(Math.min(real - MINUTE, Math.max(slot.start.getTime() - 15 * MINUTE, slot.start.getTime() + 2 * MINUTE))));
  try { await api("POST", "/admin/simulator/action", { action: "arrive", booking_id: row.id }); await flush(); } catch { /* slot not open yet */ }
}

type Outcome = "charge" | "noshow" | "cancel";
/** Days ago, local start time, truck, bookable bay type, minutes, what happened, driver. */
const HISTORY: [number, number, number, string, string, number, Outcome, number?][] = [
  [13, 5, 30, "Tractor 01", "VHL-DAV-MCS", 45, "charge", 1],
  [12, 12, 30, "Tractor 02", "KCH-LYM-CCS", 60, "charge", 0],
  [12, 21, 0, "Rigid 03", "DSN-NTH-CCS", 180, "charge", 2],
  [11, 7, 30, "Tanker 05", "VHL-FXT-MCS", 60, "charge"],
  [10, 11, 0, "Reefer 04", "VHL-LUT-CCS", 60, "charge"],
  [9, 6, 0, "Tractor 01", "VHL-DAV-MCS", 45, "noshow", 1],
  [8, 13, 0, "Tractor 02", "KCH-LYM-CCS", 60, "charge", 0],
  [7, 21, 0, "Rigid 03", "DSN-NTH-CCS", 180, "charge", 2],
  [6, 5, 30, "Tractor 01", "VHL-DAV-MCS", 45, "charge", 1],
  [5, 12, 0, "Tractor 02", "KCH-LYM-CCS", 60, "charge", 0],
  [4, 7, 30, "Tanker 05", "VHL-FXT-MCS", 60, "cancel"],
  [3, 11, 0, "Reefer 04", "VHL-LUT-CCS", 60, "charge"],
  [3, 21, 0, "Rigid 03", "DSN-NTH-CCS", 180, "charge", 2],
  [2, 6, 0, "Tractor 01", "VHL-DAV-MCS", 45, "charge", 1],
  [2, 13, 30, "Tanker 05", "VHL-FXT-MCS", 60, "charge"],
  [1, 12, 30, "Tractor 02", "KCH-LYM-CCS", 50, "charge", 0],
  [1, 21, 0, "Rigid 03", "DSN-NTH-CCS", 180, "charge", 2],
];

/**
 * Plays the last two weeks through the real stack (OCPI booking, arrival, session, CDR) with the
 * clock turned back, so the dashboard opens with history. Its OCPI messages are dropped from the
 * log afterwards so the message log starts clean.
 */
async function seedHistory(api: Api, clock: DemoClock, flush: () => Promise<void>, store: MemoryStore, fleet: Fleet, vehicles: Vehicle[], drivers: Driver[]) {
  const tz = "Europe/London";
  const real = clock.now();
  const today = startOfLocalDay(real, tz);
  const at = (daysAgo: number, hh: number, mm: number) => {
    const day = addLocalDays(today, -daysAgo, tz);
    const [y, m, d] = localDateKey(new Date(day.getTime() + 12 * 60 * MINUTE), tz).split("-").map(Number);
    return localToUtc(y, m, d, hh, mm, tz);
  };
  const logsBefore = new Set(store.data.logs.map((l) => l.id));
  const touched = new Map<string, Date>();
  let syncedAt = -Infinity;
  for (const [daysAgo, hh, mm, name, blId, minutes, outcome, driverIdx] of HISTORY) {
    const vehicle = vehicles.find((x) => x.name === name);
    const desired = at(daysAgo, hh, mm);
    if (!vehicle || desired.getTime() > real.getTime() - 4 * 60 * MINUTE) continue;
    const bookAt = new Date(desired.getTime() - 4 * 60 * MINUTE);
    // Calendars cover a week ahead: refresh them when the clock has moved on.
    if (bookAt.getTime() - syncedAt > 5 * 24 * 60 * MINUTE) {
      clock.set(bookAt);
      await api("POST", "/admin/simulator/connect");
      syncedAt = bookAt.getTime();
    }
    clock.set(bookAt);
    const bl = (await store.listObjects<BookingLocation>("booking_locations")).find((o) => o.id === blId)?.data;
    const slot = bl ? suggestSlots(bl, desired, minutes, bookAt, { count: 1, horizonMin: 6 * 60 })[0] : undefined;
    if (!bl || !slot) continue;
    let row: BookingRow;
    try {
      row = await api<BookingRow>("POST", `/fleets/${fleet.id}/bookings`, {
        vehicle_id: vehicle.id, driver_id: driverIdx != null ? drivers[driverIdx]?.id ?? null : null,
        cpo_country_code: bl.country_code, cpo_party_id: bl.party_id, booking_location_id: bl.id,
        start_at: slot.start.toISOString(), end_at: slot.end.toISOString(), power_required_kw: null,
      });
      await flush();
    } catch {
      continue;
    }
    const step = async (t: Date, fn: () => Promise<unknown>) => {
      clock.set(t);
      try { await fn(); await flush(); } catch { /* keep going: the demo history is best-effort */ }
      touched.set(row.id, t);
    };
    const start = slot.start.getTime();
    if (outcome === "cancel") {
      await step(new Date(start - 3 * 60 * MINUTE), () => api("POST", `/fleets/${fleet.id}/bookings/${row.id}/cancel`, { reason: "TRAFFIC" }));
      continue;
    }
    if (outcome === "noshow") {
      await step(new Date(start + 21 * MINUTE), () => api("POST", "/admin/simulator/action", { action: "no_show", booking_id: row.id }));
      continue;
    }
    await step(new Date(start + (3 + (hh % 4)) * MINUTE), () => api("POST", "/admin/simulator/action", { action: "arrive", booking_id: row.id }));
    const stay = Math.round((slot.end.getTime() - start) / MINUTE);
    await step(new Date(start + Math.max(20, stay - 6 - (mm % 7)) * MINUTE), () => api("POST", "/admin/simulator/action", { action: "finish", booking_id: row.id }));
  }
  // The store stamps updated_at with the wall clock; give history rows their own time back.
  for (const b of store.data.bookings) {
    const t = touched.get(b.id);
    if (t) b.updated_at = t.toISOString();
  }
  store.data.logs = store.data.logs.filter((l) => logsBefore.has(l.id));
}
