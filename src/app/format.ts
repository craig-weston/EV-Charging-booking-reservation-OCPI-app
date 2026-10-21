// Formatting for a UK audience: 24-hour clock, en-GB dates, £, miles. Times are shown in the
// site's own time zone (OCPI Location.time_zone).
import { formatter, localDateKey } from "../../shared/util";

export const DEFAULT_TZ = "Europe/London";

export function fmtTime(at: string | Date, tz = DEFAULT_TZ): string {
  return formatter("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}

export function fmtRange(start: string | Date, end: string | Date, tz = DEFAULT_TZ): string {
  return `${fmtTime(start, tz)}–${fmtTime(end, tz)}`;
}

export function dayDiff(at: Date, now: Date, tz = DEFAULT_TZ): number {
  const a = localDateKey(at, tz);
  const b = localDateKey(now, tz);
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/** "Today", "Tomorrow", "Yesterday" or "Thu 22 Oct". */
export function fmtDay(at: string | Date, now = new Date(), tz = DEFAULT_TZ): string {
  const d = new Date(at);
  const diff = dayDiff(d, now, tz);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return formatter("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
}

export function fmtLongDate(at: string | Date, tz = DEFAULT_TZ): string {
  return formatter("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(at));
}

/** "16:45 today", "07:00 tomorrow", "Thu, 22 Oct, 07:00". */
export function fmtDateTime(at: string | Date, now = new Date(), tz = DEFAULT_TZ): string {
  const t = fmtTime(at, tz);
  const diff = dayDiff(new Date(at), now, tz);
  if (diff === 0) return `${t} today`;
  if (diff === 1) return `${t} tomorrow`;
  if (diff === -1) return `${t} yesterday`;
  return `${fmtDay(at, now, tz)}, ${t}`;
}

export function fmtDuration(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function fmtRelative(at: string | Date, now = new Date()): string {
  const diff = Math.round((new Date(at).getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(diff);
  const span = abs < 1 ? "now" : abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  if (span === "now") return "just now";
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

export function fmtMoney(n: number | null | undefined, currency = "GBP"): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
}

const NUM0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const NUM2 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

export function fmtKw(kw: number | null | undefined): string {
  if (kw == null) return "—";
  if (kw >= 1000) return `${NUM1.format(kw / 1000)} MW`;
  return `${NUM0.format(kw)} kW`;
}

export function fmtKwh(kwh: number | null | undefined): string {
  if (kwh == null) return "—";
  return `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: kwh < 100 ? 1 : 0 }).format(kwh)} kWh`;
}

export function fmtMiles(km: number): string {
  const mi = km * 0.621371;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

export function fmtMetres(cm: number | null | undefined): string {
  if (!cm) return "—";
  return `${NUM2.format(cm / 100)} m`;
}

export function fmtTonnes(kg: number | null | undefined): string {
  if (!kg) return "—";
  return `${Math.round(kg / 100) / 10} t`;
}

/** "Kestrel Charge" → KC, "VoltHaul" → VH (camel-case words count twice), "Ann" → A. */
export function initials(name: string): string {
  const words = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    const caps = words[0].match(/[A-Z]/g) ?? [];
    if (caps.length >= 2) return (caps[0] + caps[1]).toUpperCase();
  }
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** "Tuesday 20 October" in the viewer's zone, plus the greeting for the hour. */
export function greeting(now = new Date()): string {
  const h = Number(formatter("en-GB", { timeZone: DEFAULT_TZ, hour: "2-digit", hourCycle: "h23" }).format(now));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Average power of a live session so far; the requested power until there is enough to measure. */
export function sessionKw(b: { session: { kwh: number; start_date_time: string } | null; power_required_kw: number | null }, now: Date): number | null {
  if (!b.session) return null;
  const h = (now.getTime() - new Date(b.session.start_date_time).getTime()) / 3_600_000;
  if (h < 0.05 || b.session.kwh < 1) return b.power_required_kw;
  const kw = b.session.kwh / h;
  return Math.round(b.power_required_kw ? Math.min(kw, b.power_required_kw * 1.05) : kw);
}
