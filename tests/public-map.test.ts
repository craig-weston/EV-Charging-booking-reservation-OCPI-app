// The public charging map's rules: filters, order, search and how truck access reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OpenSite } from "../shared/opendata/sites";
import { NO_FILTERS, access, canPlug, matchCounts, minutesTo80, specOf, type Spec, bayLimits, breakCharge, chargeFor, arrivalTimes, addMinutes, checklist, inBounds, isFiltered, keep, operatorCounts, order, search, siteFromHash, tier, tooSmall } from "../src/publicmap/logic";

const site = (o: Partial<OpenSite>): OpenSite => ({ id: "mfg:1", name: "Site", operator: "MFG EV Power", lat: 52, lon: -1, max_kw: 150, connectors: ["CCS2"], evses: 4, hgv: "check", hgv_why: "", source: "mfg", ...o });
const truck = site({ id: "x:t", name: "Markham Moor", hgv: "trucks", hgv_why: "Truck bays", max_kw: 175 });
const ultra = site({ id: "x:u", name: "Donington", max_kw: 400, connectors: ["CCS2"], operator: "GRIDSERVE", city: "Castle Donington", postcode: "DE74 2TN" });
const mcs = site({ id: "x:m", name: "Megawatt Park", max_kw: 1000, connectors: ["MCS", "CCS2"], operator: "Milence" });
const plain = site({ id: "x:p", name: "Leeds Ring Road", city: "Leeds" });

test("filters keep what they say", () => {
  assert.ok([truck, ultra, mcs, plain].every((s) => keep(s, NO_FILTERS)));
  assert.deepEqual([truck, ultra, mcs, plain].filter((s) => keep(s, { ...NO_FILTERS, minKw: 350 })).map((s) => s.id), ["x:u", "x:m"]);
  assert.deepEqual([truck, ultra, mcs, plain].filter((s) => keep(s, { ...NO_FILTERS, mcs: true })).map((s) => s.id), ["x:m"]);
  assert.deepEqual([truck, ultra, mcs, plain].filter((s) => keep(s, { ...NO_FILTERS, trucks: true })).map((s) => s.id), ["x:t"]);
  assert.deepEqual([truck, ultra, mcs, plain].filter((s) => keep(s, { ...NO_FILTERS, operator: "GRIDSERVE" })).map((s) => s.id), ["x:u"]);
  // Fleets saying an artic fits counts as suiting trucks.
  const said = { artic: { fits: 2, no_room: 0 }, latest: "2026-11-14T00:00:00Z" };
  assert.ok(keep(plain, { ...NO_FILTERS, trucks: true }, said));
  assert.equal(tier(plain, said), "truck");
  assert.equal(tier(ultra), "ultra");
  assert.equal(tier(plain), "rapid");
  assert.equal(isFiltered(NO_FILTERS), false);
  assert.equal(isFiltered({ ...NO_FILTERS, mcs: true }), true);
});

test("the list puts truck sites first, then the most powerful", () => {
  const sorted = [plain, ultra, mcs, truck].sort((a, b) => order(a, b, {}));
  assert.deepEqual(sorted.map((s) => s.id), ["x:t", "x:m", "x:u", "x:p"]);
  assert.deepEqual(operatorCounts([truck, ultra, plain]), [{ name: "MFG EV Power", count: 2 }, { name: "GRIDSERVE", count: 1 }]);
  assert.ok(inBounds(plain, [-2, 51, 0, 53]));
  assert.ok(!inBounds(plain, [0, 51, 1, 53]));
});

test("search finds towns, then sites by name, town and postcode", () => {
  const places = [{ name: "Leeds", lat: 53.8, lon: -1.58 }, { name: "Leicester", lat: 52.6, lon: -1.13 }];
  const r = search("lee", [truck, ultra, plain], places);
  assert.equal(r[0].kind, "place");
  assert.ok(r.some((x) => x.kind === "site" && x.site.id === "x:p"));
  assert.equal(search("de74", [ultra, plain], []).map((x) => x.kind === "site" && x.site.id)[0], "x:u");
  assert.deepEqual(search("l", [plain], places), [], "too short");
});

test("truck access reads plainly; links carry the site", () => {
  assert.equal(access(truck).title, "Built for trucks");
  assert.equal(access(plain).title, "Bay size not published");
  assert.equal(access(plain, { artic: { fits: 0, no_room: 3 }, latest: "x" }).tone, "bad");
  assert.equal(bayLimits(site({ max_length_cm: 1875, max_height_cm: 450, max_weight_kg: 44000 })), "18.8 m long · 4.5 m high · 44 t");
  assert.equal(bayLimits(plain), null);
  assert.equal(siteFromHash("#site=mfg%3A123"), "mfg:123");
  assert.equal(siteFromHash("#other"), null);
});

