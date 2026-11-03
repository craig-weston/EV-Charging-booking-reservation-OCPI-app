// Electricity prices from suppliers (Octopus, wholesale-linked, fixed, price feeds), gap filling,
// the public market-data endpoints, and the demo reaching them through the app's own origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fillPrices, parseElexonMid, parseFeed, parseOctopusRates } from "../shared/energy/suppliers";
import { cleanEnergy } from "../shared/energy/depot";
import { handlePublicMarket, octopusRates, octopusRegion, wholesaleRates, type MarketDeps } from "../server/market";
import { depotPrices } from "../server/depot";
import { carbonFor } from "../server/energy";

const now = new Date("2026-11-03T10:00:00Z");

test("Octopus unit rates: pence → £, long time-of-use periods split into half-hours", () => {
  const s = parseOctopusRates({ results: [
    { value_exc_vat: 21.5, valid_from: "2026-11-03T10:30:00Z", valid_to: "2026-11-03T11:00:00Z" },
    { value_exc_vat: 8, valid_from: "2026-11-03T00:30:00Z", valid_to: "2026-11-03T02:30:00Z" },
  ] });
  assert.equal(s.points.length, 5);
  assert.equal(s.points[0].price, 0.215);
  assert.ok(s.points.slice(1).every((p) => p.price === 0.08));
});

test("Elexon market index: £/MWh → £/kWh, empty periods skipped", () => {
  const s = parseElexonMid({ data: [
    { startTime: "2026-11-02T03:00:00Z", price: 182.57, volume: 2274, dataProvider: "APXMIDP" },
    { startTime: "2026-11-02T03:30:00Z", price: 0, volume: 0, dataProvider: "APXMIDP" },
    { startTime: "2026-11-02T04:00:00Z", price: 99, volume: 10, dataProvider: "N2EXMIDP" },
  ] });
  assert.deepEqual(s.points, [{ from: "2026-11-02T03:00:00.000Z", price: 0.18257 }]);
});

test("price feeds: plain arrays, {data}, pence detected, Octopus-style accepted", () => {
  assert.equal(parseFeed([{ start: "2026-11-03T00:00:00Z", price: 0.12 }]).points[0].price, 0.12);
  assert.equal(parseFeed({ data: [{ from: "2026-11-03T00:00:00Z", price: 12.5 }] }).points[0].price, 0.125);
  assert.equal(parseFeed({ results: [{ value_exc_vat: 30, valid_from: "2026-11-03T00:00:00Z", valid_to: "2026-11-03T00:30:00Z" }] }).points[0].price, 0.3);
});

test("gaps use the same half-hour a day earlier, and say from when", () => {
  const today = Date.parse("2026-11-03T00:00:00Z");
  const points = [];
  for (let i = 0; i < 46; i++) points.push({ from: new Date(today + i * 1_800_000).toISOString(), price: (100 + i) / 1000 }); // up to 23:00
  const f = fillPrices({ points, source: "octopus" }, today, today + 30 * 3_600_000, () => 9);
  assert.equal(f.priceAt(today + 3_600_000), 0.102);
  assert.equal(f.estimatedFrom, today + 23 * 3_600_000);
  assert.equal(f.priceAt(today + 25 * 3_600_000), 0.102); // tomorrow 01:00 ← today 01:00
  assert.equal(f.allFallback, false);
  const none = fillPrices(null, today, today + 3_600_000, () => 9);
  assert.equal(none.allFallback, true);
  assert.equal(none.priceAt(today), 9);
});

test("old tariff settings migrate: agile → Octopus, flat/tou → fixed; bad codes replaced", () => {
  const c = cleanEnergy({ depots: [
    { tariff: { kind: "agile", agile_product: "AGILE-24-10-01", agile_region: "C", standard: 0.2 } },
    { tariff: { kind: "tou", standard: 0.2, rates: [{ price: 0.1, start: "00:30", end: "07:30" }] } },
    { tariff: { kind: "octopus", octopus_product: "bad code!", octopus_region: "Z" } },
    { tariff: { kind: "wholesale", uplift: 0.15 } },
  ] });
  assert.deepEqual([c.depots[0].tariff.kind, c.depots[0].tariff.octopus_product, c.depots[0].tariff.octopus_region], ["octopus", "AGILE-24-10-01", "C"]);
  assert.equal(c.depots[1].tariff.kind, "fixed");
  assert.equal(c.depots[1].tariff.rates.length, 1);
  assert.equal(c.depots[2].tariff.octopus_product, "AGILE-BUS-25-02-05");
  assert.equal(c.depots[2].tariff.octopus_region, "auto");
  assert.equal(c.depots[3].tariff.uplift, 0.15);
});

function fakeLive(routes: Record<string, unknown>, calls: string[] = []): MarketDeps {
  return {
    mode: "live", now: () => now,
    transport: async (r: Request) => {
      calls.push(r.url);
      const hit = Object.entries(routes).find(([k]) => r.url.includes(k));
      return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response("nope", { status: 404 });
    },
  };
}

test("live: Octopus region from the postcode, then that region's rates", async () => {
  const calls: string[] = [];
  const d = fakeLive({
    "grid-supply-points": { results: [{ group_id: "_B" }] },
    "E-1R-AGILE-BUS-25-02-05-B": { results: [{ value_exc_vat: 18, valid_from: "2026-11-03T10:00:00Z", valid_to: "2026-11-03T10:30:00Z" }] },
  }, calls);
  assert.equal(await octopusRegion(d, "NN4 7AB"), "B");
  const s = await octopusRates(d, "AGILE-BUS-25-02-05", "B", now.getTime(), now.getTime() + 3_600_000);
  assert.equal(s?.points[0].price, 0.18);
  assert.ok(calls.some((u) => u.includes("api.octopus.energy/v1/products/AGILE-BUS-25-02-05/electricity-tariffs/E-1R-AGILE-BUS-25-02-05-B/standard-unit-rates/")));
});

