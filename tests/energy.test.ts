// Time-of-use prices, grid carbon, cheapest/greenest slots and the smart-timing report.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingRow } from "../shared/model";
import type { Tariff } from "../shared/ocpi/types";
import { averageEnergyPrice, energyPriceAt, hasTimeOfUse, standardEnergyPrice, timedRates } from "../shared/energy/price";
import { HALF_HOUR, averageIntensity, carbonBand, completeSeries, intensityAt, modelledIntensity, modelledSeries, outcode, parseNeso, type CarbonSeries } from "../shared/energy/carbon";
import { smartPicks } from "../shared/energy/timing";
import { timingReport } from "../shared/energy/report";
import { summarizeTariffs, estimateCost } from "../shared/booking/tariffs";
import { carbonFor } from "../server/energy";
import { harness } from "./helpers";

const tariff = (elements: Tariff["elements"]): Tariff => ({ country_code: "GB", party_id: "VHL", id: "T", currency: "GBP", tax_included: "NO", elements, last_updated: "2026-01-01T00:00:00Z" }) as Tariff;
const night = tariff([
  { price_components: [{ type: "ENERGY", price: 0.45, step_size: 1 }], restrictions: { start_time: "22:00", end_time: "06:00" } },
  { price_components: [{ type: "ENERGY", price: 0.59, step_size: 1 }] },
]);
const peak = tariff([
  { price_components: [{ type: "ENERGY", price: 0.76, step_size: 1 }], restrictions: { start_time: "16:00", end_time: "19:00", day_of_week: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] } },
  { price_components: [{ type: "ENERGY", price: 0.64, step_size: 1 }] },
]);

test("night rate applies across midnight in UK local time", () => {
  // 29 Oct 2026 is GMT (clocks went back on 25 Oct), so UTC = local.
  assert.equal(energyPriceAt([night], new Date("2026-10-29T23:30:00Z")), 0.45);
  assert.equal(energyPriceAt([night], new Date("2026-10-30T05:59:00Z")), 0.45);
  assert.equal(energyPriceAt([night], new Date("2026-10-30T06:00:00Z")), 0.59);
  assert.equal(energyPriceAt([night], new Date("2026-10-30T12:00:00Z")), 0.59);
  // In summer, 21:30 UTC is 22:30 BST: night rate.
  assert.equal(energyPriceAt([night], new Date("2026-07-01T21:30:00Z")), 0.45);
});

test("weekday peak only on weekdays", () => {
  assert.equal(energyPriceAt([peak], new Date("2026-10-29T17:00:00Z")), 0.76); // Thursday
  assert.equal(energyPriceAt([peak], new Date("2026-10-31T17:00:00Z")), 0.64); // Saturday
});

test("average over a charge that crosses into the night rate", () => {
  // 21:00–23:00: half at 0.59, half at 0.45.
  const avg = averageEnergyPrice([night], new Date("2026-10-29T21:00:00Z"), new Date("2026-10-29T23:00:00Z"))!;
  assert.equal(Math.round(avg * 100) / 100, 0.52);
});

test("summary keeps the all-day rate and lists time-of-use rates", () => {
  assert.equal(standardEnergyPrice([night]), 0.59);
  assert.deepEqual(timedRates([night]), [{ price: 0.45, start_time: "22:00", end_time: "06:00", days: null }]);
  assert.ok(hasTimeOfUse([night]));
  assert.ok(!hasTimeOfUse([tariff([{ price_components: [{ type: "ENERGY", price: 0.5, step_size: 1 }] }])]));
  const s = summarizeTariffs([night])!;
  assert.equal(s.energyPerKwh, 0.59);
  assert.equal(s.timedRates.length, 1);
  assert.equal(estimateCost(s, 60, 100, null, 0.45).energy, Math.round(85 * 0.45 * 100) / 100);
});

test("postcode district for NESO", () => {
  assert.equal(outcode("NN4 7PB"), "NN4");
  assert.equal(outcode("ec1a1bb"), "EC1A");
  assert.equal(outcode("LE17"), "LE17");
  assert.equal(outcode(""), null);
});

test("modelled carbon: deterministic, lower overnight than the evening peak on average", () => {
  const a = modelledIntensity(new Date("2026-10-29T03:00:00Z"), "NN4");
  assert.equal(a, modelledIntensity(new Date("2026-10-29T03:00:00Z"), "NN4"));
  let night = 0, evening = 0;
  for (let d = 0; d < 30; d++) {
    night += modelledIntensity(new Date(Date.UTC(2026, 9, 1 + d, 3)), "NN4");
    evening += modelledIntensity(new Date(Date.UTC(2026, 9, 1 + d, 17, 30)), "NN4");
  }
  assert.ok(night < evening * 0.75, `${night} vs ${evening}`);
  assert.equal(carbonBand(50).label, "Very low");
  assert.equal(carbonBand(300).level, 4);
});

test("NESO responses parse and gaps are filled with modelled values", () => {
  const json = { data: [{ regionid: 9, shortname: "East Midlands", data: [
    { from: "2026-10-29T10:00Z", to: "2026-10-29T10:30Z", intensity: { forecast: 120, index: "moderate" } },
    { from: "2026-10-29T10:30Z", to: "2026-10-29T11:00Z", intensity: { forecast: 100, index: "low" } },
  ] }] };
  const p = parseNeso(json);
  assert.equal(p.region, "East Midlands");
  assert.equal(p.points.length, 2);
  const s = completeSeries(new Date("2026-10-29T10:00:00Z"), new Date("2026-10-29T12:00:00Z"), p, "NN4");
  assert.equal(s.source, "mixed");
  assert.equal(s.points.length, 4);
  assert.equal(intensityAt(s, new Date("2026-10-29T10:45:00Z")), 100);
  assert.equal(averageIntensity(s, new Date("2026-10-29T10:00:00Z"), new Date("2026-10-29T11:00:00Z")), 110);
});

