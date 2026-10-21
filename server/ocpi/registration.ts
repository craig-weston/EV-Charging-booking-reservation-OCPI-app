// Credentials & registration (OCPI 2.3.0 §7) plus the initial pull of a CPO's data.
import type { BookingLocation, Credentials, Endpoint, Location, Tariff, Version, VersionDetails } from "../../shared/ocpi/types";
import { OCPI_STATUS } from "../../shared/ocpi/types";
import type { OcpiModule, Partner, StoredObject } from "../../shared/model";
import { iso, randomToken, upper, uuid } from "../../shared/util";
import { OCPI_VERSION, ocpiUrls, type Ctx } from "../context";
import { hint, sha256Hex } from "../security";
import { findEndpoint, ocpiCall, ocpiPullAll } from "./client";
import { OcpiHttpError } from "./http";

/**
 * A fresh credentials token. The plaintext goes to the partner once (in the credentials object or
 * the invite dialog); we keep only its SHA-256 and a short hint for display.
 */
export async function issueToken(): Promise<{ token: string; hash: string; hint: string }> {
  const token = randomToken(32);
  return { token, hash: await sha256Hex(token), hint: hint(token)! };
}

// Loopback, private (RFC 1918), CGNAT, link-local and unique-local ranges, plus internal names.
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.\d+\.\d+\.\d+|\[?::1?\]?|\[?f[cd][0-9a-f]{0,2}:.*|\[?fe80:.*|\[?::ffff:.*)$/i;

/**
 * Operator URLs we will call. In production they must be https:// on a public host (OCPI requires
 * TLS, and this stops the platform being pointed at internal addresses). The built-in simulator
 * on our own origin, demo mode and tests are exempt.
 */
export function assertPartnerUrl(ctx: Ctx, raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OcpiHttpError(200, OCPI_STATUS.INVALID_PARAMS, `Not a valid URL: ${raw.slice(0, 80)}`);
  }
  if (u.origin === new URL(ctx.baseUrl).origin || ctx.mode !== "live") return;
  if (u.protocol !== "https:") throw new OcpiHttpError(200, OCPI_STATUS.INVALID_PARAMS, "Operator URLs must use https (OCPI requires TLS)");
  if (u.username || u.password) throw new OcpiHttpError(200, OCPI_STATUS.INVALID_PARAMS, "Operator URLs must not contain credentials");
  if (PRIVATE_HOST.test(u.hostname)) throw new OcpiHttpError(200, OCPI_STATUS.INVALID_PARAMS, "Operator URLs must point to a public host");
}

export function ourCredentials(ctx: Ctx, token: string): Credentials {
  return {
    token,
    url: ocpiUrls(ctx.baseUrl).versions,
    roles: [{
      role: "EMSP",
      business_details: { name: ctx.party.name },
      party_id: ctx.party.party_id,
      country_code: ctx.party.country_code,
    }],
  };
}

export function ourEndpoints(ctx: Ctx): Endpoint[] {
  const u = ocpiUrls(ctx.baseUrl);
  return [
    { identifier: "credentials", role: "SENDER", url: u.module("credentials") },
    { identifier: "locations", role: "RECEIVER", url: u.module("locations") },
    { identifier: "tariffs", role: "RECEIVER", url: u.module("tariffs") },
    { identifier: "sessions", role: "RECEIVER", url: u.module("sessions") },
    { identifier: "cdrs", role: "RECEIVER", url: u.module("cdrs") },
    { identifier: "tokens", role: "SENDER", url: u.module("tokens") },
    { identifier: "bookings", role: "RECEIVER", url: u.module("bookings") },
    // mod_bookings.asciidoc names the module identifier "Booking"; listed too for peers that match it literally.
    { identifier: "Booking", role: "RECEIVER", url: u.module("bookings") },
  ];
}

/** GET versions → pick 2.3.0 → GET version details. Throws OcpiHttpError(3001/3002). */
export async function fetchPartnerEndpoints(ctx: Ctx, versionsUrl: string, token: string, partner: Partner | null): Promise<{ version: string; endpoints: Endpoint[] }> {
  assertPartnerUrl(ctx, versionsUrl);
  const v = await ocpiCall<Version[]>(ctx, { method: "GET", url: versionsUrl, token, module: "versions", partner });
  if (!v.ok || !Array.isArray(v.data)) throw new OcpiHttpError(200, OCPI_STATUS.UNABLE_TO_USE_CLIENT_API, `Could not read versions: ${v.error ?? "bad response"}`);
  const match = v.data.find((x) => x.version === OCPI_VERSION) ?? v.data.find((x) => x.version.startsWith("2.3"));
  if (!match) throw new OcpiHttpError(200, OCPI_STATUS.UNSUPPORTED_VERSION, `No mutual OCPI version (we support ${OCPI_VERSION})`);
  assertPartnerUrl(ctx, match.url);
  const d = await ocpiCall<VersionDetails>(ctx, { method: "GET", url: match.url, token, module: "versions", partner });
  if (!d.ok || !d.data?.endpoints) throw new OcpiHttpError(200, OCPI_STATUS.UNABLE_TO_USE_CLIENT_API, `Could not read version details: ${d.error ?? "bad response"}`);
  for (const e of d.data.endpoints) assertPartnerUrl(ctx, e.url);
  return { version: d.data.version ?? match.version, endpoints: d.data.endpoints };
}

function displayName(c: Credentials): string {
  const cpos = c.roles.filter((r) => r.role === "CPO");
  const names = (cpos.length ? cpos : c.roles).map((r) => r.business_details?.name).filter(Boolean);
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] ?? "OCPI partner";
}

