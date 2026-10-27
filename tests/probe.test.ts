// The read-only operator check, run against the built-in CPO simulator (a full OCPI 2.3.0 CPO).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Partner } from "../shared/model";
import { formatReport, probeOperator } from "../server/ocpi/probe";
import { dispatch } from "../server/dispatch";
import { harness } from "./helpers";

test("probe: a connected simulator passes, with bookable sites for sample trucks", async () => {
  const h = await harness();
  const c = await h.api<{ partner: Partner }>("POST", "/api/admin/simulator/connect");
  assert.equal(c.status, 201);
  const partner = (await h.store.listPartners()).find((p) => p.is_simulator)!;
  const methods: string[] = [];
  const report = await probeOperator({
    versionsUrl: partner.versions_url!, token: partner.their_token!, from: { country_code: "GB", party_id: "DPC" },
    fetch: (req) => { methods.push(req.method); return dispatch(req, h.ctx); },
  });
  const text = formatReport(report);
  assert.equal(report.ok, true, text);
  assert.equal(report.version, "2.3.0");
  assert.equal(report.counts.locations, 12);
  assert.equal(report.counts.booking_locations, 18);
  assert.ok(Object.values(report.bookable).some((n) => n > 0), text);
  assert.ok(methods.every((m) => m === "GET"), "read-only");
  assert.ok(!text.includes(partner.their_token!), "never prints the token");
  assert.match(text, /OK: \d+ passed/);
});

test("probe: refused token, missing 2.3.0 and unreachable hosts are reported, not thrown", async () => {
  const h = await harness();
  await h.api("POST", "/api/admin/simulator/connect");
  const partner = (await h.store.listPartners()).find((p) => p.is_simulator)!;
  const bad = await probeOperator({ versionsUrl: partner.versions_url!, token: "wrong-token", fetch: (r) => dispatch(r, h.ctx) });
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((f) => f.level === "fail" && /refused/.test(f.text)));

  const old = await probeOperator({
    versionsUrl: "https://cpo.example/versions", token: "t",
    fetch: async () => Response.json({ data: [{ version: "2.2.1", url: "https://cpo.example/2.2.1" }], status_code: 1000, timestamp: "2026-10-27T10:00:00Z" }),
  });
  assert.equal(old.ok, false);
  assert.ok(old.findings.some((f) => /2\.3\.0 isn't offered/.test(f.text)));

  const down = await probeOperator({ versionsUrl: "https://nowhere.example/versions", token: "t", fetch: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  assert.equal(down.ok, false);
  assert.match(formatReport(down), /Couldn't reach .*ENOTFOUND/);
});
