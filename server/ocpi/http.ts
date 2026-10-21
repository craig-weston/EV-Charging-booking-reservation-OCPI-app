// OCPI transport helpers: response envelope, credentials-token header, pagination, routing headers.
import type { OcpiResponse } from "../../shared/ocpi/types";
import { OCPI_STATUS } from "../../shared/ocpi/types";
import { base64ToUtf8, iso, utf8ToBase64, uuid } from "../../shared/util";

export class OcpiHttpError extends Error {
  constructor(public http: number, public statusCode: number, message: string) {
    super(message);
  }
}

export interface Routing {
  from: { country_code: string; party_id: string };
  to?: { country_code: string; party_id: string } | null;
}

/** Builds an OCPI JSON response with the standard envelope and echo headers. */
export function ocpiResponse<T>(
  req: Request | null,
  data: T | undefined,
  opts: { http?: number; statusCode?: number; message?: string; headers?: Record<string, string>; routing?: Routing | null } = {},
): Response {
  const body: OcpiResponse<T> = {
    ...(data !== undefined ? { data } : {}),
    status_code: opts.statusCode ?? OCPI_STATUS.SUCCESS,
    ...(opts.message ? { status_message: opts.message } : {}),
    timestamp: iso(new Date()),
  };
  const h = new Headers({ "Content-Type": "application/json", ...(opts.headers ?? {}) });
  if (req) {
    h.set("X-Request-ID", req.headers.get("X-Request-ID") ?? uuid());
    h.set("X-Correlation-ID", req.headers.get("X-Correlation-ID") ?? uuid());
  }
  if (opts.routing) {
    // Response: TO = requesting party, FROM = us.
    h.set("OCPI-from-country-code", opts.routing.from.country_code);
    h.set("OCPI-from-party-id", opts.routing.from.party_id);
    if (opts.routing.to) {
      h.set("OCPI-to-country-code", opts.routing.to.country_code);
      h.set("OCPI-to-party-id", opts.routing.to.party_id);
    }
  }
  return new Response(JSON.stringify(body), { status: opts.http ?? 200, headers: h });
}

export function ocpiError(req: Request | null, http: number, statusCode: number, message: string, routing?: Routing | null) {
  return ocpiResponse(req, undefined, { http, statusCode, message, routing });
}

/** Candidates for the credentials token in `Authorization: Token <base64>` (raw value kept for 2.1.1-style peers). */
export function tokenCandidates(req: Request): string[] {
  const h = req.headers.get("Authorization") ?? "";
  const m = /^Token\s+(.+)$/i.exec(h.trim());
  if (!m) return [];
  const raw = m[1].trim();
  const decoded = base64ToUtf8(raw);
  const out: string[] = [];
  if (decoded && /^[\x21-\x7e]+$/.test(decoded.replace(/\n$/, ""))) out.push(decoded.replace(/\n$/, ""));
  out.push(raw);
  return [...new Set(out)];
}

export function authHeader(token: string) {
  return `Token ${utf8ToBase64(token)}`;
}

export async function readJson<T = unknown>(req: Request): Promise<T | undefined> {
  const text = await req.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OcpiHttpError(400, OCPI_STATUS.INVALID_PARAMS, "Request body is not valid JSON");
  }
}

/** The `from` party of an incoming functional-module request (routing headers). */
export function requestFrom(req: Request): { country_code: string; party_id: string } | null {
  const cc = req.headers.get("OCPI-from-country-code");
  const pid = req.headers.get("OCPI-from-party-id");
  return cc && pid ? { country_code: cc.toUpperCase(), party_id: pid.toUpperCase() } : null;
}

export interface PageParams {
  offset: number;
  limit: number;
  dateFrom?: string;
  dateTo?: string;
}

export function pageParams(url: URL, maxLimit = 100): PageParams {
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const limit = Math.min(maxLimit, Math.max(1, Number(url.searchParams.get("limit") ?? maxLimit) || maxLimit));
  const dateFrom = url.searchParams.get("date_from") ?? undefined;
  const dateTo = url.searchParams.get("date_to") ?? undefined;
  // OCPI DateTimes without a zone designator are UTC.
  const norm = (d?: string) => {
    if (!d) return undefined;
    const t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(d) ? d : `${d}Z`);
    return Number.isNaN(t) ? undefined : iso(new Date(t));
  };
  return { offset, limit, dateFrom: norm(dateFrom), dateTo: norm(dateTo) };
}

/** Pagination response headers: Link (rel="next"), X-Total-Count, X-Limit. */
export function pageHeaders(url: URL, p: PageParams, total: number, maxLimit: number): Record<string, string> {
  const h: Record<string, string> = { "X-Total-Count": String(total), "X-Limit": String(maxLimit) };
  if (p.offset + p.limit < total) {
    const next = new URL(url.toString());
    next.searchParams.set("offset", String(p.offset + p.limit));
    next.searchParams.set("limit", String(p.limit));
    h["Link"] = `<${next.toString()}>; rel="next"`;
  }
  return h;
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link);
  return m ? m[1] : null;
}

/** Path segments after a prefix, ignoring empty segments (tolerates trailing slashes). */
export function segmentsAfter(pathname: string, prefix: string): string[] | null {
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
}