function normaliseRoles(c: Credentials) {
  return c.roles.map((r) => ({ ...r, country_code: upper(r.country_code), party_id: upper(r.party_id) }));
}

/** Inbound: the CPO POSTs its credentials using the CREDENTIALS_TOKEN_A we gave it. */
export async function acceptRegistration(ctx: Ctx, partner: Partner, body: Credentials): Promise<Credentials> {
  if (!body?.token || !body.url || !Array.isArray(body.roles) || !body.roles.length) {
    throw new OcpiHttpError(400, OCPI_STATUS.INVALID_PARAMS, "Credentials object requires token, url and roles");
  }
  const { version, endpoints } = await fetchPartnerEndpoints(ctx, body.url, body.token, partner);
  if (!findEndpoint({ endpoints }, "bookings", "SENDER")) {
    throw new OcpiHttpError(200, OCPI_STATUS.NO_MATCHING_ENDPOINTS, "Expected a Bookings Sender endpoint (OCPI 2.3.0 Bookings module)");
  }
  const ours = await issueToken();
  await ctx.store.upsertPartner({
    ...partner,
    name: partner.name && partner.name !== "Invited partner" ? partner.name : displayName(body),
    status: "CONNECTED", versions_url: body.url, version, endpoints, roles: normaliseRoles(body),
    registration_token_hash: null, our_token_hash: ours.hash, token_hint: ours.hint, their_token: body.token, updated_at: iso(ctx.now()),
  });
  return ourCredentials(ctx, ours.token);
}

/** Inbound PUT: the partner updates its credentials/endpoints; we issue a fresh token. */
export async function updateRegistration(ctx: Ctx, partner: Partner, body: Credentials): Promise<Credentials> {
  if (!body?.token || !body.url) throw new OcpiHttpError(400, OCPI_STATUS.INVALID_PARAMS, "Credentials object requires token and url");
  const { version, endpoints } = await fetchPartnerEndpoints(ctx, body.url, body.token, partner);
  const ours = await issueToken();
  await ctx.store.upsertPartner({
    ...partner, status: "CONNECTED", versions_url: body.url, version, endpoints,
    roles: body.roles?.length ? normaliseRoles(body) : partner.roles, our_token_hash: ours.hash, token_hint: ours.hint, their_token: body.token,
    updated_at: iso(ctx.now()),
  });
  return ourCredentials(ctx, ours.token);
}

/**
 * Creates a partner record holding a fresh CREDENTIALS_TOKEN_A to send to a CPO out-of-band.
 * The token is returned once; only its hash is stored.
 */
export async function invitePartner(ctx: Ctx, name: string): Promise<{ partner: Partner; token: string }> {
  const now = iso(ctx.now());
  const t = await issueToken();
  const partner = await ctx.store.upsertPartner({
    id: uuid(), name: name || "Invited partner", status: "PENDING", versions_url: null, version: null, endpoints: [], roles: [],
    registration_token_hash: t.hash, our_token_hash: null, token_hint: t.hint, their_token: null, is_simulator: false, last_sync_at: null,
    created_at: now, updated_at: now,
  });
  return { partner, token: t.token };
}

/** Replaces a pending partner's registration token (the old one stops working). */
export async function newRegistrationToken(ctx: Ctx, partner: Partner): Promise<{ partner: Partner; token: string }> {
  if (partner.status !== "PENDING") throw new Error("Only operators that haven't registered yet get a registration token");
  const t = await issueToken();
  const saved = await ctx.store.upsertPartner({ ...partner, registration_token_hash: t.hash, token_hint: t.hint, updated_at: iso(ctx.now()) });
  return { partner: saved, token: t.token };
}

