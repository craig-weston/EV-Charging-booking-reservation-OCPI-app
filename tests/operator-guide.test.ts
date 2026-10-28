// Operator guide: the readiness checklist and the read-only OCPI check before connecting.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Readiness } from "../shared/model";
import type { ProbeReport } from "../server/ocpi/probe";
import { checkOperatorUrl } from "../server/api/router";
import { simPrepareRegistration } from "../server/sim/cpo";
import { harness } from "./helpers";

test("readiness: lists what an operator will check, flags the gaps", async () => {
  const h = await harness();
  const r = await h.api<Readiness>("GET", "/api/admin/readiness");
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.checks.map((c) => [c.id, c.level]));
  assert.equal(by.party, "ok", "country code and party id are set in the harness");
  assert.equal(by.name, "ok");
  assert.ok(["todo", "warn", "ok"].includes(by.url));
  assert.ok(r.data.versions_url.endsWith("/ocpi/versions"));
  assert.equal(r.data.simulator, true);
  assert.equal(r.data.simulator_connected, false);
  await h.api("POST", "/api/admin/simulator/connect");
  assert.equal((await h.api<Readiness>("GET", "/api/admin/readiness")).data.simulator_connected, true);
});

test("readiness and probe are for platform admins only", async () => {
  const h = await harness();
  h.store.data.admins.length = 0;
  assert.equal((await h.api("GET", "/api/admin/readiness")).status, 403);
  assert.equal((await h.api("POST", "/api/admin/probe", { versions_url: "https://x.example/versions", token: "t" })).status, 403);
});

test("probe: checks an operator's OCPI interface without registering", async () => {
  const h = await harness();
  const { versionsUrl, tokenA } = await simPrepareRegistration(h.ctx);
  const r = await h.api<ProbeReport>("POST", "/api/admin/probe", { versions_url: versionsUrl, token: tokenA });
  assert.equal(r.status, 200, r.error?.message);
  assert.equal(r.data.version, "2.3.0");
  assert.ok(r.data.findings.some((f) => f.level === "pass" && f.text === "OCPI 2.3.0 offered"));
  assert.ok(r.data.findings.some((f) => f.level === "pass" && f.text.startsWith("bookings SENDER")));
  assert.equal(r.data.ok, true);
  const partners = await h.api<unknown[]>("GET", "/api/admin/partners");
  assert.equal(partners.data.length, 0, "nothing was registered");
  assert.ok(h.store.data.audit.some((a) => a.action === "partner.probe"));
});

test("probe: a wrong token is reported, not thrown", async () => {
  const h = await harness();
  const { versionsUrl } = await simPrepareRegistration(h.ctx);
  const r = await h.api<ProbeReport>("POST", "/api/admin/probe", { versions_url: versionsUrl, token: "wrong-token" });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  assert.ok(r.data.findings.some((f) => f.level === "fail"));
});

test("operator addresses must be public https", async () => {
  const ctx = { baseUrl: "https://depotcharge.example" };
  assert.equal(checkOperatorUrl("https://ocpi.operator.example/versions", ctx).hostname, "ocpi.operator.example");
  assert.ok(checkOperatorUrl("https://depotcharge.example/sim/cpo/versions", ctx), "own address allowed (simulator)");
  for (const bad of ["not a url", "http://ocpi.operator.example/versions", "https://localhost/versions", "https://10.1.2.3/v", "https://192.168.0.5/v", "https://172.20.0.1/v", "https://169.254.169.254/latest", "https://[::1]/v", "https://intranet/v", "https://db.internal/v"]) {
    assert.throws(() => checkOperatorUrl(bad, ctx), /address|https/, bad);
  }
  const h = await harness();
  const r = await h.api("POST", "/api/admin/probe", { versions_url: "http://10.0.0.1/versions", token: "x" });
  assert.equal(r.status, 400);
  const c = await h.api("POST", "/api/admin/partners", { action: "connect", versions_url: "https://127.0.0.1/versions", token: "x" });
  assert.equal(c.status, 400);
});
