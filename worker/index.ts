// Cloudflare Workers entry (wrangler.jsonc). The same file is bundled as Pages "advanced mode"
// _worker.js for dashboard uploads (npm run build:upload).
//   /api/*, /ocpi/*, /sim/*  → the shared web-standard handler (server/live.ts)
//   everything else         → the static app (dist/, served by the ASSETS binding)
// With Workers, static requests never reach this code (assets.run_worker_first lists only the
// dynamic paths), so public/_headers applies to them; on Pages, _routes.json does the same.
import { handle, isConfigured, liveCtx } from "../server/live";
import { runDepotDispatch } from "../server/depot";
import { runFlexHousekeeping } from "../server/flex";
import type { Env } from "../server/context";

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface WorkerEnv extends Env {
  ASSETS: AssetsBinding;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const DYNAMIC = /^\/(api|ocpi|sim)(\/|$)/;

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (DYNAMIC.test(new URL(request.url).pathname)) {
      return handle({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
  /** Cron (wrangler.jsonc → triggers): every 15 minutes, re-plan depots set to dispatch automatically. */
  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    if (!isConfigured(env)) return;
    const base = (env.PUBLIC_BASE_URL || "https://depotcharge.invalid").replace(/\/+$/, "");
    const c = liveCtx({ request: new Request(`${base}/api/cron`), env, waitUntil: (p) => ctx.waitUntil(p) });
    ctx.waitUntil(runFlexHousekeeping(c).then((n) => { if (n) console.log(`flex: ${n} events closed`); }).then(() => runDepotDispatch(c)).then((n) => { if (n) console.log(`depot dispatch: ${n} depots`); }));
  },
};
