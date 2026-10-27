// Security primitives shared by the Pages Functions, the tests and the in-browser demo.
// Web Crypto only (crypto.subtle), so it runs on Cloudflare Workers, Node 20+ and browsers.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "===".slice((pad.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** SHA-256 as lower-case hex. Used to store credentials tokens we issue: only the hash is kept. */
export async function sha256Hex(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fleet API keys: "fck_" + 32 random bytes (base64url, 43 characters). The prefix makes a leaked
 * key easy to recognise (and to search for in logs and repositories); only its SHA-256 is stored.
 */
export const API_KEY_PREFIX = "fck_";
export const isApiKey = (v: string) => /^fck_[A-Za-z0-9_-]{40,64}$/.test(v);

/** Constant-time string comparison (length is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Last characters of a secret, for display ("…k3Qz"). Never enough to use. */
export function hint(secret: string | null | undefined): string | null {
  return secret ? `…${secret.slice(-4)}` : null;
}

// ------------------------------------------------------------------ secrets at rest

const SEALED = "enc:v1:";
const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(keyB64: string): Promise<CryptoKey> {
  let k = keyCache.get(keyB64);
  if (!k) {
    const raw = fromB64url(keyB64.trim());
    if (raw.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 random bytes, base64 encoded");
    k = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keyCache.set(keyB64, k);
  }
  return k;
}

/** AES-256-GCM encrypts a secret for storage ("enc:v1:<iv>:<ciphertext>"). Without a key the value is kept as is. */
export async function sealSecret(plain: string | null, keyB64: string | undefined): Promise<string | null> {
  if (plain == null || !keyB64 || plain.startsWith(SEALED)) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), enc.encode(plain)));
  return `${SEALED}${b64url(iv)}:${b64url(ct)}`;
}

/**
 * Reverses sealSecret. Values stored before encryption was switched on pass through unchanged.
 * During a key rotation the previous key is tried when the current one doesn't fit.
 */
export async function openSecret(stored: string | null, keyB64: string | undefined, previousB64?: string): Promise<string | null> {
  if (stored == null || !stored.startsWith(SEALED)) return stored;
  if (!keyB64 && !previousB64) throw new Error("A stored secret is encrypted but DATA_ENCRYPTION_KEY is not set");
  const [ivPart, ctPart] = stored.slice(SEALED.length).split(":");
  let failure: unknown = null;
  for (const k of [keyB64, previousB64]) {
    if (!k) continue;
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(ivPart) }, await aesKey(k), fromB64url(ctPart));
      return dec.decode(pt);
    } catch (e) {
      failure = e;
    }
  }
  throw failure instanceof Error ? failure : new Error("A stored secret could not be decrypted with DATA_ENCRYPTION_KEY");
}

/** True when the value is sealed (encrypted at rest). */
export const isSealed = (stored: string | null | undefined) => !!stored && stored.startsWith(SEALED);

// ------------------------------------------------------------------ rate limiting

/**
 * Sliding-window limiter held in memory. On Cloudflare each isolate keeps its own counts, so this
 * is only a first line of defence: the shared limits below (Workers Rate Limiting bindings) count
 * across every isolate in a Cloudflare location, and a WAF rule can add a global limit.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private maxKeys = 5000) {}

  /** Records a hit; returns the seconds to wait when the key is over `max` hits per `windowMs`. */
  hit(key: string, max: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfter: number } {
    const from = now - windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > from);
    if (list.length >= max) {
      this.hits.set(key, list);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) {
      // Drop the oldest keys; a busy isolate must not grow without bound.
      for (const k of [...this.hits.keys()].slice(0, Math.floor(this.maxKeys / 4))) this.hits.delete(k);
    }
    return { ok: true, retryAfter: 0 };
  }

  /** Counts without recording (e.g. failed sign-ins already over the limit). */
  count(key: string, windowMs: number, now = Date.now()): number {
    return (this.hits.get(key) ?? []).filter((t) => t > now - windowMs).length;
  }
}

/** A Cloudflare Workers Rate Limiting binding (wrangler.jsonc → "ratelimits"). */
export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Limits shared by every isolate in a Cloudflare location. Counts are approximate and per
 * location; for the in-memory limiter above they're a backstop, not a replacement.
 */
export interface SharedLimits {
  api?: RateLimitBinding;
  ocpi?: RateLimitBinding;
  publicToken?: RateLimitBinding;
  ocpiAuthFail?: RateLimitBinding;
}

