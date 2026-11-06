// Real lorry routes for the trip planner: OpenRouteService's HGV profile behind a cached public
// endpoint, and the planner finding stops along the route instead of the straight line.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkSnapshot, Vehicle } from "../shared/model";
import { CITIES } from "../src/map/ukmap";
import { alongLine, planTrip } from "../src/app/trip";
import { routeQuery } from "../src/app/route";
import { cleanSize, parseOrs, simplify, truckRoute, RouteUnavailable, type TruckRoute } from "../server/routing";
import { handlePublicMarket, type MarketDeps } from "../server/market";
import { harness } from "./helpers";

const city = (n: string) => CITIES.find((c) => c.name === n)!;
// London to Glasgow the way lorries go: up the M1 and M6, not the straight line over the Pennines.
const M6: [number, number][] = [[51.5019, -0.1187], [52.06, -0.75], [52.40, -1.25], [52.48, -1.9], [53.0, -2.2], [53.45, -2.55], [54.0, -2.75], [54.88, -2.93], [55.40, -3.40], [55.8764, -4.2527]];

/** An OpenRouteService GeoJSON answer for `line`. */
const orsAnswer = (line: [number, number][], km: number, minutes: number) => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { summary: { distance: km * 1000, duration: minutes * 60 } }, geometry: { type: "LineString", coordinates: line.map(([lat, lon]) => [lon, lat]) } }],
});

test("truck sizes are rounded and checked, so the same truck on the same run is one cached route", () => {
  assert.deepEqual(cleanSize(new URLSearchParams("h=4.03&w=2.549&l=16.4&t=43.6&hz=1")), { kind: "hgv", height: 4, width: 2.55, length: 16.5, weight: 44, hazmat: true });
  assert.deepEqual(cleanSize(new URLSearchParams("h=9&t=200&kind=bus")), { kind: "bus", height: 5.5, weight: 60 });
  assert.deepEqual(cleanSize(new URLSearchParams("kind=van&h=2.5")), { kind: "van" }, "vans use car roads");
  // From a vehicle record.
  const q = new URLSearchParams(routeQuery("Leeds", "Hull", { vehicle_type: "TRUCK_WITH_TRAILER", height_cm: 400, width_cm: 255, length_cm: 1650, gross_weight_kg: 44000, dangerous_goods: false }));
  assert.equal(q.get("h"), "4.0");
  assert.equal(q.get("t"), "44");
  assert.equal(q.get("hz"), null);
});

test("route lines are simplified but keep their shape and ends", () => {
  const dense: [number, number][] = [];
  for (let i = 0; i <= 2000; i++) dense.push([51.5 + i * 0.002, -0.1 - Math.sin(i / 300) * 0.5]);
  const s = simplify(dense, 0.15);
  assert.ok(s.length < 200 && s.length > 10, String(s.length));
  assert.deepEqual(s[0], dense[0]);
  assert.deepEqual(s.at(-1), dense.at(-1));
  const along = alongLine(s);
  for (const p of dense.filter((_, i) => i % 97 === 0)) assert.ok(along({ lat: p[0], lon: p[1] }).offsetKm < 0.3);
});

