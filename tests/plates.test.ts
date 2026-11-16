// Number-plate lookup: DVLA's record → truck details; the public endpoint; its limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDvla, isUkPlate, plateKind, plateSummary, typicalSize } from "../shared/plates";
import { lookupPlate, handlePlate, PlateError } from "../server/plates";
import { handlePublicMarket } from "../server/market";
import { guard } from "../server/live";
import { RateLimiter } from "../server/security";

const artic = { registrationNumber: "PN74EVH", make: "VOLVO", fuelType: "ELECTRICITY", revenueWeight: 44000, wheelPlan: "3 AXLE & ARTIC", typeApproval: "N3", yearOfManufacture: 2024, colour: "WHITE" };

test("plates: what counts as one; DVLA's record becomes truck details", () => {
  assert.ok(isUkPlate("pn74 evh") && isUkPlate("A1") && isUkPlate("LS25CLD"));
  assert.ok(!isUkPlate("") && !isUkPlate("ABCDEFG") && !isUkPlate("1234567") && !isUkPlate("PN74 EVH X"));
  const d = fromDvla(artic)!;
  assert.deepEqual({ plate: d.plate, make: d.make, electric: d.electric, kind: d.kind, type: d.vehicle_type, kg: d.gross_weight_kg, heavy: d.heavy, colour: d.colour },
    { plate: "PN74 EVH", make: "Volvo", electric: true, kind: "artic", type: "TRUCK_WITH_TRAILER", kg: 44000, heavy: true, colour: "White" });
  assert.deepEqual(d.typical, { length_cm: 1650, height_cm: 400, width_cm: 255 });
  assert.equal(plateSummary(d), "Volvo · 44 t · 2024");
  assert.equal(plateKind("2 AXLE RIGID BODY", "N3", 18000), "rigid");
  assert.equal(plateKind("2 AXLE RIGID BODY", "N1", 3500), "van");
  assert.equal(plateKind("2 AXLE RIGID BODY", "M1", 1640), "other");
  assert.equal(plateKind(null, "M3", 19000), "bus");
  assert.equal(plateKind("NON STANDARD", null, 26000), "rigid", "by weight when DVLA has no category");
  assert.equal(typicalSize("rigid", 7500).length_cm, 750);
  assert.equal(typicalSize("rigid", 26000).length_cm, 1100);
  const car = fromDvla({ registrationNumber: "AB12CDE", make: "ROVER", fuelType: "PETROL", revenueWeight: 1640, wheelPlan: "2 AXLE RIGID BODY", typeApproval: "M1" })!;
  assert.equal(car.heavy, false);
  assert.equal(fromDvla({ errors: [] }), null);
});

test("lookup: asks DVLA with the key, keeps answers a day, says why when it can't", async () => {
  const calls: { url: string; key: string | null; body: unknown }[] = [];
  let answer: () => Response = () => Response.json(artic);
  const deps = { now: () => new Date("2026-11-16T10:00:00Z"), env: { DVLA_API_KEY: " dvla-key\n" }, transport: async (r: Request) => { calls.push({ url: r.url, key: r.headers.get("x-api-key"), body: JSON.parse(await r.text()) }); return answer(); } };
  const d = await lookupPlate(deps, "pn74 evh");
  assert.equal(d.plate, "PN74 EVH");
  assert.deepEqual(calls[0], { url: "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles", key: "dvla-key", body: { registrationNumber: "PN74EVH" } });
  await lookupPlate(deps, "PN74EVH");
  assert.equal(calls.length, 1, "the second ask is answered from memory");
  await assert.rejects(lookupPlate(deps, "not a plate!"), (e: PlateError) => e.status === 400);
  assert.equal(calls.length, 1, "bad plates never reach DVLA");
  answer = () => Response.json({ errors: [{ status: "404", title: "Vehicle Not Found" }] }, { status: 404 });
  await assert.rejects(lookupPlate(deps, "ZZ99ZZZ"), (e: PlateError) => e.status === 404);
  await assert.rejects(lookupPlate(deps, "ZZ99 ZZZ"), (e: PlateError) => e.status === 404);
  assert.equal(calls.length, 2, "not-found is remembered too");
  answer = () => new Response("{}", { status: 403 });
  await assert.rejects(lookupPlate(deps, "AA11AAA"), (e: PlateError) => e.status === 503);
  await assert.rejects(lookupPlate({ ...deps, env: {} }, "BB22BBB"), (e: PlateError) => e.status === 503 && /isn't set up/.test(e.message));
});

test("the public endpoint: POST only, never cached, and limited per visitor", async () => {
  const deps = { mode: "live" as const, now: () => new Date("2026-11-16T10:00:00Z"), env: { DVLA_API_KEY: "k" }, transport: async () => Response.json({ ...artic, registrationNumber: "LS25CLD" }) };
  const post = (plate: unknown) => new Request("https://x.test/api/public/plate", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ plate }) });
  const ok = await handlePublicMarket(post("LS25 CLD"), deps);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  assert.equal(((await ok.json()) as { data: { plate: string } }).data.plate, "LS25 CLD");
  assert.equal((await handlePlate(new Request("https://x.test/api/public/plate"), deps)).status, 405);
  assert.equal((await handlePublicMarket(post(42), deps)).status, 400);
  const rl = new RateLimiter();
  let blocked = 0;
  for (let i = 0; i < 15; i++) if (await guard(post("LS25 CLD"), rl, 1_000)) blocked++;
  assert.equal(blocked, 3, "12 a minute per visitor");
});