test("cheapest and greenest picks beat the asked-for slot by a real margin", () => {
  const from = new Date("2026-10-29T18:00:00Z");
  const series: CarbonSeries = { region: null, source: "neso", points: [] };
  for (let i = 0; i < 24; i++) {
    const t = from.getTime() + i * HALF_HOUR;
    // Dirty at 18:00, cleanest at 02:00.
    const h = new Date(t).getUTCHours();
    series.points.push({ from: new Date(t).toISOString(), intensity: h >= 1 && h < 4 ? 60 : h >= 22 ? 110 : 200 });
  }
  const cands = [];
  for (let i = 0; i < 20; i++) cands.push({ start: new Date(from.getTime() + i * HALF_HOUR), end: new Date(from.getTime() + i * HALF_HOUR + 60 * 60_000) });
  const p = smartPicks(cands, from, 200, [night], series);
  assert.equal(p.cheapest?.start.toISOString(), "2026-10-29T22:00:00.000Z"); // first slot fully on the night rate
  assert.equal(p.cheapest?.saves, Math.round(200 * (0.59 - 0.45) * 100) / 100);
  assert.equal(p.greenest?.start.toISOString(), "2026-10-30T01:00:00.000Z");
  assert.ok(p.greenest!.lowerPct > 0.6);
  // Nothing to gain: no picks.
  const flat = smartPicks(cands, from, 200, [tariff([{ price_components: [{ type: "ENERGY", price: 0.5, step_size: 1 }] }])], modelledSeries(from, new Date(from.getTime() + 864e5), "X"));
  assert.equal(flat.cheapest, null);
});

test("smart-timing report compares charge times with the day average", () => {
  const day = new Date("2026-10-20T00:00:00Z"); // BST: local midnight is 23:00Z the day before, fine for a flat test
  const series: CarbonSeries = { region: null, source: "neso", points: [] };
  for (let i = -4; i < 52; i++) {
    const t = day.getTime() + i * HALF_HOUR;
    const h = new Date(t).getUTCHours();
    series.points.push({ from: new Date(t).toISOString(), intensity: h < 6 ? 80 : 160 });
  }
  const b = { id: "b", cdr: { id: "c", total_energy: 300, total_time: 1, total_cost: 150, currency: "GBP", start_date_time: "2026-10-20T02:00:00Z", end_date_time: "2026-10-20T03:00:00Z" } } as unknown as BookingRow;
  const r = timingReport([b], () => series, () => [night])!;
  assert.equal(r.charges, 1);
  assert.equal(r.intensity, 80);
  assert.ok(r.dayIntensity > 80);
  assert.ok(r.kgByTiming > 0);
  assert.equal(r.kgOpportunity, 0); // already in the cleanest hours
  assert.equal(r.touSaved, Math.round(300 * (0.59 - 0.45) * 100) / 100);
  assert.equal(Math.round(r.byHour.reduce((a, v) => a + v, 0) * 1000) / 1000, 1);
});

test("live mode asks NESO by postcode district and falls back to modelled when it fails", async () => {
  const calls: string[] = [];
  const ok = { mode: "live", now: () => new Date("2026-10-29T10:00:00Z"), transport: async (r: Request) => {
    calls.push(r.url);
    return new Response(JSON.stringify({ data: { regionid: 9, shortname: "East Midlands", postcode: "NN4", data: [{ from: "2026-10-29T10:00Z", to: "2026-10-29T10:30Z", intensity: { forecast: 99 } }] } }), { status: 200 });
  } } as never;
  const s = await carbonFor(ok, "NN4 7PB", "2026-10-29T10:00:00Z", "2026-10-29T11:00:00Z");
  assert.match(calls[0], /\/regional\/intensity\/2026-10-29T10:00Z\/2026-10-29T11:00Z\/postcode\/NN4$/);
  assert.equal(s.region, "East Midlands");
  assert.equal(s.points[0].intensity, 99);
  assert.equal(s.source, "mixed");
  const bad = { mode: "live", now: () => new Date("2026-10-29T10:00:00Z"), transport: async () => new Response("nope", { status: 503 }) } as never;
  const m = await carbonFor(bad, "LE17 4XN", "2026-10-29T10:00:00Z", "2026-10-29T11:00:00Z");
  assert.equal(m.source, "modelled");
  assert.equal(m.points.length, 2);
});

test("the carbon endpoint answers in demo mode with a modelled series", async () => {
  const h = await harness();
  const r = await h.api<CarbonSeries>("GET", "/api/energy/carbon?postcode=NN4%207PB&from=2026-10-21T07:00:00Z&to=2026-10-21T19:00:00Z");
  assert.equal(r.status, 200);
  assert.equal(r.data.source, "modelled");
  assert.equal(r.data.points.length, 24);
});

test("simulated VoltHaul charges overnight are billed at the night rate", async () => {
  const { buildTariffs, SITES } = await import("../server/sim/seed");
  const t = buildTariffs(SITES.find((s) => s.id === "VHL-DAV")!);
  assert.equal(energyPriceAt([t[0]], new Date("2026-10-29T23:00:00Z")), 0.45);
  assert.equal(energyPriceAt([t[0]], new Date("2026-10-29T12:00:00Z")), 0.59);
});
