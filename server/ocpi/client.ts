// Outbound OCPI calls (eMSP → CPO) with the required headers and message logging.
import type { OcpiResponse } from "../../shared/ocpi/types";
import type { OcpiLogEntry, Partner } from "../../shared/model";
import { iso, partyKey, uuid } from "../../shared/util";
import type { Ctx } from "../context";
import { authHeader, parseNextLink, type Routing } from "./http";

export interface CallOpts {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  token: string;
  body?: unknown;
  /** Functional modules carry routing headers; configuration modules (versions, credentials) must not. */
  routing?: Routing | null;
  module?: string;
  partner?: Partner | null;
  bookingId?: string | null;
  /** Log to the OCPI message log (default true). The simulator passes false. */
  log?: boolean;
  correlationId?: string;
  timeoutMs?: number;
}

export interface CallResult<T> {
  http: number;
  ok: boolean; // HTTP 2xx and status_code 1xxx
  envelope: OcpiResponse<T> | null;
  data: T | undefined;
  headers: Headers;
  error?: string;
}

const SECRET_KEYS = /^(token|password|secret|api_?key|authorization)$/i;

/** Copies a body with secrets masked: credentials tokens never reach the message log. */
export function redactSecrets(v: unknown, depth = 0): unknown {
  if (depth > 8 || v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) && typeof x === "string" ? `[redacted …${x.slice(-4)}]` : redactSecrets(x, depth + 1);
  }
  return out;
}

export function logBody(body: unknown): unknown {
  if (body == null) return null;
  const trim = (v: unknown): unknown => (Array.isArray(v) && v.length > 6 ? { _first: v.slice(0, 4), _truncated: v.length } : v);
  const safe = redactSecrets(body);
  if (typeof safe === "object" && safe && "data" in (safe as Record<string, unknown>)) {
    const b = safe as Record<string, unknown>;
    return { ...b, data: trim(b.data) };
  }
  return trim(safe);
}

export async function ocpiCall<T = unknown>(ctx: Ctx, o: CallOpts): Promise<CallResult<T>> {
  const requestId = uuid();
  const correlationId = o.correlationId ?? uuid();
  const headers: Record<string, string> = {
    Authorization: authHeader(o.token),
    "X-Request-ID": requestId,
    "X-Correlation-ID": correlationId,
  };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.routing) {
    headers["OCPI-from-country-code"] = o.routing.from.country_code;
    headers["OCPI-from-party-id"] = o.routing.from.party_id;
    if (o.routing.to) {
      headers["OCPI-to-country-code"] = o.routing.to.country_code;
      headers["OCPI-to-party-id"] = o.routing.to.party_id;
    }
  }
  const started = Date.now();
  let http = 0;
  let envelope: OcpiResponse<T> | null = null;
  let resHeaders = new Headers();
  let error: string | undefined;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 15_000);
  try {
    const res = await ctx.transport(new Request(o.url, {
      method: o.method,
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: ac.signal,
      // Never follow redirects: our credentials token must only go to the URL the operator registered
      // (checked to be https on a public host), not wherever a 3xx points.
      redirect: "manual",
    }));
    http = res.status;
    resHeaders = res.headers;
    if (http >= 300 && http < 400) throw new Error(`Refused to follow a redirect (HTTP ${http})`);
    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    try {
      envelope = text ? (JSON.parse(text) as OcpiResponse<T>) : null;
    } catch {
      error = `Non-JSON response (HTTP ${res.status})`;
    }
  } catch (e) {
    error = e instanceof Error ? (e.name === "AbortError" ? "Timed out" : e.message) : String(e);
  } finally {
    clearTimeout(timer);
  }
  const statusCode = envelope?.status_code ?? null;
  const ok = http >= 200 && http < 300 && statusCode != null && statusCode >= 1000 && statusCode < 2000;
  if (!ok && !error) error = envelope?.status_message ?? `HTTP ${http}${statusCode ? ` / OCPI ${statusCode}` : ""}`;

  if (o.log !== false) {
    const role = o.routing?.to ?? (o.partner?.roles[0] ? { country_code: o.partner.roles[0].country_code, party_id: o.partner.roles[0].party_id } : null);
    const entry: OcpiLogEntry = {
      id: uuid(),
      at: iso(new Date(started)),
      direction: "OUT",
      partner_id: o.partner?.id ?? null,
      party: role ? partyKey(role.country_code, role.party_id) : null,
      module: o.module ?? null,
      method: o.method,
      url: o.url,
      http_status: http || null,
      status_code: statusCode,
      request_id: requestId,
      correlation_id: correlationId,
      request_body: logBody(o.body ?? null),
      response_body: logBody(envelope ?? (error ? { error } : null)),
      duration_ms: Date.now() - started,
      booking_id: o.bookingId ?? null,
    };
    ctx.waitUntil(ctx.store.addLogs([entry]).catch(() => undefined));
  }
  return { http, ok, envelope, data: envelope?.data, headers: resHeaders, error };
}

/** Largest OCPI response we accept (one page of Locations with full EVSE details stays far below). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Reads a response body as text, giving up beyond `max` bytes so a misbehaving peer can't exhaust memory. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("Content-Length") ?? "0") > max) throw new Error(`Response larger than ${max / 1024 / 1024} MB`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response larger than ${max / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** GET a paginated Sender list, following `Link: <…>; rel="next"`. */
export async function ocpiPullAll<T>(ctx: Ctx, o: Omit<CallOpts, "method" | "body">, maxPages = 50): Promise<{ ok: boolean; items: T[]; error?: string }> {
  const items: T[] = [];
  let url: string | null = o.url;
  for (let i = 0; url && i < maxPages; i++) {
    const r: CallResult<T[]> = await ocpiCall<T[]>(ctx, { ...o, method: "GET", url });
    if (!r.ok) return { ok: false, items, error: r.error };
    if (Array.isArray(r.data)) items.push(...r.data);
    const next = parseNextLink(r.headers.get("Link"));
    // Only follow pagination on the same host: our token must not be sent elsewhere.
    if (next && new URL(next, url).origin !== new URL(o.url).origin) return { ok: false, items, error: "Pagination link points to a different host" };
    url = next ? new URL(next, url).toString() : null;
  }
  return { ok: true, items };
}

export function findEndpoint(p: Partner | { endpoints: { identifier: string; role: string; url: string }[] }, module: string, role: "SENDER" | "RECEIVER"): string | null {
  const ids = module === "bookings" ? ["bookings", "booking"] : [module];
  const ep = p.endpoints.find((e) => ids.includes(e.identifier.toLowerCase()) && e.role === role)
    ?? p.endpoints.find((e) => ids.includes(e.identifier.toLowerCase()));
  return ep ? ep.url.replace(/\/+$/, "") : null;
}
