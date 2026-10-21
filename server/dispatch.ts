import type { AuthUser, Ctx, Env } from "./context";
import { partyFromEnv } from "./context";
import type { Store } from "./store/types";
import { handleApi } from "./api/router";
import { handleOcpi } from "./ocpi/emsp-router";
import { handleSim } from "./sim/cpo";

/** Routes a request to the OCPI interface, the app API or the CPO simulator. */
export async function dispatch(req: Request, ctx: Ctx): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/ocpi/")) return handleOcpi(req, ctx);
  if (path.startsWith("/api/")) return handleApi(req, ctx);
  if (path.startsWith("/sim/")) return handleSim(req, ctx);
  return new Response("Not found", { status: 404 });
}

export interface LocalCtx extends Ctx {
  /** Resolves when all background work (waitUntil) has settled — used by tests and the demo. */
  flush(): Promise<void>;
}

/** A context whose "network" is in-process: used by the browser demo and the test-suite. */
export function createLocalCtx(opts: {
  store: Store;
  baseUrl?: string;
  env?: Env;
  simDelayMs?: number;
  now?: () => Date;
  user?: AuthUser | null;
  mode?: "demo" | "live";
}): LocalCtx {
  const pending = new Set<Promise<unknown>>();
  const env: Env = { ENABLE_CPO_SIMULATOR: "true", ...(opts.env ?? {}) };
  const baseUrl = (opts.baseUrl ?? "https://demo.depotcharge.local").replace(/\/+$/, "");
  const ctx: LocalCtx = {
    mode: opts.mode ?? "demo",
    env,
    store: opts.store,
    baseUrl,
    party: partyFromEnv(env),
    simulatorEnabled: env.ENABLE_CPO_SIMULATOR === "true",
    simDelayMs: opts.simDelayMs ?? 0,
    now: opts.now ?? (() => new Date()),
    cache: new Map(),
    waitUntil(p) {
      const tracked = p.catch((e) => console.error("background task failed", e)).finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    async transport(req) {
      const url = new URL(req.url);
      if (url.origin === new URL(baseUrl).origin) return dispatch(req, ctx);
      return fetch(req);
    },
    async verifyUser() {
      // The demo/test user counts as fully signed in (two-step verified); tests pass their own.
      return opts.user === undefined ? { id: "demo-user", email: "planner@example.com", aal: "aal2", mfa: false } : opts.user;
    },
    async flush() {
      for (let i = 0; i < 20 && pending.size; i++) await Promise.allSettled([...pending]);
    },
  };
  return ctx;
}
