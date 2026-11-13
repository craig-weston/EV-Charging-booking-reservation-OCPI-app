// Fleets report whether an artic or a rigid fits at a public site; everyone sees the totals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers";
import { handlePublicMarket } from "../server/market";
import { fleetSiteReports, reportSite, siteTallies } from "../server/sitereports";
import { reportedFit, tallyText, truckClass, isSiteId, type SiteTally } from "../shared/opendata/reports";

test("trucks are artics or rigids; site ids are checked", () => {
  assert.equal(truckClass({ vehicle_type: "SEMI_TRACTOR" }), "artic");
  assert.equal(truckClass({ vehicle_type: "TRUCK_WITH_TRAILER", length_cm: 1650 }), "artic");
  assert.equal(truckClass({ vehicle_type: "RIGID", length_cm: 1000 }), "rigid");
  assert.equal(truckClass({ vehicle_type: "RIGID", length_cm: 1350 }), "artic", "as long as an artic");
  assert.ok(isSiteId("mfg:GB-MFG-123") && isSiteId("ocm:98765"));
  assert.ok(!isSiteId("no-colon") && !isSiteId("a:b c") && !isSiteId("a:" + "x".repeat(200)) && !isSiteId(7));
});

test("one report per fleet per site per truck: changing it replaces it, withdrawing removes it", async () => {
  const h = await harness("2026-11-13T09:00:00Z");
  const put = (b: unknown) => h.api<{ tally: SiteTally | null; mine: Record<string, string> }>("PUT", `/api/fleets/${h.fleetId}/site-reports`, b);
  let r = await put({ site: "mfg:1", truck: "artic", verdict: "fits" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.tally?.artic, { fits: 1, no_room: 0 });
  assert.deepEqual(r.data.mine, { artic: "fits" });
  r = await put({ site: "mfg:1", truck: "artic", verdict: "no_room" });
  assert.deepEqual(r.data.tally?.artic, { fits: 0, no_room: 1 }, "replaced, not added");
  await put({ site: "mfg:1", truck: "rigid", verdict: "fits" });
  // Two more fleets, straight into the store.
  await reportSite(h.ctx, "fleet-b", { site: "mfg:1", truck: "artic", verdict: "fits" });
  await reportSite(h.ctx, "fleet-c", { site: "ocm:9/x", truck: "artic", verdict: "fits" }).then(() => assert.fail("bad id accepted"), () => undefined);
  await reportSite(h.ctx, "fleet-c", { site: "ocm:9", truck: "artic", verdict: "fits" });
  const t = await siteTallies(h.store);
  assert.deepEqual(t["mfg:1"].artic, { fits: 1, no_room: 1 });
  assert.deepEqual(t["mfg:1"].rigid, { fits: 1, no_room: 0 });
  assert.equal(reportedFit(t["mfg:1"], "artic"), "mixed");
  assert.equal(reportedFit(t["ocm:9"], "artic"), "fits");
  assert.equal(reportedFit(t["ocm:9"], "rigid"), null);
  assert.equal(tallyText(t["ocm:9"], "artic"), "1 fleet says an artic fits");
  assert.match(tallyText(t["mfg:1"], "artic")!, /Reports differ/);
  // The fleet's own, and everyone's (public, no account; no fleet ids in it).
  assert.deepEqual((await h.api("GET", `/api/fleets/${h.fleetId}/site-reports`)).data, { "mfg:1": { artic: "no_room", rigid: "fits" } });
  const pub = await handlePublicMarket(new Request("https://x.test/api/public/site-reports"), { mode: "live", now: () => new Date(), transport: async () => new Response(""), store: h.store });
  const body = await pub.text();
  assert.equal(pub.status, 200);
  assert.ok(!body.includes(h.fleetId) && !body.includes("fleet-b"));
  assert.deepEqual((JSON.parse(body) as { data: Record<string, SiteTally> }).data["ocm:9"].artic, { fits: 1, no_room: 0 });
  // Withdraw.
  r = await put({ site: "mfg:1", truck: "artic", verdict: null });
  assert.deepEqual(r.data.tally?.artic, { fits: 1, no_room: 0 });
  assert.deepEqual(await fleetSiteReports(h.store, h.fleetId), { "mfg:1": { rigid: "fits" } });
  // Bad input.
  assert.equal((await put({ site: "mfg:1", truck: "van", verdict: "fits" })).status, 400);
  assert.equal((await put({ site: "mfg:1", truck: "artic", verdict: "maybe" })).status, 400);
  assert.equal((await put({ truck: "artic", verdict: "fits" })).status, 400);
});
