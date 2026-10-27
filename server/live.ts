// Production context for Cloudflare Pages Functions.
import { brandFromEnv, legalFromEnv, partyFromEnv, PASSWORD_MIN_LENGTH, TERMS_VERSION, type AuthUser, type Ctx, type Env } from "./context";
import { dispatch } from "./dispatch";
import { BODY_LIMITS, BodyTooLarge, LIMITS, RateLimiter, clientIp, jwtClaims, overShared, sharedLimits, withSecurityHeaders, type SharedLimits } from "./security";
import { SupabaseStore } from "./store/supabase";

export interface PagesContext {
  request: Request;
  env: Env;
  waitUntil(p: Promise<unknown>): void;
}

const userCache = new Map<string, { user: AuthUser; exp: number }>();

/**
 * Validates the Supabase access token with Supabase Auth (so revoked or expired sessions fail),
 * then reads the assurance level from its claims and whether the account has a verified factor.
 */
async function verifySupabaseUser(req: Request, env: Env): Promise<AuthUser | null> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m || !env.SUPABASE_URL) return null;
  const token = m[1].trim();
  const now = Date.now();
  const hit = userCache.get(token);
  if (hit && hit.exp > now) return hit.user;
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = (await res.json()) as { id?: string; email?: string; factors?: { status?: string }[] };
  if (!u.id) return null;
  const claims = jwtClaims(token);
  const user: AuthUser = {
    id: u.id,
    email: u.email ?? null,
    aal: claims.aal === "aal2" ? "aal2" : "aal1",
    mfa: (u.factors ?? []).some((f) => f.status === "verified"),
  };
  if (userCache.size > 500) userCache.clear();
  // Cache for a minute at most, and never beyond the token's own expiry.
  userCache.set(token, { user, exp: Math.min(now + 60_000, (claims.exp ?? 0) * 1000 || now + 60_000) });
  return user;
}

export function isConfigured(env: Env) {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_ANON_KEY);
}

export function liveCtx(pc: PagesContext): Ctx {
  const env = pc.env;
  const reqOrigin = new URL(pc.request.url).origin;
  const baseUrl = (env.PUBLIC_BASE_URL || reqOrigin).replace(/\/+$/, "");
  const local = new Set([reqOrigin, new URL(baseUrl).origin]);
  const ctx: Ctx = {
    mode: "live",
    env,
    store: new SupabaseStore(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_PREVIOUS),
    baseUrl,
    party: partyFromEnv(env),
    simulatorEnabled: env.ENABLE_CPO_SIMULATOR === "true",
    simDelayMs: 1500,
    now: () => new Date(),
    cache: new Map(),
    waitUntil: (p) => pc.waitUntil(p),
    // Calls to our own origin (e.g. eMSP ⇄ simulator) are dispatched in-process: no extra hop,
    // and no Worker-calls-itself restrictions.
    transport: (req) => (local.has(new URL(req.url).origin) ? dispatch(req, ctx) : fetch(req)),
    verifyUser: (req) => verifySupabaseUser(req, env),
  };
  return ctx;
}

/** Response used while SUPABASE_* variables are missing: the web app then runs its built-in demo. */
export function unconfigured(pc: PagesContext): Response {
  const path = new URL(pc.request.url).pathname;
  if (path === "/api/config") {
    const party = partyFromEnv(pc.env);
    return Response.json({
      data: {
        mode: "demo", supabase_url: null, supabase_anon_key: null, simulator: true, party,
        brand: brandFromEnv(pc.env), ocpi_versions_url: `${new URL(pc.request.url).origin}/ocpi/versions`,
        legal: legalFromEnv(pc.env), certifications: [], terms_version: TERMS_VERSION,
        security: { require_admin_mfa: false, password_min_length: PASSWORD_MIN_LENGTH },
      },
    });
  }
  return Response.json(
    { error: { message: "Server not configured: set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY", code: "NOT_CONFIGURED" } },
    { status: 503 },
  );
}

const limiter = new RateLimiter();

