import { test } from "node:test";
import assert from "node:assert/strict";
import { planTrip, resolvePlace, departAt, haversineKm, alongLine, ROAD_FACTOR, AVG_KMH, BREAK_MIN } from "../src/publicmap/trip";
import { parseTripText } from "../shared/trip-text";
import { askTrip, cleanAsk, handleTripAsk } from "../server/tripask";
import { specOf } from "../src/publicmap/logic";
import type { OpenSite } from "../shared/opendata/sites";

const site = (o: Partial<OpenSite> & { id: string; lat: number; lon: number }): OpenSite =>
  ({ name: o.id, operator: "Op", max_kw: 350, connectors: ["CCS2"], evses: 4, hgv: "unknown", hgv_why: "", ...o }) as OpenSite;
const LEEDS = { name: "Leeds", lat: 53.8, lon: -1.55 };
const SOTON = { name: "Southampton", lat: 50.9, lon: -1.4 };

test("understands a trip typed in plain English", () => {
  assert.deepEqual(parseTripText("Leeds to Southampton, leaving 6am with 70%"), { from: "Leeds", to: "Southampton", depart: "06:00", battery_pct: 70 });
  assert.deepEqual(parseTripText("from Manchester to Bristol 40%"), { from: "Manchester", to: "Bristol", battery_pct: 40 });
  assert.deepEqual(parseTripText("Glasgow to London at 17:30"), { from: "Glasgow", to: "London", depart: "17:30" });
  assert.deepEqual(parseTripText("need to get from leeds down to southampton, setting off half 6 in the morning, battery about 70 percent"), { from: "leeds", to: "southampton", depart: "06:30", battery_pct: 70 });
  assert.deepEqual(parseTripText("I'm heading Felixstowe to Birmingham tomorrow"), { from: "Felixstowe", to: "Birmingham" });
  assert.equal(parseTripText("just some words"), null);
});

test("an AI answer is only used when it checks out", () => {
  assert.deepEqual(cleanAsk({ from: "Leeds", to: "Southampton", depart: "06:00", battery_pct: 70 }), { from: "Leeds", to: "Southampton", depart: "06:00", battery_pct: 70 });
  assert.deepEqual(cleanAsk({ from: "Leeds", to: "Hull", depart: "25:00", battery_pct: 140 }), { from: "Leeds", to: "Hull" }, "bad time and percentage dropped");
  assert.equal(cleanAsk({ from: "<script>", to: "Hull" }), null);
  assert.equal(cleanAsk({ from: "Leeds", to: "leeds" }), null);
});

