// Security controls: secrets at rest, OCPI credentials, MFA policy, rate limits, uploads,
// invites, passes, data rights (export / deletion) and the audit trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditEntry, BookingRow, Fleet, FleetInvite } from "../shared/model";
import type { Token } from "../shared/ocpi/types";
import { createLocalCtx, dispatch } from "../server/dispatch";
import type { AuthUser } from "../server/context";
import { RateLimiter, checkLogo, sharedLimits, type RateLimitBinding, openSecret, sealSecret, sha256Hex, withSecurityHeaders } from "../server/security";
import { guard, noteOutcome } from "../server/live";
import { ocpiCall, ocpiPullAll, redactSecrets } from "../server/ocpi/client";
import { MemoryStore } from "../server/store/memory";
import { assertPartnerUrl } from "../server/ocpi/registration";
import { passExpired } from "../server/api/router";
import { harness, type Harness } from "./helpers";

function as(h: Harness, user: AuthUser | null, mode: "demo" | "live" = "demo") {
  const ctx = createLocalCtx({ store: h.store, simDelayMs: 0, now: () => h.clock.now, user, mode, env: { OCPI_COUNTRY_CODE: "GB", OCPI_PARTY_ID: "DPC", ENABLE_CPO_SIMULATOR: "true" } });
  return async <T = unknown>(method: string, path: string, body?: unknown) => {
    const res = await dispatch(new Request(ctx.baseUrl + path, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer test" }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx);
    const json = (await res.json()) as { data: T; error?: { message: string; code?: string } };
    return { status: res.status, data: json.data, error: json.error };
  };
}

test("secrets at rest: AES-256-GCM sealing, hashes, and old plaintext values still readable", async () => {
  const key = Buffer.from(new Uint8Array(32).map((_, i) => i * 7)).toString("base64");
  const sealed = await sealSecret("their-token-123", key);
  assert.match(sealed!, /^enc:v1:/);
  assert.ok(!sealed!.includes("their-token-123"));
  assert.equal(await openSecret(sealed, key), "their-token-123");
  assert.notEqual(await sealSecret("their-token-123", key), sealed); // random IV
  assert.equal(await openSecret("legacy-plain", key), "legacy-plain");
  const other = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
  await assert.rejects(() => openSecret(sealed, other));
  await assert.rejects(() => openSecret(sealed, undefined), /DATA_ENCRYPTION_KEY/);
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("OCPI credentials: only hashes are stored, tokens are redacted from the message log", async () => {
  const h = await harness();
  const r = await h.api<{ partner: { id: string } }>("POST", "/api/admin/simulator/connect");
  assert.equal(r.status, 201);
  const stored = h.store.data.partners[0];
  const state = await h.store.getSimState<{ reg: { emsp_token: string } }>("cpo");
  const tokenC = state!.reg.emsp_token;
  assert.equal(stored.our_token_hash, await sha256Hex(tokenC));
  assert.ok(!JSON.stringify(h.store.data.partners).includes(tokenC), "token C is never stored in clear");
  assert.ok(!JSON.stringify(h.store.data.logs).includes(tokenC), "token C never reaches the message log");
  const credLog = h.store.data.logs.find((l) => l.module === "credentials" && l.method === "POST");
  assert.match(JSON.stringify(credLog), /\[redacted …/);

  // The admin API never returns token material.
  const list = await h.api<Record<string, unknown>[]>("GET", "/api/admin/partners");
  assert.ok(!("our_token_hash" in list.data[0]) && !("their_token" in list.data[0]));

  // GET /credentials echoes the token the partner authenticated with; a wrong token is refused.
  const ok = await h.ocpi<{ token: string }>("GET", "/ocpi/emsp/2.3.0/credentials", tokenC);
  assert.equal(ok.json.data?.token, tokenC);
  const bad = await h.ocpi("GET", "/ocpi/emsp/2.3.0/credentials", "not-a-token");
  assert.equal(bad.status, 401);

  // An invite's registration token is shown once and stored as a hash.
  const inv = await h.api<{ id: string; registration_token: string; token_hint: string }>("POST", "/api/admin/partners", { action: "invite", name: "Midlands Truck Charging" });
  assert.equal(inv.status, 201);
  assert.ok(inv.data.registration_token.length >= 40);
  assert.equal(inv.data.token_hint, `…${inv.data.registration_token.slice(-4)}`);
  const p = h.store.data.partners.find((x) => x.id === inv.data.id)!;
  assert.equal(p.registration_token_hash, await sha256Hex(inv.data.registration_token));
  const again = await h.api<{ registration_token: string }>("POST", `/api/admin/partners/${inv.data.id}/token`);
  assert.notEqual(again.data.registration_token, inv.data.registration_token);

  assert.deepEqual(redactSecrets({ data: { token: "abcdefgh", url: "u", roles: [{ token: "zzzz9999" }] } }), { data: { token: "[redacted …efgh]", url: "u", roles: [{ token: "[redacted …9999]" }] } });
});

test("OCPI: sessions from another operator can't touch a booking; token list carries no plates", async () => {
  const h = await harness();
  await h.api("POST", "/api/admin/simulator/connect");
  const t = (await h.store.getSimState<{ reg: { emsp_token: string } }>("cpo"))!.reg.emsp_token;
  // Fake a booking made with VoltHaul, then try to update it with a session claiming to be from Kestrel.
  const row = { id: "b-x", fleet_id: h.fleetId, cpo_country_code: "GB", cpo_party_id: "VHL", authorization_reference: "AUTH-X", session: null } as unknown as BookingRow;
  h.store.data.bookings.push({ ...(row as object), vehicle_id: null, driver_id: null, reservation_status: "RESERVED", start_at: "2026-10-21T08:00:00Z", end_at: "2026-10-21T09:00:00Z", request_id: "R-X", ocpi_id: "BK-X", pass_token: "p", updated_at: "2026-10-21T07:00:00Z", created_at: "2026-10-21T07:00:00Z" } as BookingRow);
  const s = { country_code: "GB", party_id: "KCH", id: "S-X", start_date_time: "2026-10-21T08:00:00Z", kwh: 10, cdr_token: { country_code: "GB", party_id: "DPC", uid: "U", type: "EMAID", contract_id: "C" }, auth_method: "AUTH_REQUEST", authorization_reference: "AUTH-X", location_id: "L", evse_uid: "E", connector_id: "1", currency: "GBP", status: "ACTIVE", last_updated: "2026-10-21T08:10:00Z" };
  const put = await h.ocpi("PUT", "/ocpi/emsp/2.3.0/sessions/GB/KCH/S-X", t, s);
  assert.equal(put.status, 201); // accepted as Kestrel's own session object...
  assert.equal(h.store.data.bookings.find((b) => b.id === "b-x")!.session, null); // ...but not linked to VoltHaul's booking

  await h.api("PATCH", `/api/fleets/${h.fleetId}`, { allow_unbooked_charging: false });
  const tokens = await h.ocpi<Token[]>("GET", "/ocpi/emsp/2.3.0/tokens", t);
  assert.ok(tokens.json.data!.length >= 5);
  assert.ok(tokens.json.data!.every((x) => x.visual_number === undefined && x.whitelist === "NEVER"));
});

test("partner URLs: https on public hosts only in production", () => {
  const live = { mode: "live" as const, baseUrl: "https://book.example.co.uk" } as Parameters<typeof assertPartnerUrl>[0];
  assert.throws(() => assertPartnerUrl(live, "http://ocpi.operator.example/versions"), /https/);
  assert.throws(() => assertPartnerUrl(live, "https://169.254.169.254/latest"), /public host/);
  assert.throws(() => assertPartnerUrl(live, "https://10.0.0.5/ocpi"), /public host/);
  assert.throws(() => assertPartnerUrl(live, "https://user:pw@ocpi.operator.example/v"), /credentials/);
  assert.doesNotThrow(() => assertPartnerUrl(live, "https://ocpi.operator.example/versions"));
  assert.doesNotThrow(() => assertPartnerUrl(live, "https://book.example.co.uk/sim/cpo/versions")); // our own simulator
});

test("two-step verification: enrolled accounts must use it, fleets can require it, admins need it live", async () => {
  const h = await harness();
  const stepUp = as(h, { id: "user-1", email: "planner@example.com", aal: "aal1", mfa: true });
  const me = await stepUp<{ mfa: { enrolled: boolean; aal: string } }>("GET", "/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.mfa, { enrolled: true, aal: "aal1", admin_required: false });
  const blocked = await stepUp("GET", `/api/fleets/${h.fleetId}/vehicles`);
  assert.deepEqual([blocked.status, blocked.error?.code], [401, "MFA_CHALLENGE"]);

  // The owner can't switch the policy on from a password-only session (no lock-out)...
  const weak = as(h, { id: "user-1", email: "planner@example.com", aal: "aal1", mfa: false });
  const refuse = await weak("PATCH", `/api/fleets/${h.fleetId}`, { require_mfa: true });
  assert.equal(refuse.status, 400);
  // ...but can from a verified one, and then password-only sessions are refused.
  const strong = as(h, { id: "user-1", email: "planner@example.com", aal: "aal2", mfa: true });
  assert.equal((await strong<Fleet>("PATCH", `/api/fleets/${h.fleetId}`, { require_mfa: true })).data.require_mfa, true);
  const now = await weak("GET", `/api/fleets/${h.fleetId}/vehicles`);
  assert.deepEqual([now.status, now.error?.code], [403, "MFA_REQUIRED"]);
  assert.equal((await strong("GET", `/api/fleets/${h.fleetId}/vehicles`)).status, 200);
  const memberships = await weak<{ memberships: { require_mfa: boolean }[] }>("GET", "/api/me");
  assert.equal(memberships.data.memberships[0].require_mfa, true);

  // Platform admin actions need aal2 in live mode.
  const liveWeak = as(h, { id: "user-1", email: "planner@example.com", aal: "aal1", mfa: false }, "live");
  const adm = await liveWeak("GET", "/api/admin/partners");
  assert.deepEqual([adm.status, adm.error?.code], [403, "MFA_REQUIRED"]);
  const liveStrong = as(h, { id: "user-1", email: "planner@example.com", aal: "aal2", mfa: true }, "live");
  assert.equal((await liveStrong("GET", "/api/admin/partners")).status, 200);

  const log = await strong<AuditEntry[]>("GET", `/api/fleets/${h.fleetId}/audit`);
  assert.ok(log.data.some((e) => e.action === "fleet.mfa_required" && e.actor_email === "planner@example.com"));
});

test("rate limits, body size limits and security headers", async () => {
  const rl = new RateLimiter();
  const req = (path: string, init: RequestInit & { ip?: string } = {}) => new Request(`https://x.test${path}`, { ...init, headers: { "CF-Connecting-IP": init.ip ?? "203.0.113.9", ...(init.headers as Record<string, string> | undefined) } });
  const t0 = 1_000_000;
  for (let i = 0; i < 30; i++) assert.equal(await guard(req(`/api/pass/tok${i}`), rl, t0), null);
  const limited = await guard(req("/api/pass/tok31"), rl, t0);
  assert.equal(limited?.status, 429);
  assert.ok(Number(limited?.headers.get("Retry-After")) > 0);
  assert.equal(await guard(req("/api/pass/tok32", { ip: "198.51.100.7" }), rl, t0), null); // other clients unaffected
  assert.equal(await guard(req("/api/pass/tok33"), rl, t0 + 61_000), null); // window passes

  // Repeated OCPI requests with unknown credentials lock that client out for a while.
  for (let i = 0; i < 20; i++) noteOutcome(req("/ocpi/emsp/2.3.0/tokens"), new Response(null, { status: 401 }), rl, t0);
  assert.equal((await guard(req("/ocpi/emsp/2.3.0/tokens"), rl, t0 + 1000))?.status, 429);

  // Shared limits (Workers Rate Limiting bindings) count across isolates: a fresh in-memory limiter
  // (another isolate) still refuses once the shared count is over.
  const counts = new Map<string, number>();
  const binding = (max: number): RateLimitBinding => ({
    async limit({ key }) { const n = (counts.get(`${max}:${key}`) ?? 0) + 1; counts.set(`${max}:${key}`, n); return { success: n <= max }; },
  });
  const shared = sharedLimits({ RL_API: binding(3), RL_PUBLIC: binding(2), RL_OCPI: binding(5), RL_OCPI_AUTH: binding(2) });
  const ip2 = { ip: "192.0.2.44" };
  for (let i = 0; i < 3; i++) assert.equal(await guard(req("/api/me", ip2), new RateLimiter(), t0, shared), null);
  assert.equal((await guard(req("/api/me", ip2), new RateLimiter(), t0, shared))?.status, 429);
  assert.equal(await guard(req("/api/pass/a", { ip: "192.0.2.45" }), new RateLimiter(), t0, shared), null);
  assert.equal(await guard(req("/api/pass/b", { ip: "192.0.2.45" }), new RateLimiter(), t0, shared), null);
  assert.equal((await guard(req("/api/pass/c", { ip: "192.0.2.45" }), new RateLimiter(), t0, shared))?.status, 429);
  // OCPI auth failures seen elsewhere trip the shared limit; this isolate then blocks the client.
  const iso = new RateLimiter();
  const ocpiReq = () => req("/ocpi/emsp/2.3.0/tokens", { ip: "192.0.2.46" });
  for (let i = 0; i < 3; i++) await noteOutcome(ocpiReq(), new Response(null, { status: 401 }), iso, t0, shared);
  assert.equal((await guard(ocpiReq(), iso, t0 + 1000, shared))?.status, 429);
  // A failing binding fails open.
  const broken = sharedLimits({ RL_API: { limit: async () => { throw new Error("down"); } } });
  assert.equal(await guard(req("/api/me", { ip: "192.0.2.47" }), new RateLimiter(), t0, broken), null);
  assert.deepEqual(sharedLimits({ RL_API: "not a binding" }), { api: undefined, ocpi: undefined, publicToken: undefined, ocpiAuthFail: undefined });

  const big = await guard(req("/api/fleets", { method: "POST", headers: { "Content-Length": String(300 * 1024) } }), rl, t0);
  assert.equal(big?.status, 413);

  const h = withSecurityHeaders(new Response("{}", { headers: { "Content-Type": "application/json" } })).headers;
  assert.match(h.get("Strict-Transport-Security")!, /max-age=63072000/);
  assert.equal(h.get("X-Content-Type-Options"), "nosniff");
  assert.match(h.get("Content-Security-Policy")!, /default-src 'none'/);
  assert.equal(h.get("Cache-Control"), "no-store");
});

test("uploaded logos: scripts, handlers and external references are refused", () => {
  const svg = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;
  assert.equal(checkLogo(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/></svg>')), null);
  assert.match(checkLogo(svg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))!, /scripts/);
  assert.match(checkLogo(svg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))!, /scripts/);
  assert.match(checkLogo(svg('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>'))!, /scripts/);
  assert.match(checkLogo(svg('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>'))!, /scripts/);
  assert.match(checkLogo(`data:image/png;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`)!, /isn't a PNG/);
  assert.equal(checkLogo("https://cdn.example.co.uk/logo.svg"), null);
  assert.match(checkLogo("javascript:alert(1)")!, /https/);
});

test("invites addressed to someone only work for them; driver passes expire", async () => {
  const h = await harness();
  const inv = await h.api<FleetInvite>("POST", `/api/fleets/${h.fleetId}/invites`, { email: "jo@example.com", role: "viewer" });
  const sam = as(h, { id: "user-3", email: "sam@example.com", aal: "aal2" });
  const wrong = await sam("POST", `/api/invites/${inv.data.token}/accept`);
  assert.deepEqual([wrong.status, wrong.error?.code], [403, "INVITE_EMAIL_MISMATCH"]);
  const jo = as(h, { id: "user-2", email: "Jo@Example.com", aal: "aal2" });
  assert.equal((await jo("POST", `/api/invites/${inv.data.token}/accept`)).status, 200);

  const now = new Date("2026-10-21T12:00:00Z");
  assert.equal(passExpired({ end_at: "2026-10-15T12:00:00Z", updated_at: "2026-10-15T12:00:00Z", reservation_status: "FULFILLED" }, now), false);
  assert.equal(passExpired({ end_at: "2026-10-14T11:00:00Z", updated_at: "2026-10-14T11:00:00Z", reservation_status: "FULFILLED" }, now), true);
  assert.equal(passExpired({ end_at: "2026-10-25T12:00:00Z", updated_at: "2026-10-19T11:00:00Z", reservation_status: "CANCELED" }, now), true);
});

test("data rights: export without secrets, fleet deletion and account deletion", async () => {
  const h = await harness();
  // Terms must be accepted to create a fleet.
  const noTerms = await h.api("POST", "/api/fleets", { name: "Another fleet" });
  assert.deepEqual([noTerms.status, noTerms.error && (noTerms as { error: { message: string } }).error.message.length > 0], [400, true]);
  const fleet = await h.api<Fleet>("GET", `/api/fleets/${h.fleetId}`);
  assert.equal(fleet.data.terms_accepted_by, h.userId);

  await h.api("POST", `/api/fleets/${h.fleetId}/invites`, { email: "jo@example.com", role: "planner" });
  const exp = await h.api<{ vehicles: unknown[]; invites: Record<string, unknown>[]; bookings: Record<string, unknown>[]; audit_log: AuditEntry[] }>("GET", `/api/fleets/${h.fleetId}/export`);
  assert.equal(exp.status, 200);
  assert.equal(exp.data.vehicles.length, 5);
  assert.ok(exp.data.invites.every((i) => !("token" in i)));
  assert.ok(exp.data.audit_log.some((e) => e.action === "invite.create"));

  // Account deletion is refused while you're the only owner of the fleet.
  const del = await h.api("DELETE", "/api/me", { confirm: "planner@example.com" });
  assert.deepEqual([del.status, (del.error as { code?: string } | undefined)?.code], [409, "SOLE_OWNER"]);

  // Fleet deletion needs the name typed in.
  assert.equal((await h.api("DELETE", `/api/fleets/${h.fleetId}`, { confirm: "nope" })).status, 400);
  assert.equal((await h.api("DELETE", `/api/fleets/${h.fleetId}`, { confirm: "demo haulage" })).status, 200);
  assert.equal(h.store.data.vehicles.filter((v) => v.fleet_id === h.fleetId).length, 0);
  assert.ok(h.store.data.audit.some((e) => e.action === "fleet.delete" && e.fleet_id === null));

  // With no fleets left, the account can go; the audit log keeps the actions but not the email.
  const gone = await h.api("DELETE", "/api/me", { confirm: "planner@example.com" });
  assert.equal(gone.status, 200);
  assert.ok(h.store.data.audit.filter((e) => e.actor_id === h.userId).every((e) => e.actor_email === null));
});

test("admin: certificates show only while valid; company details are validated", async () => {
  const h = await harness();
  const cert = { scheme: "Cyber Essentials", certificate_number: "a1b2c3d4-0000-4000-8000-000000000001", issued_on: "2026-06-01", expires_on: "2027-06-01", certification_body: "Example Certification Ltd" };
  const saved = await h.api<{ verify_url: string }[]>("PUT", "/api/admin/certifications", { certifications: [cert, { ...cert, certificate_number: "OLD-2025-0001", issued_on: "2025-01-01", expires_on: "2026-01-01" }] });
  assert.equal(saved.status, 200);
  assert.match(saved.data[0].verify_url, /iasme\.co\.uk/);
  const cfg = await h.api<{ certifications: { certificate_number: string }[] }>("GET", "/api/config");
  assert.deepEqual(cfg.data.certifications.map((c) => c.certificate_number), [cert.certificate_number]);
  assert.equal((await h.api("PUT", "/api/admin/certifications", { certifications: [{ ...cert, scheme: "Made Up" }] })).status, 400);

  assert.equal((await h.api("PUT", "/api/admin/legal", { company_name: "Depotcharge Ltd", company_number: "bad number!" })).status, 400);
  const legal = await h.api<{ company_number: string }>("PUT", "/api/admin/legal", { company_name: "Depotcharge Ltd", company_number: "12 345 678", privacy_email: "privacy@depotcharge.example" });
  assert.equal(legal.data.company_number, "12345678");
  const report = await h.api<{ checks: { id: string; status: string }[] }>("GET", "/api/admin/compliance");
  assert.equal(report.data.checks.find((c) => c.id === "certificate")?.status, "pass");
  const ticked = await h.api<{ checks: { id: string; status: string; done_by: string }[] }>("PUT", "/api/admin/compliance/mfa-cloud", { done: true, note: "Cloudflare, Supabase, GitHub, Google Workspace" });
  assert.deepEqual(["pass", "planner@example.com"], [ticked.data.checks.find((c) => c.id === "mfa-cloud")?.status, ticked.data.checks.find((c) => c.id === "mfa-cloud")?.done_by]);
});

test("key rotation: the previous key still opens old values, and re-encryption moves them to the new key", async () => {
  const oldKey = Buffer.from(new Uint8Array(32).map((_, i) => 200 - i)).toString("base64");
  const newKey = Buffer.from(new Uint8Array(32).map((_, i) => i * 3 + 1)).toString("base64");
  const sealedOld = await sealSecret("partner-token", oldKey);
  assert.equal(await openSecret(sealedOld, newKey, oldKey), "partner-token");
  await assert.rejects(() => openSecret(sealedOld, newKey));
  const resealed = await sealSecret(await openSecret(sealedOld, newKey, oldKey), newKey);
  assert.equal(await openSecret(resealed, newKey), "partner-token");

  // The admin endpoint re-saves every stored operator credential with the current key.
  const h = await harness();
  await h.api("POST", "/api/admin/simulator/connect");
  const r = await h.api<{ tokens: number }>("POST", "/api/admin/security/reencrypt");
  assert.equal(r.status, 200);
  assert.equal(r.data.tokens, 1);
  assert.ok(h.store.data.audit.some((a: AuditEntry) => a.action === "security.reencrypt"));
});

test("account recovery: platform admins reset someone's two-step verification, with a reason, never their own", async () => {
  const h = await harness();
  // A colleague joins via an invite, so their email is known to the platform.
  const invite = await h.api<FleetInvite>("POST", `/api/fleets/${h.fleetId}/invites`, { email: "driver.desk@example.com", role: "planner" });
  const colleague = as(h, { id: "user-2", email: "driver.desk@example.com", aal: "aal2", mfa: true });
  assert.equal((await colleague("POST", `/api/invites/${invite.data.token}/accept`)).status, 200);

  const noReason = await h.api("POST", "/api/admin/users/reset-mfa", { email: "driver.desk@example.com" });
  assert.equal(noReason.status, 400);
  const self = await h.api("POST", "/api/admin/users/reset-mfa", { email: "planner@example.com", reason: "testing" });
  assert.equal(self.status, 400, "an admin can't reset their own second factor");
  const unknown = await h.api("POST", "/api/admin/users/reset-mfa", { email: "nobody@example.com", reason: "called back" });
  assert.equal(unknown.status, 404);
  const ok = await h.api<{ factors_removed: number }>("POST", "/api/admin/users/reset-mfa", { email: "Driver.Desk@example.com", reason: "Called back on the number in HR" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.factors_removed, 0); // demo mode: no Supabase Auth to call
  const entry = h.store.data.audit.find((a: AuditEntry) => a.action === "user.mfa_reset");
  assert.equal(entry?.target, "driver.desk@example.com");
  assert.equal(entry?.data?.reason, "Called back on the number in HR");

  // Planners (not platform admins) can't use it.
  const planner = as(h, { id: "user-2", email: "driver.desk@example.com", aal: "aal2", mfa: true });
  assert.equal((await planner("POST", "/api/admin/users/reset-mfa", { email: "planner@example.com", reason: "x" })).status, 403);
  // In live mode an admin without a second factor is refused.
  const liveAdmin = as(h, { id: h.userId, email: "planner@example.com", aal: "aal1", mfa: false }, "live");
  const refused = await liveAdmin("POST", "/api/admin/users/reset-mfa", { email: "driver.desk@example.com", reason: "x" });
  assert.equal(refused.status, 403);
  assert.equal(refused.error?.code, "MFA_REQUIRED");
});

test("outbound OCPI: no redirects, no oversized responses, pagination stays on the operator's host", async () => {
  const ctx = createLocalCtx({ store: new MemoryStore(), mode: "live" });
  const seen: string[] = [];
  const page = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
  ctx.transport = async (req) => {
    seen.push(req.url);
    assert.equal(req.redirect, "manual");
    if (req.url.includes("/redirect")) return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
    if (req.url.includes("/huge")) return new Response("x".repeat(11 * 1024 * 1024), { status: 200 });
    if (req.url.includes("/page1")) return page({ data: [{ id: "a" }], status_code: 1000, timestamp: "2026-10-21T00:00:00Z" }, { Link: '<https://attacker.example/steal>; rel="next"' });
    return page({ data: [], status_code: 1000, timestamp: "2026-10-21T00:00:00Z" });
  };
  const redirected = await ocpiCall(ctx, { method: "GET", url: "https://cpo.example/redirect", token: "t", log: false });
  assert.equal(redirected.ok, false);
  assert.match(redirected.error ?? "", /redirect/i);
  const huge = await ocpiCall(ctx, { method: "GET", url: "https://cpo.example/huge", token: "t", log: false });
  assert.equal(huge.ok, false);
  assert.match(huge.error ?? "", /larger than/);
  const pulled = await ocpiPullAll(ctx, { url: "https://cpo.example/page1", token: "t", log: false });
  assert.equal(pulled.ok, false);
  assert.ok(!seen.some((u) => u.includes("attacker.example")), "never calls a host the operator didn't register");
});

test("driver pass links can be revoked: a reset issues a new link and the old one stops working", async () => {
  const h = await harness();
  // Book through the simulator-backed network like the flow tests do.
  await h.api("POST", "/api/admin/simulator/connect");
  const vehicles = await h.api<{ id: string; name: string }[]>("GET", `/api/fleets/${h.fleetId}/vehicles`);
  const network = await h.api<{ booking_locations: { country_code: string; party_id: string; id: string }[] }>("GET", "/api/network");
  const bl = network.data.booking_locations[0];
  const start = new Date(h.clock.now.getTime() + 26 * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  const created = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings`, {
    vehicle_id: vehicles.data.find((v) => v.name === "Tractor 01")!.id, cpo_country_code: bl.country_code, cpo_party_id: bl.party_id,
    booking_location_id: bl.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + 3_600_000).toISOString(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.error));
  const oldToken = created.data.pass_token;
  assert.equal((await h.api("GET", `/api/pass/${oldToken}`)).status, 200);
  const reset = await h.api<BookingRow>("POST", `/api/fleets/${h.fleetId}/bookings/${created.data.id}/pass`);
  assert.equal(reset.status, 200);
  assert.notEqual(reset.data.pass_token, oldToken);
  assert.equal((await h.api("GET", `/api/pass/${oldToken}`)).status, 404, "the old link is dead");
  assert.equal((await h.api("GET", `/api/pass/${reset.data.pass_token}`)).status, 200);
  assert.ok(h.store.data.audit.some((a: AuditEntry) => a.action === "booking.pass_reset"));
});

test("database errors never reach users, even when they carry a 4xx status", async () => {
  const { harness } = await import("./helpers");
  const h = await harness();
  h.store.listVehicles = async () => { throw Object.assign(new Error("permission denied for table vehicles"), { status: 403, internal: true }); };
  const r = await h.api("GET", `/api/fleets/${h.fleetId}/vehicles`);
  assert.equal(r.status, 500);
  assert.match(r.error!.message, /^Something went wrong on our side \(reference [0-9a-f]{8}\)$/);
  assert.doesNotMatch(r.error!.message, /permission|table/);
});