const tooMany = (retryAfter: number, ocpi: boolean) =>
  ocpi
    ? Response.json({ status_code: 2000, status_message: "Too many requests", timestamp: new Date().toISOString() }, { status: 429, headers: { "Retry-After": String(retryAfter) } })
    : Response.json({ error: { message: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" } }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

/**
 * Cheap checks before any work: per-IP rate limits (tighter for public token links and repeated
 * OCPI credential failures) and request body size. Returns a response to send, or null to go on.
 */
export async function guard(req: Request, rl = limiter, now = Date.now(), shared: SharedLimits = {}): Promise<Response | null> {
  const url = new URL(req.url);
  const ip = clientIp(req);
  const ocpi = url.pathname.startsWith("/ocpi/") || url.pathname.startsWith("/sim/");
  const general = ocpi ? LIMITS.ocpi : LIMITS.api;
  let r = rl.hit(`${ocpi ? "ocpi" : "api"}:${ip}`, general.max, general.windowMs, now);
  if (!r.ok) return tooMany(r.retryAfter, ocpi);
  if (ocpi && (rl.count(`ocpi401:${ip}`, LIMITS.ocpiAuthFail.windowMs, now) >= LIMITS.ocpiAuthFail.max || rl.count(`ocpiblock:${ip}`, LIMITS.ocpiAuthFail.windowMs, now) > 0)) return tooMany(60, true);
  const isPublic = /^\/api\/(pass|invites)\//.test(url.pathname);
  if (isPublic) {
    r = rl.hit(`public:${ip}`, LIMITS.publicToken.max, LIMITS.publicToken.windowMs, now);
    if (!r.ok) return tooMany(r.retryAfter, false);
  }
  // Shared across isolates (Workers Rate Limiting bindings, when configured).
  if (await overShared(ocpi ? shared.ocpi : shared.api, `${ocpi ? "ocpi" : "api"}:${ip}`)) return tooMany(60, ocpi);
  if (isPublic && await overShared(shared.publicToken, `public:${ip}`)) return tooMany(60, false);
  if (/\/export$/.test(url.pathname) || req.method === "DELETE" && /^\/api\/(me|fleets\/[^/]+)$/.test(url.pathname)) {
    r = rl.hit(`account:${ip}`, LIMITS.account.max, LIMITS.account.windowMs, now);
    if (!r.ok) return tooMany(r.retryAfter, false);
  }
  const max = ocpi ? BODY_LIMITS.ocpi : BODY_LIMITS.api;
  if (Number(req.headers.get("Content-Length") ?? "0") > max) {
    return ocpi
      ? Response.json({ status_code: 2001, status_message: new BodyTooLarge(max).message, timestamp: new Date().toISOString() }, { status: 413 })
      : Response.json({ error: { message: new BodyTooLarge(max).message, code: "TOO_LARGE" } }, { status: 413 });
  }
  return null;
}

/**
 * After the response: count OCPI requests that failed authentication (for the limit above). With
 * the shared binding, failures seen by other isolates count too: once it trips, this isolate
 * blocks the client for the rest of the window.
 */
export async function noteOutcome(req: Request, res: Response, rl = limiter, now = Date.now(), shared: SharedLimits = {}) {
  const path = new URL(req.url).pathname;
  if (!((path.startsWith("/ocpi/") || path.startsWith("/sim/")) && res.status === 401)) return;
  const ip = clientIp(req);
  rl.hit(`ocpi401:${ip}`, Number.MAX_SAFE_INTEGER, LIMITS.ocpiAuthFail.windowMs, now);
  if (await overShared(shared.ocpiAuthFail, `ocpi401:${ip}`)) rl.hit(`ocpiblock:${ip}`, Number.MAX_SAFE_INTEGER, LIMITS.ocpiAuthFail.windowMs, now);
}

export async function handle(pc: PagesContext): Promise<Response> {
  if (!isConfigured(pc.env)) return withSecurityHeaders(unconfigured(pc));
  try {
    const shared = sharedLimits(pc.env);
    const blocked = await guard(pc.request, limiter, Date.now(), shared);
    if (blocked) return withSecurityHeaders(blocked);
    const res = await dispatch(pc.request, liveCtx(pc));
    pc.waitUntil(noteOutcome(pc.request, res, limiter, Date.now(), shared));
    return withSecurityHeaders(res);
  } catch (e) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[${ref}]`, e);
    return withSecurityHeaders(Response.json({ error: { message: `Something went wrong on our side (reference ${ref})`, code: "INTERNAL" } }, { status: 500 }));
  }
}
