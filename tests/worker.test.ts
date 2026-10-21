// The Cloudflare Workers entry: dynamic paths reach the API, everything else is a static asset.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index";

test("worker: /api, /ocpi and /sim go to the handler, everything else to the static assets", async () => {
  const served: string[] = [];
  const env = { ASSETS: { fetch: async (r: Request) => { served.push(new URL(r.url).pathname); return new Response("asset"); } } };
  const ctx = { waitUntil: () => undefined };
  const call = (path: string) => worker.fetch(new Request(`https://depotcharge.example${path}`), env, ctx);

  // Without Supabase keys the API answers with the demo configuration, with security headers.
  const cfg = await call("/api/config");
  assert.equal(cfg.status, 200);
  assert.equal(((await cfg.json()) as { data: { mode: string } }).data.mode, "demo");
  assert.equal(cfg.headers.get("X-Frame-Options"), "DENY");
  assert.match(cfg.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/);
  // OCPI isn't available until the server is configured.
  assert.equal((await call("/ocpi/versions")).status, 503);

  assert.equal(await (await call("/")).text(), "asset");
  assert.equal(await (await call("/apiary.png")).text(), "asset", "only the /api/ prefix is dynamic");
  assert.deepEqual(served, ["/", "/apiary.png"]);
});
