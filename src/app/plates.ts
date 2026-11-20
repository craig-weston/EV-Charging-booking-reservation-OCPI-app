// Number-plate lookup from this deployment's POST /api/public/plate (server/plates.ts), and the
// trucks a visitor has looked up on the public map, kept in their browser so the app can offer to
// add them to the fleet after sign-up.
import type { PlateDetails } from "../../shared/plates";
import { normalizePlate } from "../../shared/util";

export type { PlateDetails };

export type PlateResult = { ok: true; details: PlateDetails } | { ok: false; message: string; unavailable: boolean };

export async function lookupPlate(origin: string | undefined, plate: string): Promise<PlateResult> {
  const off: PlateResult = { ok: false, message: "Number-plate lookup isn't available here. Enter the details by hand.", unavailable: true };
  if (origin == null) return off;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const r = await fetch(`${origin.replace(/\/+$/, "")}/api/public/plate`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ plate }), signal: ctl.signal });
    const j = (await r.json().catch(() => null)) as { data?: PlateDetails; error?: { message?: string } } | null;
    if (r.ok && j?.data?.plate) return { ok: true, details: j.data };
    if (r.status === 429) return { ok: false, message: "Too many lookups. Wait a minute and try again.", unavailable: false };
    return { ok: false, message: j?.error?.message ?? off.message, unavailable: r.status >= 500 || !j?.error };
  } catch {
    return { ok: false, message: "The lookup didn't answer. Try again in a moment.", unavailable: false };
  } finally { clearTimeout(timer); }
}

const KEY = "depotcharge.map.trucks";
const MAX = 12;

/** Trucks looked up on the map, newest first (this browser only). */
export function savedTrucks(): PlateDetails[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as PlateDetails[]).filter((t) => t && typeof t.plate === "string" && typeof t.kind === "string").slice(0, MAX) : [];
  } catch { return []; }
}

/** Save a truck: first in the list (a new lookup, keeping any figures the planner set), or where it is (an edit). */
export function saveTruck(t: PlateDetails, toTop = true): PlateDetails[] {
  const all = savedTrucks();
  const same = (x: PlateDetails) => normalizePlate(x.plate) === normalizePlate(t.plate);
  const old = all.find(same);
  const next = toTop
    ? [{ ...t, profile: t.profile ?? old?.profile }, ...all.filter((x) => !same(x))].slice(0, MAX)
    : old ? all.map((x) => (same(x) ? t : x)) : [t, ...all].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: not remembered */ }
  return next;
}

export function forgetTruck(plate: string): PlateDetails[] {
  const next = savedTrucks().filter((x) => normalizePlate(x.plate) !== normalizePlate(plate));
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}