test("OpenRouteService: the truck's size goes into the request; answers are cached; failures say why", async () => {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  let answer: () => Response = () => Response.json(orsAnswer(M6, 665.4, 523));
  const deps: MarketDeps = {
    mode: "live", now: () => new Date("2026-11-06T01:00:00Z"), env: { ORS_API_KEY: "ors-key" },
    transport: async (req) => { calls.push({ url: req.url, auth: req.headers.get("Authorization"), body: JSON.parse(await req.text()) }); return answer(); },
  };
  const q = new URLSearchParams("from=London&to=Glasgow&kind=hgv&h=4.9&l=16.5&t=44&hz=1");
  const r = await truckRoute(deps, q);
  assert.equal(r.km, 665.4);
  assert.equal(r.minutes, 523);
  assert.deepEqual(r.line[0], [51.5019, -0.1187]);
  assert.match(r.attribution, /openrouteservice/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openrouteservice.org/v2/directions/driving-hgv/geojson");
  assert.equal(calls[0].auth, "ors-key");
  assert.deepEqual(calls[0].body.coordinates, [[-0.1187, 51.5019], [-4.2527, 55.8764]], "longitude first");
  assert.deepEqual(calls[0].body.options, { vehicle_type: "hgv", profile_params: { restrictions: { height: 4.9, length: 16.5, weight: 44, hazmat: true } } });
  await truckRoute(deps, q);
  assert.equal(calls.length, 1, "the second ask is answered from the cache");

  // A van uses the car profile, without lorry options.
  await truckRoute(deps, new URLSearchParams("from=Leeds&to=York&kind=van"));
  assert.match(calls.at(-1)!.url, /driving-car/);
  assert.equal(calls.at(-1)!.body.options, undefined);

  // No route the truck can use, a bad key, no key, and places the planner doesn't know.
  answer = () => Response.json({ error: { code: 2009, message: "Route could not be found" } }, { status: 404 });
  await assert.rejects(truckRoute(deps, new URLSearchParams("from=Leeds&to=Hull&h=5.4")), (e: RouteUnavailable) => e.status === 404 && /No road route/.test(e.message));
  answer = () => new Response("{}", { status: 403 });
  await assert.rejects(truckRoute(deps, new URLSearchParams("from=Leeds&to=Hull&h=5.3")), /key wasn't accepted/);
  await assert.rejects(truckRoute({ ...deps, env: {} }, new URLSearchParams("from=Hull&to=Leeds")), (e: RouteUnavailable) => e.status === 503);
  await assert.rejects(truckRoute(deps, new URLSearchParams("from=Atlantis&to=Leeds")), (e: RouteUnavailable) => e.status === 400);
});

test("the public endpoint: cached for a week, errors as JSON; the demo asks the deployment it runs on", async () => {
  const deps: MarketDeps = { mode: "live", now: () => new Date(), env: { ORS_API_KEY: "k" }, transport: async () => Response.json(orsAnswer([[53.832, -1.582], [53.9704, -1.08]], 41, 38)) };
  const ok = await handlePublicMarket(new Request("https://x.test/api/public/route?from=Leeds&to=York&t=18"), deps);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("Cache-Control")!, /max-age=604800/);
  assert.equal(((await ok.json()) as { data: TruckRoute }).data.km, 41);
  const bad = await handlePublicMarket(new Request("https://x.test/api/public/route?from=Leeds&to=Leeds"), deps);
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("Cache-Control"), "no-store");

  // The in-browser demo has no key: it asks the deployment's own endpoint.
  const asked: string[] = [];
  const demo: MarketDeps = { mode: "demo", now: () => new Date(), marketUrl: "https://depot.example", transport: async (req) => { asked.push(req.url); return Response.json({ data: { source: "openrouteservice", from: "Leeds", to: "Hull", km: 97, minutes: 80, line: [[53.832, -1.582], [53.75, -0.33]], size: { kind: "hgv" }, attribution: "x" } }); } };
  const r = await truckRoute(demo, new URLSearchParams("from=Leeds&to=Hull&h=4.2"));
  assert.equal(r.km, 97);
  assert.match(asked[0], /^https:\/\/depot\.example\/api\/public\/route\?from=Leeds&to=Hull&kind=hgv&h=4\.2/);
});

test("the planner follows the lorry route: its distance and time, and stops near the road it takes", async () => {
  const h = await harness("2026-10-28T06:00:00Z");
  await h.api("POST", "/api/admin/simulator/connect");
  const net = (await h.api<NetworkSnapshot>("GET", "/api/network")).data;
  const tractor = (await h.api<Vehicle[]>("GET", `/api/fleets/${h.fleetId}/vehicles`)).data.find((v) => v.vehicle_type === "TRUCK_WITH_TRAILER" || v.vehicle_type === "SEMI_TRACTOR")!;
  const now = new Date("2026-10-28T06:00:00Z");
  const base = { net, vehicle: tractor, from: city("London"), to: city("Glasgow"), depart: new Date("2026-10-29T05:00:00Z"), now, startSoc: 0.9 };
  const estimate = planTrip(base);
  assert.equal(estimate.assumptions.route, "estimate");
  const route = { km: 665.4, minutes: 523, line: M6 };
  const plan = planTrip({ ...base, route });
  assert.equal(plan.ok, true, plan.problem ?? "");
  assert.equal(plan.assumptions.route, "lorry");
  assert.equal(plan.totalKm, 665.4);
  assert.equal(plan.assumptions.speedKmh, 76, "from the route's own driving time");
  const along = alongLine(M6);
  for (const s of plan.stops) {
    const p = along({ lat: Number(s.location.coordinates.latitude), lon: Number(s.location.coordinates.longitude) });
    assert.ok(p.offsetKm <= 20, `${s.name} is ${p.offsetKm.toFixed(1)} km off the route`);
  }
  // The planner's own speed still wins when it gives one.
  assert.equal(planTrip({ ...base, route, speedKmh: 65 }).assumptions.speedKmh, 65);
});
