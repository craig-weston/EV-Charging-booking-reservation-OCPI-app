// Error tracking: unexpected errors are reported once, without personal data or link tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactPath, reportError, resetAlerts, scrub } from "../server/alerts";
import { guard } from "../server/live";
import { RateLimiter } from "../server/security";
import { harness } from "./helpers";

function sink(url = "https://hooks.example/alert") {
  const posts: { url: string; body: { text: string; content: string; event: Record<string, unknown> } }[] = [];
  const pending: Promise<unknown>[] = [];
  return {
    posts,
    flush: () => Promise.all(pending),
    s: {
      env: { ALERT_WEBHOOK_URL: url, BRAND_NAME: "Fleet Charge", PUBLIC_BASE_URL: "https://book.example.com" },
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      fetch: async (r: Request) => { posts.push({ url: r.url, body: await r.json() }); return new Response(null, { status: 200 }); },
    },
  };
}

test("redaction: link tokens, emails and long secrets never reach an alert", () => {
  assert.equal(redactPath("/api/pass/abcDEF123_secret"), "/api/pass/…");
  assert.equal(redactPath("/api/invites/tok123/accept"), "/api/invites/…/accept");
  assert.equal(redactPath("/#/pass/tok?x=1"), "/#/pass/…");
  assert.equal(redactPath("/api/fleets/123/bookings?from=2026"), "/api/fleets/123/bookings");
  assert.equal(scrub("duplicate key for jo@example.co.uk\nstack line"), "duplicate key for [email]");
  assert.equal(scrub("token fck_abcdefghijklmnopqrstuvwxyz0123456789 rejected"), "token … rejected");
});

test("reportError: one alert per error per 10 minutes, nothing without a webhook", async () => {
  resetAlerts();
  const a = sink();
  const t0 = 5_000_000;
  const err = new Error("relation \"bookings\" does not exist");
  assert.equal(reportError(a.s, { where: "api", ref: "abc12345", error: err, method: "GET", path: "/api/fleets/0b9d6a1e-1111-2222-3333-444455556666/bookings" }, t0).alerted, true);
  // Same error, different id in the path and a later time inside the window: deduplicated.
  assert.equal(reportError(a.s, { where: "api", ref: "def67890", error: err, method: "GET", path: "/api/fleets/9f9d6a1e-1111-2222-3333-444455556666/bookings" }, t0 + 60_000).alerted, false);
  assert.equal(reportError(a.s, { where: "api", ref: "fff00000", error: err, method: "GET", path: "/api/fleets/x/bookings" }, t0 + 11 * 60_000).alerted, true);
  await a.flush();
  assert.equal(a.posts.length, 2);
  assert.equal(a.posts[0].url, "https://hooks.example/alert");
  assert.match(a.posts[0].body.text, /^⚠️ Fleet Charge \(book\.example\.com\): Error in api on GET \/api\/fleets\/.+\/bookings: relation "bookings" does not exist\. Reference abc12345/);
  assert.equal(a.posts[0].body.content, a.posts[0].body.text, "Discord field too");
  assert.equal(a.posts[0].body.event.ref, "abc12345");

  const none = sink("");
  assert.equal(reportError({ ...none.s, env: {} }, { where: "api", ref: "x", error: new Error("boom") }).alerted, false);
});

test("API 500s and browser reports reach the webhook; browser reports are rate limited", async () => {
  resetAlerts();
  const h = await harness();
  const posts: { text: string }[] = [];
  h.ctx.env.ALERT_WEBHOOK_URL = "https://hooks.example/alert";
  const inner = h.ctx.transport.bind(h.ctx);
  h.ctx.transport = async (req) => {
    if (req.url.startsWith("https://hooks.example/")) { posts.push(await req.json()); return new Response("ok"); }
    return inner(req);
  };
  // A store failure surfaces as a 500 with a reference, and one alert with the same reference.
  h.store.listVehicles = async () => { throw new Error("connection reset by peer"); };
  const r = await h.api("GET", `/api/fleets/${h.fleetId}/vehicles`);
  assert.equal(r.status, 500);
  const ref = r.error!.message.match(/reference ([0-9a-f]{8})/)![1];
  await h.ctx.flush();
  assert.equal(posts.length, 1);
  assert.ok(posts[0].text.includes(`Reference ${ref}`));
  assert.match(posts[0].text, /in api on GET \/api\/fleets\/.+\/vehicles: connection reset by peer/);

  const c = await h.api<{ ref: string }>("POST", "/api/client-errors", { name: "TypeError", message: "x is undefined", page: "/#/pass/SECRET-TOKEN-123", source: "https://x/assets/app-1.js:1:2" });
  assert.equal(c.status, 202);
  await h.ctx.flush();
  assert.equal(posts.length, 2);
  assert.match(posts[1].text, /TypeError in browser on \/#\/pass\/…: x is undefined/);
  assert.ok(!posts[1].text.includes("SECRET-TOKEN"));

  const rl = new RateLimiter();
  const req = () => new Request("https://x.test/api/client-errors", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.50" } });
  for (let i = 0; i < 10; i++) assert.equal(await guard(req(), rl, 1_000), null);
  assert.equal((await guard(req(), rl, 1_000))?.status, 429);
  const big = new Request("https://x.test/api/client-errors", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.51", "Content-Length": "9000" } });
  assert.equal((await guard(big, new RateLimiter(), 1_000))?.status, 413);
});
