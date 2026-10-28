// Monthly charging statements: what each fleet owes the platform for a calendar month.
//
// Pricing model: the operator's price plus the platform's margin. The operator's price is the
// charge record's total_cost (ex VAT), which already includes its booking fee; the margin is a
// percentage on top. VAT is added to the total at the standard rate. Amounts are rounded to the
// penny per line, and totals are sums of the rounded lines, so a statement always adds up.
import type { BookingRow, CdrSummary } from "./model";
import { localDateKey, localToUtc } from "./util";

export const STATEMENT_TZ = "Europe/London";
/** UK standard rate. HMRC treats public charging as standard-rated (see docs/billing.md). */
export const DEFAULT_VAT_RATE = 0.2;
export const MAX_MARGIN_PERCENT = 100;

export interface MarginChange { from: string; margin_percent: number }
export interface BillingSettings {
  /** The current margin, added to the operator's price, in percent (12.5 = 12.5%). */
  margin_percent: number;
  vat_rate: number;
  /** Every margin and when it took effect, oldest first: a charge is priced at the margin in force
   *  when it finished, so changing the margin never re-prices a month already billed. */
  history: MarginChange[];
}
export const DEFAULT_BILLING: BillingSettings = { margin_percent: 0, vat_rate: DEFAULT_VAT_RATE, history: [] };

/** The margin in force at a moment (0 before any margin was set). */
export function marginAt(history: MarginChange[] | undefined, at: string): number {
  const t = Date.parse(at);
  let m = 0;
  for (const h of history ?? []) if (Date.parse(h.from) <= t) m = h.margin_percent;
  return m;
}

export interface StatementLine {
  booking_id: string;
  cdr_id: string;
  /** When charging ended (the line's date). */
  ended_at: string;
  plate: string;
  vehicle_name: string | null;
  site: string;
  operator: string;
  kwh: number;
  /** Operator's price ex VAT, including its booking fee. */
  operator_cost: number;
  /** The part of operator_cost that is a booking (reservation) fee, when the operator says. */
  booking_fee: number | null;
  margin: number;
  /** The margin in force when the charge finished, in percent. */
  margin_percent: number;
  /** What the fleet pays ex VAT: operator_cost + margin. */
  net: number;
}

export interface Statement {
  month: string; // "2026-10"
  period: { from: string; to: string }; // UTC instants: [from, to)
  currency: string;
  /** The margin on every line, or null when it changed during the month (each line has its own). */
  margin_percent: number | null;
  vat_rate: number;
  lines: StatementLine[];
  totals: { kwh: number; operator_cost: number; margin: number; net: number; vat: number; gross: number; charges: number };
  /** Currencies on charge records that differ from the statement's (left out of the totals). */
  other_currencies: string[];
}

const pennies = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function validMonth(month: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
  const y = Number(month.slice(0, 4));
  return y >= 2020 && y <= 2100;
}

/** The month's boundaries in UK local time, as UTC instants. */
export function monthPeriod(month: string, tz = STATEMENT_TZ): { from: Date; to: Date } {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const from = localToUtc(y, m, 1, 0, 0, tz);
  const to = m === 12 ? localToUtc(y + 1, 1, 1, 0, 0, tz) : localToUtc(y, m + 1, 1, 0, 0, tz);
  return { from, to };
}

export function monthOf(at: Date, tz = STATEMENT_TZ): string {
  return localDateKey(at, tz).slice(0, 7);
}

export function previousMonth(month: string): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function priceLine(cdr: Pick<CdrSummary, "total_cost">, marginPercent: number): { operator_cost: number; margin: number; net: number } {
  const operator_cost = pennies(cdr.total_cost);
  const margin = pennies(operator_cost * marginPercent / 100);
  return { operator_cost, margin, net: pennies(operator_cost + margin) };
}

export function cleanMargin(x: unknown): number | null {
  const m = Number(x);
  if (x === null || x === undefined || x === "" || !Number.isFinite(m)) return null;
  return Math.min(MAX_MARGIN_PERCENT, Math.max(0, Math.round(m * 100) / 100));
}

export function cleanBilling(input: Partial<BillingSettings> | null | undefined): BillingSettings {
  const v = Number(input?.vat_rate);
  const history = (Array.isArray(input?.history) ? input!.history : [])
    .filter((h): h is MarginChange => !!h && typeof h.from === "string" && !Number.isNaN(Date.parse(h.from)) && cleanMargin(h.margin_percent) !== null)
    .map((h) => ({ from: new Date(h.from).toISOString(), margin_percent: cleanMargin(h.margin_percent)! }))
    .sort((a, b) => a.from.localeCompare(b.from));
  return {
    margin_percent: cleanMargin(input?.margin_percent) ?? history.at(-1)?.margin_percent ?? DEFAULT_BILLING.margin_percent,
    vat_rate: Number.isFinite(v) && v >= 0 && v <= 0.5 ? v : DEFAULT_BILLING.vat_rate,
    history,
  };
}