test("HGV checks: bay limits against the truck, the checklist, and what a break adds", () => {
  const short = site({ id: "x:s", hgv: "trucks", hgv_why: "Truck bays", max_length_cm: 1200, max_height_cm: 420 });
  assert.deepEqual(tooSmall(short, "artic"), ["length"]);
  assert.deepEqual(tooSmall(short, "rigid"), []);
  assert.equal(access(short, null, "artic").title, "Too small for an artic");
  assert.equal(access(short, null, "rigid").title, "Built for trucks");
  assert.equal(tier(short, null, "artic"), "rapid", "an artic doesn't fit, so not drawn as a truck site");
  const c = checklist(mcs, null, "artic");
  assert.deepEqual(c.map((x) => [x.key, x.state]), [["charge", "ok"], ["bay", "unknown"], ["hours", "unknown"], ["drive", "unknown"], ["mcs", "ok"], ["fleets", "unknown"]]);
  assert.equal(checklist(site({ open247: true }), null, "artic")[2].state, "ok");
  assert.equal(checklist(site({ open247: false, hours: "Daily 06:00–22:00" }), null, "artic")[2].text, "Opening hours: Daily 06:00–22:00");
  assert.ok(!keep(plain, { ...NO_FILTERS, open247: true }));
  assert.ok(keep(site({ open247: true }), { ...NO_FILTERS, open247: true }));
  // 45 minutes at the lower of the site's and the truck's rate, 85% for the slowdown as it fills.
  assert.deepEqual(breakCharge(ultra, "artic"), { kwh: 239, miles: 119 });
  assert.deepEqual(breakCharge(plain, "rigid"), { kwh: 96, miles: 66 });
});

test("the trial booking: arrival times, what a charge adds, end times", () => {
  const evening = new Date(2026, 10, 14, 16, 50);
  assert.equal(arrivalTimes(evening, false)[0], "17:30", "the next half hour, at least 15 minutes away");
  assert.equal(arrivalTimes(evening, true).length, 48);
  assert.deepEqual(chargeFor(ultra, "artic", 45), breakCharge(ultra, "artic"));
  assert.equal(addMinutes("23:30", 45), "00:15");
});

test("one particular truck: its own size, weight, plug and battery decide the sites", () => {
  const tall: Spec = { ...specOf("rigid"), label: "PN74 EVH", plate: "PN74 EVH", height_cm: 430, weight_kg: 32000, battery_kwh: 600, maxKw: 400 };
  const low = site({ id: "x:l", hgv: "trucks", max_height_cm: 420, max_weight_kg: 40000 });
  assert.deepEqual(tooSmall(low, "rigid"), [], "a typical rigid fits");
  assert.deepEqual(tooSmall(low, tall), ["height"], "this one is too tall");
  assert.equal(access(low, null, tall).title, "Too small for PN74 EVH");
  const chademo = site({ id: "x:c", connectors: ["CHAdeMO"] });
  assert.ok(!canPlug(chademo, "artic") && !keep(chademo, NO_FILTERS), "no truck plug, not shown");
  const mcsOnly = site({ id: "x:o", connectors: ["MCS"], max_kw: 1000 });
  assert.ok(!canPlug(mcsOnly, "artic"));
  assert.ok(canPlug(mcsOnly, { ...tall, mcs: true, maxKw: 750 }));
  // 20–80% of 600 kWh = 360 kWh at 85% of min(400 site, 400 truck) = 340 kW → 64 min.
  assert.equal(minutesTo80(ultra, tall), 64);
  assert.equal(minutesTo80(chademo, tall), null);
  assert.equal(order(plain, ultra, {}, tall) > 0, true, "the faster site for this truck comes first");
});

test("match counts for one truck: chargeable, fast for a break, confirmed to fit, too small", () => {
  const big: Spec = { ...specOf("artic"), label: "X", plate: "X", height_cm: 430 };
  const low = site({ id: "x:l", hgv: "trucks", max_height_cm: 420 });
  const chademo = site({ id: "x:c", connectors: ["CHAdeMO"] });
  assert.deepEqual(matchCounts([truck, ultra, plain, low, chademo], {}, big), { plug: 3, fast: 1, fits: 1, tooSmall: 1 });
});