test("asks the AI binding first, and falls back to the rules", async () => {
  const ai = { run: async () => ({ response: { from: "Leeds", to: "Southampton", depart: "06:00", battery_pct: 70 } }) };
  assert.deepEqual(await askTrip("leeds down to soton for 6, 70 percent", { AI: ai }), { ask: { from: "Leeds", to: "Southampton", depart: "06:00", battery_pct: 70 }, by: "ai" });
  const broken = { run: async () => { throw new Error("down"); } };
  assert.deepEqual(await askTrip("Leeds to Hull 50%", { AI: broken }), { ask: { from: "Leeds", to: "Hull", battery_pct: 50 }, by: "rules", ai: "error" });
  assert.deepEqual(await askTrip("Leeds to Hull 50%", {}), { ask: { from: "Leeds", to: "Hull", battery_pct: 50 }, by: "rules", ai: "unavailable" });
  // JSON mode refused: the plain-text retry still works.
  let calls = 0;
  const picky = { run: async (_m: string, input: Record<string, unknown>) => { calls++; if (input.response_format) throw new Error("JSON Mode couldn't be met"); return { response: 'Sure: {"from":"York","to":"Hull","depart":"","battery_pct":-1}' }; } };
  assert.deepEqual(await askTrip("york over to hull", { AI: picky }), { ask: { from: "York", to: "Hull" }, by: "ai" });
  assert.equal(calls, 2);
  // A retired model: on to the next one; and the OpenAI-style answer shape.
  const seen: string[] = [];
  const retiring = { run: async (m: string) => { seen.push(m); if (m.includes("glm")) throw new Error("5028: model was deprecated"); return { choices: [{ message: { content: '{"from":"Hull","to":"York"}' } }] }; } };
  assert.deepEqual(await askTrip("hull to york", { AI: retiring }), { ask: { from: "Hull", to: "York" }, by: "ai" });
  assert.deepEqual(seen, ["@cf/zai-org/glm-4.7-flash", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
  const res = await handleTripAsk(new Request("https://x/api/public/trip-ask", { method: "POST", body: JSON.stringify({ text: "nowhere really" }) }), {});
  assert.equal(res.status, 422);
});

test("places come from towns, then charging sites", () => {
  const sites = [site({ id: "a", name: "Moto Donington", city: "Castle Donington", lat: 52.8, lon: -1.3 })];
  assert.equal(resolvePlace("leeds", [LEEDS], sites)?.name, "Leeds");
  assert.equal(resolvePlace("Castle Donington", [LEEDS], sites)?.name, "Castle Donington");
  assert.equal(resolvePlace("Atlantis", [LEEDS], sites), null);
});

test("departure: today at that time, or tomorrow if it's already gone", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  assert.equal(departAt("14:00", now).getDate(), 25);
  assert.equal(departAt("06:00", now).getDate(), 26);
});

test("geometry: along and off the line", () => {
  assert.ok(Math.abs(haversineKm(LEEDS, SOTON) - 323) < 5);
  const mid = alongLine(LEEDS, SOTON, { lat: 52.35, lon: -1.475 });
  assert.ok(mid.t > 0.45 && mid.t < 0.55 && mid.offKm < 2);
});

test("plans a charging stop that doubles as the driver's break", () => {
  const mid = site({ id: "mid", lat: 52.35, lon: -1.47, max_kw: 400 });
  const offRoute = site({ id: "far", lat: 52.35, lon: -0.2 });
  const chademo = site({ id: "chademo", lat: 52.6, lon: -1.5, connectors: ["CHAdeMO"] });
  const p = planTrip({ from: LEEDS, to: SOTON, depart: new Date(2026, 10, 25, 6, 0), socPct: 75 }, [mid, offRoute, chademo], {}, "artic");
  assert.ok(p.ok, p.problem);
  assert.deepEqual(p.stops.map((s) => s.site.id), ["mid"]);
  const st = p.stops[0];
  assert.ok(st.minutes >= BREAK_MIN && st.isBreak, "at least a full 45-minute break");
  assert.ok(st.socLeave > st.socArrive && st.socLeave <= 0.8 + 1e-9);
  assert.ok(p.socArrive >= 0.15 - 1e-9, "arrives above the reserve");
  const km = haversineKm(LEEDS, SOTON) * ROAD_FACTOR;
  assert.ok(Math.abs(p.km - km) < 1 && Math.abs(p.driveMin - (km / AVG_KMH) * 60) < 15);
});

test("no charger in range: says so instead of inventing one", () => {
  const p = planTrip({ from: LEEDS, to: SOTON, depart: new Date(2026, 10, 25, 6, 0), socPct: 30 }, [], {}, "artic");
  assert.equal(p.ok, false);
  assert.match(p.problem!, /No charger this truck can use/);
});

test("a bigger battery needs no stop on a short trip", () => {
  const big = { ...specOf("rigid"), label: "X", plate: "X", battery_kwh: 600 };
  const p = planTrip({ from: LEEDS, to: { name: "Sheffield", lat: 53.38, lon: -1.47 }, depart: new Date(2026, 10, 25, 6, 0), socPct: 80 }, [], {}, big);
  assert.ok(p.ok && p.stops.length === 0);
});
