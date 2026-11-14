// Public charging sites from open data: operators' OCPI feeds (2.1.1, 2.2.1, 2.3) and Open Charge
// Map, kept only if they could serve heavy vehicles, merged, and served at /api/public/sites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOpenSites, fromOcm, fromOcpiLocation, mergeSites, ocpiLocations, openSiteFit, payloadShape, type OpenSite } from "../shared/opendata/sites";
import { handlePublicMarket, OPEN_SITES_URL } from "../server/market";

const conn = (o: Record<string, unknown>) => ({ id: "1", format: "CABLE", power_type: "DC", max_voltage: 920, max_amperage: 400, last_updated: "2026-11-01T00:00:00Z", ...o });
const loc = (o: Record<string, unknown> = {}) => ({
  id: "LOC1", name: "Hub", address: "1 Road", city: "Coventry", postal_code: "CV1 1AA", country: "GBR",
  coordinates: { latitude: "52.40", longitude: "-1.50" }, operator: { name: "Example Charging" },
  evses: [{ uid: "E1", status: "AVAILABLE", connectors: [conn({ standard: "IEC_62196_T2_COMBO", max_electric_power: 350_000 })] }],
  last_updated: "2026-11-01T00:00:00Z", ...o,
});

test("OCPI 2.2.1: a 350 kW CCS hub is kept, with bay size to check", () => {
  const s = fromOcpiLocation(loc(), "feed")!;
  assert.equal(s.id, "feed:LOC1");
  assert.equal(s.max_kw, 350);
  assert.deepEqual(s.connectors, ["CCS2"]);
  assert.equal(s.hgv, "check");
  assert.match(s.hgv_why, /bay size not published/);
  assert.equal(s.postcode, "CV1 1AA");
});

test("OCPI 2.1.1: power from volts × amps; slow sites and sites outside GB are left out", () => {
  const old = fromOcpiLocation(loc({ evses: [{ uid: "E1", status: "AVAILABLE", connectors: [conn({ standard: "IEC_62196_T2_COMBO", max_voltage: 500, max_amperage: 350 })] }] }), "f")!;
  assert.equal(old.max_kw, 175);
  const slow = loc({ evses: [{ uid: "E1", status: "AVAILABLE", connectors: [conn({ standard: "IEC_62196_T2", power_type: "AC_3_PHASE", max_voltage: 230, max_amperage: 32 })] }] });
  assert.equal(fromOcpiLocation(slow, "f"), null);
  assert.equal(fromOcpiLocation(loc({ coordinates: { latitude: "48.85", longitude: "2.35" } }), "f"), null);
  assert.equal(fromOcpiLocation(loc({ publish: false }), "f"), null);
});

test("OCPI 2.3: truck bays mark the site as built for trucks, with their limits", () => {
  const s = fromOcpiLocation(loc({
    parking_places: [
      { id: "P1", vehicle_types: ["PERSONAL_VEHICLE"], restricted_to_type: false, reservation_required: false },
      { id: "P2", vehicle_types: ["SEMI_TRACTOR", "TRUCK_WITH_TRAILER"], max_vehicle_length: 1875, max_vehicle_height: 420, max_vehicle_weight: 44_000, drive_through: true, restricted_to_type: true, reservation_required: false },
    ],
  }), "f")!;
  assert.equal(s.hgv, "trucks");
  assert.equal(s.hgv_why, "Truck bays");
  assert.equal(s.drive_through, true);
  assert.equal(s.max_length_cm, 1875);
  assert.equal(s.max_height_cm, 420);
});

test("MCS, or a truck charging network, means built for trucks", () => {
  const mcs = fromOcpiLocation(loc({ evses: [{ uid: "E1", status: "AVAILABLE", connectors: [conn({ standard: "MCS", max_electric_power: 1_000_000 }), conn({ standard: "IEC_62196_T2_COMBO", max_electric_power: 400_000 })] }] }), "f")!;
  assert.deepEqual([mcs.hgv, mcs.hgv_why, mcs.connectors[0]], ["trucks", "MCS connector", "MCS"]);
  const net = fromOcpiLocation(loc({ operator: { name: "Milence" } }), "f")!;
  assert.equal(net.hgv_why, "Truck charging network");
});

test("feeds come as { data: [...] }, a bare array or one object", () => {
  assert.equal(ocpiLocations({ data: [1, 2] }).length, 2);
  assert.equal(ocpiLocations([1]).length, 1);
  assert.equal(ocpiLocations({ data: { id: "x" } }).length, 1);
  assert.equal(ocpiLocations("nope").length, 0);
  // Locations and tariffs in one payload (Osprey).
  assert.equal(ocpiLocations({ locations: [1, 2, 3], tariffs: [9] }).length, 3);
  assert.equal(ocpiLocations({ data: { locations: [1, 2], tariffs: [] } }).length, 2);
  assert.equal(payloadShape({ data: { items: [], total: 0 } }), "an object with keys: data (data has: items, total)");
});