export function sharedLimits(env: { RL_API?: unknown; RL_OCPI?: unknown; RL_PUBLIC?: unknown; RL_OCPI_AUTH?: unknown }): SharedLimits {
  const b = (v: unknown) => (v && typeof (v as RateLimitBinding).limit === "function" ? (v as RateLimitBinding) : undefined);
  return { api: b(env.RL_API), ocpi: b(env.RL_OCPI), publicToken: b(env.RL_PUBLIC), ocpiAuthFail: b(env.RL_OCPI_AUTH) };
}

/** True when the shared limit is exceeded. Fails open: a binding error must not take the API down. */
export async function overShared(binding: RateLimitBinding | undefined, key: string): Promise<boolean> {
  if (!binding) return false;
  try {
    return !(await binding.limit({ key })).success;
  } catch (e) {
    console.warn("rate limit binding failed", e);
    return false;
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For")?.split(",")[0].trim() ?? "local";
}

/** Limits applied before any work is done. Keys are per client IP. */
export const LIMITS = {
  api: { max: 300, windowMs: 60_000 },
  publicToken: { max: 30, windowMs: 60_000 }, // pass links and invite previews: guessing protection
  ocpi: { max: 1200, windowMs: 60_000 },
  ocpiAuthFail: { max: 20, windowMs: 5 * 60_000 }, // unknown credentials tokens
  account: { max: 10, windowMs: 60 * 60_000 }, // exports and deletions
} as const;

export const BODY_LIMITS = { api: 256 * 1024, ocpi: 2 * 1024 * 1024 } as const;

/** Reads a request body as text, refusing anything over `max` bytes (declared or actual). */
export async function readLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > max) throw new BodyTooLarge(max);
  const text = await req.text();
  if (enc.encode(text).length > max) throw new BodyTooLarge(max);
  return text;
}

export class BodyTooLarge extends Error {
  constructor(public max: number) {
    super(`Request body is larger than ${Math.round(max / 1024)} KB`);
  }
}

// ------------------------------------------------------------------ response headers

/** Headers for every response from the Functions (static files get theirs from dist/_headers). */
export function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  h.set("X-Robots-Tag", "noindex, nofollow");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// ------------------------------------------------------------------ JWT claims

export interface JwtClaims {
  sub?: string;
  email?: string;
  exp?: number;
  aal?: "aal1" | "aal2";
  session_id?: string;
  amr?: { method: string; timestamp: number }[];
}

/**
 * Decodes a JWT payload WITHOUT verifying it. Only use on a token Supabase Auth has just accepted
 * (GET /auth/v1/user), to read claims such as the assurance level (aal).
 */
export function jwtClaims(token: string): JwtClaims {
  try {
    return JSON.parse(dec.decode(fromB64url(token.split(".")[1] ?? ""))) as JwtClaims;
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ uploaded images

const SVG_FORBIDDEN = [
  /<script/i, /\son[a-z]+\s*=/i, /javascript:/i, /<foreignObject/i, /<iframe/i, /<embed/i, /<object/i,
  /<!ENTITY/i, /(?:xlink:)?href\s*=\s*["']\s*(?!#)/i, /url\(\s*["']?\s*(?!#)/i, /@import/i, /<animate[^>]+attributeName\s*=\s*["']?href/i,
];

/**
 * Checks an uploaded logo. SVGs must be self-contained artwork: no scripts, event handlers,
 * external references or embedded documents. Raster images must really be PNG, JPEG or WebP.
 * Returns an error message, or null when the image is acceptable.
 */
export function checkLogo(value: string): string | null {
  if (!value) return null;
  if (/^https:\/\/[^\s"'<>]+$/i.test(value)) return value.length <= 2048 ? null : "Logo URL is too long";
  const m = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m) return "Logo must be an https:// URL or an uploaded SVG, PNG, JPEG or WebP image";
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  } catch {
    return "The uploaded image couldn't be read";
  }
  if (bytes.length > 100_000) return "Logo is too large. Use an SVG or PNG under 100 KB";
  const type = m[1];
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (type === "png" && !starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "That file isn't a PNG image";
  if (type === "jpeg" && !starts([0xff, 0xd8, 0xff])) return "That file isn't a JPEG image";
  if (type === "webp" && !(starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))) return "That file isn't a WebP image";
  if (type === "svg+xml") {
    const text = dec.decode(bytes);
    if (!/<svg[\s>]/i.test(text)) return "That file isn't an SVG image";
    if (SVG_FORBIDDEN.some((re) => re.test(text))) return "This SVG contains scripts, links or embedded content. Export it as plain artwork, or upload a PNG";
  }
  return null;
}