/** Outbound: we register with a CPO using the versions URL + CREDENTIALS_TOKEN_A they gave us. */
export async function registerWithPartner(ctx: Ctx, versionsUrl: string, tokenA: string, opts: { isSimulator?: boolean; name?: string } = {}): Promise<Partner> {
  const now = iso(ctx.now());
  const draft: Partner = {
    id: uuid(), name: opts.name ?? "Connecting…", status: "PENDING", versions_url: versionsUrl, version: null, endpoints: [], roles: [],
    registration_token_hash: null, our_token_hash: null, token_hint: null, their_token: null, is_simulator: !!opts.isSimulator, last_sync_at: null, created_at: now, updated_at: now,
  };
  const { version, endpoints } = await fetchPartnerEndpoints(ctx, versionsUrl, tokenA, draft);
  const credsUrl = findEndpoint({ endpoints }, "credentials", "SENDER") ?? findEndpoint({ endpoints }, "credentials", "RECEIVER");
  if (!credsUrl) throw new Error("Partner has no credentials endpoint");
  if (!findEndpoint({ endpoints }, "bookings", "SENDER")) throw new Error("Partner has no Bookings Sender endpoint (OCPI 2.3.0 Bookings module)");
  const ours = await issueToken();
  // Store the token's hash before POSTing: the partner calls our versions endpoint with it during the POST.
  await ctx.store.upsertPartner({ ...draft, version, endpoints, our_token_hash: ours.hash, token_hint: ours.hint });
  const res = await ocpiCall<Credentials>(ctx, {
    method: "POST", url: credsUrl, token: tokenA, body: ourCredentials(ctx, ours.token), module: "credentials", partner: draft,
  });
  if (!res.ok || !res.data?.token) {
    await ctx.store.upsertPartner({ ...draft, version, endpoints, our_token_hash: null, token_hint: null, status: "PENDING" });
    throw new Error(`Registration failed: ${res.error ?? "no credentials returned"}`);
  }
  return ctx.store.upsertPartner({
    ...draft, name: opts.name ?? displayName(res.data), status: "CONNECTED", version, endpoints,
    roles: normaliseRoles(res.data), our_token_hash: ours.hash, token_hint: ours.hint, their_token: res.data.token, updated_at: iso(ctx.now()),
  });
}

/** Pull Locations, Tariffs and BookingLocations from the partner's Sender interfaces. */
export async function syncPartner(ctx: Ctx, partner: Partner): Promise<Record<string, number>> {
  if (partner.status !== "CONNECTED" || !partner.their_token) throw new Error("Partner is not connected");
  const counts: Record<string, number> = {};
  const routing = { from: { country_code: ctx.party.country_code, party_id: ctx.party.party_id }, to: partner.roles[0] ? { country_code: partner.roles[0].country_code, party_id: partner.roles[0].party_id } : null };
  const pulls: [OcpiModule, string | null][] = [
    ["locations", findEndpoint(partner, "locations", "SENDER")],
    ["tariffs", findEndpoint(partner, "tariffs", "SENDER")],
    ["booking_locations", (() => { const b = findEndpoint(partner, "bookings", "SENDER"); return b ? `${b}/booking_locations` : null; })()],
  ];
  for (const [module, url] of pulls) {
    if (!url) continue;
    const r = await ocpiPullAll<Location | Tariff | BookingLocation>(ctx, { url, token: partner.their_token, routing, module: module === "booking_locations" ? "bookings" : module, partner });
    if (!r.ok) throw new Error(`Pulling ${module} failed: ${r.error}`);
    const owned = r.items.filter((o) => partner.roles.some((ro) => upper(ro.country_code) === upper(o.country_code) && upper(ro.party_id) === upper(o.party_id)));
    const objs: StoredObject[] = owned.map((o) => ({
      module, country_code: upper(o.country_code), party_id: upper(o.party_id), id: o.id, data: o, last_updated: o.last_updated ?? iso(ctx.now()), partner_id: partner.id,
    }));
    await ctx.store.putObjects(objs);
    counts[module] = objs.length;
  }
  await ctx.store.upsertPartner({ ...partner, last_sync_at: iso(ctx.now()), updated_at: iso(ctx.now()) });
  return counts;
}

/** Outbound DELETE on the partner's credentials endpoint, then mark it removed. */
export async function unregisterPartner(ctx: Ctx, partner: Partner): Promise<void> {
  const url = findEndpoint(partner, "credentials", "SENDER") ?? findEndpoint(partner, "credentials", "RECEIVER");
  if (url && partner.their_token && partner.status === "CONNECTED") {
    await ocpiCall(ctx, { method: "DELETE", url, token: partner.their_token, module: "credentials", partner });
  }
  await ctx.store.upsertPartner({ ...partner, status: "REMOVED", our_token_hash: null, their_token: null, registration_token_hash: null, updated_at: iso(ctx.now()) });
}