const poi = (o: Record<string, unknown> = {}) => ({
  ID: 123, AddressInfo: { Title: "Services", AddressLine1: "M6 J3", Town: "Coventry", Postcode: "CV7", Latitude: 52.47, Longitude: -1.47 },
  OperatorInfo: { Title: "Example Charging" }, DataProvider: { Title: "Open Charge Map Contributors" }, StatusType: { IsOperational: true },
  Connections: [{ ConnectionType: { Title: "CCS (Type 2)" }, PowerKW: 300, Quantity: 6 }], NumberOfPoints: 6, ...o,
});

test("Open Charge Map: kept when high power; trucks when listed for them; closed sites left out", () => {
  const s = fromOcm(poi())!;
  assert.deepEqual([s.id, s.max_kw, s.connectors[0], s.hgv, s.evses], ["ocm:123", 300, "CCS2", "check", 6]);
  assert.equal(s.provider, undefined, "OCM's own contributors aren't repeated as a provider");
  const truck = fromOcm(poi({ GeneralComments: "Drive-through bays for HGVs and coaches" }))!;
  assert.equal(truck.hgv, "trucks");
  const mcs = fromOcm(poi({ Connections: [{ ConnectionType: { Title: "MCS (Megawatt Charging System)" }, PowerKW: 1000 }] }))!;
  assert.equal(mcs.hgv_why, "MCS connector");
  assert.equal(fromOcm(poi({ StatusType: { IsOperational: false } })), null);
  assert.equal(fromOcm(poi({ Connections: [{ ConnectionType: { Title: "Type 2" }, PowerKW: 22 }] })), null);
  assert.equal(fromOcm(poi({ DataProvider: { Title: "National Chargepoint Registry" } }))!.provider, "National Chargepoint Registry");
});

test("one record per site: the operator's own feed wins over an aggregator copy", () => {
  const own = fromOcpiLocation(loc(), "operator")!;
  const copy = fromOcm(poi({ AddressInfo: { Title: "Copy", Latitude: 52.4002, Longitude: -1.5002 } }))!;
  const other = fromOcm(poi({ ID: 9, AddressInfo: { Title: "Elsewhere", Latitude: 53.4, Longitude: -2.2 } }))!;
  const merged = mergeSites([[own], [copy, other]]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((x) => x.lat < 53)!.source, "operator");
  // A truck flag from either copy is kept.
  const flagged = mergeSites([[own], [{ ...copy, hgv: "trucks", hgv_why: "Listed for trucks" }]]);
  assert.equal(flagged[0].hgv, "trucks");
});

test("fit for a vehicle: published limits rule sites out; unknown bays are flagged for HGVs only", () => {
  const s: OpenSite = { ...fromOcpiLocation(loc(), "f")!, max_height_cm: 400 };
  const artic = { vehicle_type: "TRUCK_WITH_TRAILER", length_cm: 1650, height_cm: 410, gross_weight_kg: 40_000 };
  assert.deepEqual(openSiteFit(s, artic), { ok: false, note: "Too low" });
  const check = openSiteFit({ ...s, max_height_cm: undefined }, artic);
  assert.equal(check.ok, true);
  assert.match(check.note!, /Bay size not published/);
  assert.deepEqual(openSiteFit({ ...s, max_height_cm: undefined }, { vehicle_type: "VAN", length_cm: 600, height_cm: 270, gross_weight_kg: 4250 }), { ok: true, note: null });
});

test("a malformed file is cleaned rather than trusted", () => {
  const f = cleanOpenSites({ generated_at: "x", sources: [{ id: "a" }, null], sites: [{ id: "a:1", name: "OK", lat: 52, lon: -1, hgv: "check" }, { id: "bad", lat: "52" }, { id: "b", name: "x", lat: 52, lon: -1, hgv: "nope" }] })!;
  assert.equal(f.sites.length, 1);
  assert.equal(f.sources.length, 1);
  assert.equal(cleanOpenSites({ nope: true }), null);
});

test("GET /api/public/sites passes the daily snapshot through, cached; says so when it's missing", async () => {
  const calls: string[] = [];
  const body = JSON.stringify({ generated_at: "2026-11-05T04:41:00Z", sources: [], sites: [] });
  const ok = await handlePublicMarket(new Request("https://app.example/api/public/sites"), {
    mode: "live", now: () => new Date(), transport: async (r) => { calls.push(r.url); return new Response(body, { status: 200 }); },
  });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("Cache-Control") ?? "", /max-age=3600/);
  assert.equal(((await ok.json()) as { data: { generated_at: string } }).data.generated_at, "2026-11-05T04:41:00Z");
  assert.equal(calls[0], OPEN_SITES_URL);
  const custom = await handlePublicMarket(new Request("https://app.example/api/public/sites"), {
    mode: "live", now: () => new Date(), sitesUrl: "https://example.org/sites.json", transport: async (r) => { calls.push(r.url); return new Response("Not Found", { status: 404 }); },
  });
  assert.equal(calls[1], "https://example.org/sites.json");
  assert.equal(custom.status, 503);
});
