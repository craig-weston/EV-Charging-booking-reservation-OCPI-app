// Small runtime-agnostic helpers (browser, Cloudflare Workers, Node ≥ 20).

export function uuid(): string {
  // randomUUID only exists in secure contexts (https, localhost); fall back to an RFC 4122 v4 id
  // so the app also runs over plain http on a LAN address or in older browsers.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** URL-safe random string, e.g. for credentials tokens and pass links. */
export function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Short upper-case id with a prefix, max 36 chars (OCPI CiString(36)). */
export function shortId(prefix: string, len = 10): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += alphabet[b % alphabet.length];
  return `${prefix}${s}`.slice(0, 36);
}

export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToUtf8(s: string): string | null {
  try {
    const bin = atob(s.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- time
export const MINUTE = 60_000;

/** OCPI DateTime: UTC, second precision, with Z. */
export function iso(d: Date | number | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addMinutes(d: Date | string | number, minutes: number): Date {
  return new Date(new Date(d).getTime() + minutes * MINUTE);
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / MINUTE);
}

/** Rounds `d` up to the next multiple of `step` minutes, measured from `anchor`. */
export function ceilToStep(d: Date, stepMin: number, anchor: Date = new Date(0)): Date {
  const step = Math.max(1, stepMin) * MINUTE;
  const off = d.getTime() - anchor.getTime();
  return new Date(anchor.getTime() + Math.ceil(off / step) * step);
}

export function floorToStep(d: Date, stepMin: number, anchor: Date = new Date(0)): Date {
  const step = Math.max(1, stepMin) * MINUTE;
  const off = d.getTime() - anchor.getTime();
  return new Date(anchor.getTime() + Math.floor(off / step) * step);
}

// Intl.DateTimeFormat construction is expensive; cache one formatter per (zone, options).
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
export function formatter(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    FORMATTERS.set(key, f);
  }
  return f;
}

/** Offset (minutes) of an IANA time zone from UTC at a given instant. */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = formatter("en-GB", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MINUTE);
}

/** The UTC instant of local midnight for the calendar day containing `at` in `timeZone`. */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const [y, m, d] = localDateKey(at, timeZone).split("-").map(Number);
  return localToUtc(y, m, d, 0, 0, timeZone);
}

/** Converts a wall-clock time in `timeZone` to a UTC Date (handles DST). */
export function localToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const off1 = tzOffsetMinutes(timeZone, guess);
  const first = new Date(guess.getTime() - off1 * MINUTE);
  const off2 = tzOffsetMinutes(timeZone, first);
  return off1 === off2 ? first : new Date(guess.getTime() - off2 * MINUTE);
}

/** "YYYY-MM-DD" of `at` in `timeZone`. */
export function localDateKey(at: Date, timeZone: string): string {
  return formatter("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function addLocalDays(dayStart: Date, days: number, timeZone: string): Date {
  const key = localDateKey(new Date(dayStart.getTime() + 12 * 60 * MINUTE), timeZone);
  const [y, m, d] = key.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + days, 12));
  return startOfLocalDay(base, timeZone);
}

/** Local hour (0–23) and ISO weekday (1 = Monday) of an instant. */
export function localHourWeekday(at: Date, timeZone: string): { hour: number; weekday: number } {
  const parts = formatter("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return { hour, weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd) + 1 };
}

// ---------------------------------------------------------------- misc
/** "pn74 evh" → "PN74EVH" — the form sent as AccessInformation.value for ANPR. */
export function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "pn74evh" → "PN74 EVH" for current-style UK plates; anything else is just upper-cased. */
export function displayPlate(plate: string): string {
  const p = normalizePlate(plate);
  return /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(p) ? `${p.slice(0, 4)} ${p.slice(4)}` : plate.toUpperCase().trim();
}

export function upper(s: string): string {
  return (s || "").toUpperCase();
}

export function partyKey(countryCode: string, partyId: string): string {
  return `${upper(countryCode)}*${upper(partyId)}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function deepMerge<T>(target: T, patch: Partial<T>): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
      ? deepMerge(cur, v as never)
      : v;
  }
  return out as T;
}
