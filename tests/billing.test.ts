// Monthly charging statements: operator price + platform margin, VAT, month boundaries, CSV.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingRow, Fleet, FleetStatement } from "../shared/model";
import { buildStatement, cleanBilling, marginAt, monthPeriod, previousMonth, priceLine, statementCsv, withMargin, type BillingSettings } from "../shared/billing";
import { harness } from "./helpers";

function row(id: string, end: string, cost: number, extra: Partial<BookingRow> = {}): BookingRow {
  return {
    id, fleet_id: "f", vehicle_id: null, plate: "PN74 EVH", partner_id: null, cpo_country_code: "GB", cpo_party_id: "VHL", location_id: "LOC1",
    start_at: end, end_at: end, reservation_status: "FULFILLED",
    cdr: { id: `cdr-${id}`, total_energy: 200, total_time: 1, total_cost: cost, total_reservation_cost: 6.75, currency: "GBP", start_date_time: end, end_date_time: end },
    ...extra,
  } as unknown as BookingRow;
}
const flat = (m: number): BillingSettings => ({ margin_percent: m, vat_rate: 0.2, history: [{ from: "2020-01-01T00:00:00.000Z", margin_percent: m }] });
const names = { site: () => "Daventry DIRFT", operator: () => "VoltHaul", vehicleName: () => "Tractor 01" };

test("priceLine: operator price plus margin, to the penny", () => {
  assert.deepEqual(priceLine({ total_cost: 100 }, 12.5), { operator_cost: 100, margin: 12.5, net: 112.5 });
  assert.deepEqual(priceLine({ total_cost: 106.425 }, 10), { operator_cost: 106.43, margin: 10.64, net: 117.07 });
  assert.deepEqual(priceLine({ total_cost: 50 }, 0), { operator_cost: 50, margin: 0, net: 50 });
});

test("cleanBilling: margin kept between 0 and 100, VAT defaults to 20%", () => {
  assert.deepEqual(cleanBilling({ margin_percent: 12.345 }), { margin_percent: 12.35, vat_rate: 0.2, history: [] });
  assert.equal(cleanBilling({ margin_percent: -5 }).margin_percent, 0);
  assert.equal(cleanBilling({ margin_percent: 500 }).margin_percent, 100);
  assert.equal(cleanBilling({ margin_percent: "abc" as unknown as number }).margin_percent, 0);
  assert.equal(cleanBilling(null).vat_rate, 0.2);
});

test("months follow UK time: a charge ending 00:30 BST on 1 April is April's", () => {
  const { from, to } = monthPeriod("2026-03");
  assert.equal(from.toISOString(), "2026-03-01T00:00:00.000Z"); // GMT
  assert.equal(to.toISOString(), "2026-03-31T23:00:00.000Z"); // midnight BST
  const s = buildStatement({ month: "2026-03", billing: flat(10), ...names, bookings: [
    row("a", "2026-03-01T00:10:00Z", 100), row("b", "2026-03-31T23:30:00Z", 100), row("c", "2026-02-28T23:59:00Z", 100), row("d", "2026-03-15T10:00:00Z", 0, { cdr: null }),
  ] });
  assert.deepEqual(s.lines.map((l) => l.booking_id), ["a"]);
  assert.equal(previousMonth("2026-01"), "2025-12");
});

test("statement totals are sums of the rounded lines, then VAT", () => {
  const s = buildStatement({ month: "2026-10", billing: flat(12.5), ...names, bookings: [
    row("a", "2026-10-03T10:00:00Z", 106.42), row("b", "2026-10-01T09:00:00Z", 150.72), row("c", "2026-10-20T09:00:00Z", 99.99, { cdr: { id: "x", total_energy: 1, total_time: 1, total_cost: 99.99, currency: "EUR", start_date_time: "2026-10-20T09:00:00Z", end_date_time: "2026-10-20T09:00:00Z" } }),
  ] });
  assert.deepEqual(s.lines.map((l) => l.booking_id), ["b", "a"], "oldest first, other currency left out");
  assert.deepEqual(s.other_currencies, ["EUR"]);
  assert.equal(s.totals.operator_cost, 257.14);
  assert.equal(s.totals.margin, Math.round((18.84 + 13.3) * 100) / 100);
  assert.equal(s.totals.net, Math.round((s.lines[0].net + s.lines[1].net) * 100) / 100);
  assert.equal(s.totals.vat, Math.round(s.totals.net * 0.2 * 100) / 100);
  assert.equal(s.totals.gross, Math.round((s.totals.net + s.totals.vat) * 100) / 100);
  assert.equal(s.lines[0].booking_fee, 6.75);
});