test("live: wholesale-linked adds the fleet's fixed costs; labels say where prices came from", async () => {
  const d = fakeLive({ "market-index": { data: [{ startTime: "2026-11-03T10:00:00Z", price: 100, volume: 5, dataProvider: "APXMIDP" }] } });
  const s = await wholesaleRates({ ...d, now: () => new Date("2026-11-03T10:01:00Z") }, now.getTime(), now.getTime() + 1_800_000);
  assert.equal(s?.points[0].price, 0.1);
  const depot = cleanEnergy({ depots: [{ id: "d", postcode: "NN4 7AB", tariff: { kind: "wholesale", uplift: 0.12, standard: 0.3 } }] }).depots[0];
  const p = await depotPrices({ ...d, now: () => new Date("2026-11-03T10:02:00Z") } as never, depot, now.getTime(), now.getTime() + 1_800_000, null);
  assert.equal(p.priceAt(now.getTime() + 60_000), 0.22);
  assert.match(p.info.label, /Elexon/);
  assert.equal(p.info.modelled, false);
});

test("no live prices: modelled stand-in, clearly labelled", async () => {
  const depot = cleanEnergy({ depots: [{ id: "d", postcode: "NN4 7AB", tariff: { kind: "octopus", octopus_product: "AGILE-BUS-25-02-05", standard: 0.24 } }] }).depots[0];
  const p = await depotPrices({ mode: "demo", now: () => now, transport: async () => new Response("", { status: 500 }) } as never, depot, now.getTime(), now.getTime() + 3_600_000, null);
  assert.equal(p.info.modelled, true);
  assert.match(p.info.label, /modelled/);
});

test("public endpoints: validated, and the demo reaches them through its own origin", async () => {
  const live = fakeLive({ "E-1R-AGILE-24-10-01-C": { results: [{ value_exc_vat: 25, valid_from: "2026-11-03T10:00:00Z", valid_to: "2026-11-03T10:30:00Z" }] } });
  const bad = await handlePublicMarket(new Request("https://app.example/api/public/prices?source=octopus&product=x!&region=C"), live);
  assert.equal(bad.status, 400);
  const ok = await handlePublicMarket(new Request("https://app.example/api/public/prices?source=octopus&product=AGILE-24-10-01&region=C&from=2026-11-03T10:00:00Z&to=2026-11-03T11:00:00Z"), live);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("Cache-Control") ?? "", /max-age/);
  // The in-browser demo: its market calls go to the deployment's /api/public/…
  const calls: string[] = [];
  const demo: MarketDeps = { mode: "demo", now: () => now, marketUrl: "https://depotcharge.example", transport: async (r) => { calls.push(r.url); return handlePublicMarket(new Request(r.url), live); } };
  const s = await octopusRates(demo, "AGILE-24-10-01", "C", now.getTime(), now.getTime() + 3_600_000);
  assert.equal(s?.points[0].price, 0.25);
  assert.ok(calls[0].startsWith("https://depotcharge.example/api/public/prices?source=octopus"));
  // Carbon too, with NESO's data.
  const nesoLive = fakeLive({ "regional/intensity": { data: { regionid: 9, shortname: "East Midlands", data: [{ from: "2026-11-03T10:00Z", to: "2026-11-03T10:30Z", intensity: { forecast: 77 } }] } } });
  const demo2 = { mode: "demo" as const, now: () => now, marketUrl: "https://depotcharge.example", transport: async (r: Request) => handlePublicMarket(new Request(r.url), nesoLive) };
  const c = await carbonFor(demo2, "NN4 7AB", "2026-11-03T10:00:00Z", "2026-11-03T11:00:00Z");
  assert.equal(c.region, "East Midlands");
  assert.equal(c.points[0].intensity, 77);
  // Offline demo: modelled.
  const off = await carbonFor({ mode: "demo", now: () => now, transport: async () => new Response("", { status: 500 }) }, "NN4 7AB", "2026-11-03T10:00:00Z", "2026-11-03T11:00:00Z");
  assert.equal(off.source, "modelled");
});

test("settings saved before suppliers existed still plan with their own rates", async () => {
  const { harness } = await import("./helpers");
  const h = await harness("2026-10-29T15:00:00Z");
  // Written straight to the store, as an older version saved it.
  await h.store.saveEnergy({ fleet_id: h.fleetId, config: { depots: [{ id: "yard", name: "Yard", postcode: "NN4 7AB", import_limit_kw: 400, site_load_kw: 50, goal: "cost", tariff: { kind: "tou", standard: 0.24, rates: [{ price: 0.13, start: "00:30", end: "07:30" }] }, chargers: [{ id: "b1", name: "Bay 1", max_kw: 150 }] }] } as never, secrets: {}, state: { dispatch: {} }, updated_at: "2026-10-29T15:00:00Z" });
  const e = await h.api<{ config: { depots: { tariff: { kind: string } }[] } }>("GET", `/api/fleets/${h.fleetId}/energy`);
  assert.equal(e.data.config.depots[0].tariff.kind, "fixed");
  const plan = await h.api<{ price: { source: string; label: string; modelled: boolean } }>("GET", `/api/fleets/${h.fleetId}/depots/yard/plan`);
  assert.equal(plan.status, 200);
  assert.equal(plan.data.price.source, "fixed");
  assert.equal(plan.data.price.modelled, false);
  assert.ok(plan.data.price.label.length > 0);
});