/** A new margin from now on; earlier charges keep the margin they had. */
export function withMargin(b: BillingSettings, margin: number, now: Date): BillingSettings {
  const at = now.toISOString();
  return cleanBilling({ ...b, margin_percent: margin, history: [...b.history.filter((h) => h.from < at), { from: at, margin_percent: margin }] });
}

export interface StatementInput {
  month: string;
  bookings: BookingRow[];
  billing: BillingSettings;
  site(b: BookingRow): string;
  operator(b: BookingRow): string;
  vehicleName(b: BookingRow): string | null;
  currency?: string;
}

/** Every charge record that ended in the month, priced at the operator's price plus the margin. */
export function buildStatement(i: StatementInput): Statement {
  const { from, to } = monthPeriod(i.month);
  const inMonth = i.bookings.filter((b): b is BookingRow & { cdr: CdrSummary } => {
    if (!b.cdr) return false;
    const end = Date.parse(b.cdr.end_date_time);
    return end >= from.getTime() && end < to.getTime();
  });
  const currency = i.currency ?? mostCommon(inMonth.map((b) => b.cdr.currency || "GBP")) ?? "GBP";
  const lines: StatementLine[] = [];
  const other = new Set<string>();
  for (const b of inMonth.sort((a, c) => a.cdr.end_date_time.localeCompare(c.cdr.end_date_time))) {
    if ((b.cdr.currency || "GBP") !== currency) { other.add(b.cdr.currency); continue; }
    const pct = marginAt(i.billing.history, new Date(b.cdr.end_date_time).toISOString());
    const p = priceLine(b.cdr, pct);
    lines.push({
      booking_id: b.id,
      cdr_id: b.cdr.id,
      ended_at: b.cdr.end_date_time,
      plate: b.plate,
      vehicle_name: i.vehicleName(b),
      site: i.site(b),
      operator: i.operator(b),
      kwh: Math.round(b.cdr.total_energy * 1000) / 1000,
      booking_fee: b.cdr.total_reservation_cost != null ? pennies(b.cdr.total_reservation_cost) : null,
      margin_percent: pct,
      ...p,
    });
  }
  const sum = (k: "operator_cost" | "margin" | "net") => pennies(lines.reduce((s, l) => s + l[k], 0));
  const net = sum("net");
  const vat = pennies(net * i.billing.vat_rate);
  return {
    month: i.month,
    period: { from: from.toISOString(), to: to.toISOString() },
    currency,
    margin_percent: new Set(lines.map((l) => l.margin_percent)).size > 1 ? null : lines[0]?.margin_percent ?? marginAt(i.billing.history, to.toISOString()),
    vat_rate: i.billing.vat_rate,
    lines,
    totals: {
      kwh: Math.round(lines.reduce((s, l) => s + l.kwh, 0) * 10) / 10,
      operator_cost: sum("operator_cost"),
      margin: sum("margin"),
      net,
      vat,
      gross: pennies(net + vat),
      charges: lines.length,
    },
    other_currencies: [...other],
  };
}

function mostCommon(xs: string[]): string | null {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  let best: string | null = null;
  for (const [k, v] of n) if (best === null || v > (n.get(best) ?? 0)) best = k;
  return best;
}

/** CSV for accounting software: one row per charge, then the totals. */
export function statementCsv(s: Statement, fleetName: string): string {
  const esc = (v: string | number | null) => {
    const t = v == null ? "" : String(v);
    // Spreadsheet formula injection: a cell starting with = + - @ is shown as text.
    const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows: (string | number | null)[][] = [
    ["Fleet", "Month", "Charging ended", "Plate", "Vehicle", "Site", "Operator", "kWh", `Operator price ex VAT (${s.currency})`, `Booking fee included (${s.currency})`, `Margin${s.margin_percent != null ? ` ${s.margin_percent}%` : ""} (${s.currency})`, `Total ex VAT (${s.currency})`, "Booking ID", "Charge record ID"],
    ...s.lines.map((l) => [fleetName, s.month, l.ended_at, l.plate, l.vehicle_name, l.site, l.operator, l.kwh, l.operator_cost.toFixed(2), l.booking_fee == null ? null : l.booking_fee.toFixed(2), l.margin.toFixed(2), l.net.toFixed(2), l.booking_id, l.cdr_id]),
    [],
    ["Total ex VAT", null, null, null, null, null, null, s.totals.kwh, s.totals.operator_cost.toFixed(2), null, s.totals.margin.toFixed(2), s.totals.net.toFixed(2)],
    [`VAT ${Math.round(s.vat_rate * 1000) / 10}%`, null, null, null, null, null, null, null, null, null, null, s.totals.vat.toFixed(2)],
    ["Total incl. VAT", null, null, null, null, null, null, null, null, null, null, s.totals.gross.toFixed(2)],
  ];
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