test("a new margin applies from now on; earlier charges keep theirs", () => {
  let b = cleanBilling(null);
  b = withMargin(b, 10, new Date("2026-10-10T12:00:00Z"));
  b = withMargin(b, 15, new Date("2026-10-20T12:00:00Z"));
  assert.equal(marginAt(b.history, "2026-10-01T00:00:00Z"), 0);
  assert.equal(marginAt(b.history, "2026-10-15T00:00:00Z"), 10);
  assert.equal(marginAt(b.history, "2026-10-25T00:00:00Z"), 15);
  const s = buildStatement({ month: "2026-10", billing: b, ...names, bookings: [row("a", "2026-10-05T10:00:00Z", 100), row("b", "2026-10-15T10:00:00Z", 100), row("c", "2026-10-25T10:00:00Z", 100)] });
  assert.deepEqual(s.lines.map((l) => [l.margin_percent, l.net]), [[0, 100], [10, 110], [15, 115]]);
  assert.equal(s.margin_percent, null, "mixed margins: each line shows its own");
  assert.match(statementCsv(s, "F").split("\r\n")[0], /Margin \(GBP\)/);
});

test("CSV: one row per charge plus totals; quotes and spreadsheet formulas are neutralised", () => {
  const s = buildStatement({ month: "2026-10", billing: flat(10), ...names, site: () => "Depot, \"North\"", vehicleName: () => "=HYPERLINK(\"x\")", bookings: [row("a", "2026-10-03T10:00:00Z", 100)] });
  const csv = statementCsv(s, "Demo Haulage");
  const lines = csv.trim().split("\r\n");
  assert.match(lines[0], /^Fleet,Month,Charging ended,Plate/);
  assert.ok(lines[1].includes('"Depot, ""North"""'));
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`), "formula shown as text");
  assert.ok(lines[1].endsWith("cdr-a"));
  assert.match(lines.at(-1)!, /^Total incl\. VAT,.*132\.00$/);
});

test("API: admins set the margin; fleets see it on their statement and fleet record", async () => {
  const h = await harness("2026-10-28T10:00:00Z");
  assert.equal((await h.api<Fleet>("GET", `/api/fleets/${h.fleetId}`)).data.margin_percent, 0);
  const put = await h.api<{ margin_percent: number }>("PUT", "/api/admin/billing", { margin_percent: 12.5 });
  assert.equal(put.data.margin_percent, 12.5);
  assert.ok(h.store.data.audit.some((a) => a.action === "billing.update"));
  assert.equal((await h.api<Fleet>("GET", `/api/fleets/${h.fleetId}`)).data.margin_percent, 12.5);

  // Charged before the margin was set (keeps the old price), after it, and in September.
  h.store.data.bookings.push(row("b0", "2026-10-03T10:00:00Z", 100, { fleet_id: h.fleetId }), row("b1", "2026-10-28T12:00:00Z", 100, { fleet_id: h.fleetId }), row("b2", "2026-09-30T22:00:00Z", 80, { fleet_id: h.fleetId }));
  const s = await h.api<FleetStatement>("GET", `/api/fleets/${h.fleetId}/statements/2026-10`);
  assert.equal(s.status, 200, s.error?.message);
  assert.deepEqual(s.data.lines.map((l) => [l.booking_id, l.net]), [["b0", 100], ["b1", 112.5]], "30 Sep 23:00 BST belongs to September");
  assert.equal(s.data.totals.gross, 255);
  assert.equal((await h.api("PUT", "/api/admin/billing", { margin_percent: "lots" })).status, 400);
  assert.equal(s.data.fleet.name, "Demo Haulage");
  assert.ok(s.data.issuer.company_name);
  const current = await h.api<FleetStatement>("GET", `/api/fleets/${h.fleetId}/statements`);
  assert.equal(current.data.month, "2026-10");
  assert.equal((await h.api("GET", `/api/fleets/${h.fleetId}/statements/2026-13`)).status, 400);

  h.store.data.admins.length = 0;
  assert.equal((await h.api("PUT", "/api/admin/billing", { margin_percent: 50 })).status, 403);
});
