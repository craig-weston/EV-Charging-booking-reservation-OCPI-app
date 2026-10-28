// JSON API used by the web app (same origin). Auth: `Authorization: Bearer <Supabase access token>`.
// The service-role store is used server-side, so every fleet route checks membership explicitly.
import type { BookingLocation, CanceledReason, ConnectorType, Location, VehicleType } from "../../shared/ocpi/types";
import type {
  ApiKey, AppConfig, AuditEntry, Brand, BookingRow, Certification, Driver, Fleet, FleetInvite, InvitePreview, LegalInfo, MemberRole, NetworkSnapshot, PassView, Partner, TeamView, Vehicle,
} from "../../shared/model";
import { DEFAULT_BRAND, EMPTY_LEGAL, type Readiness, type ReadinessCheck } from "../../shared/model";
import { FLEET_CANCEL_REASONS } from "../../shared/booking/labels";
import { displayPlate, iso, normalizePlate, randomToken, shortId, upper, uuid } from "../../shared/util";
import { PASSWORD_MIN_LENGTH, TERMS_VERSION, adminMfaRequired, brandFromEnv, legalFromEnv, ocpiUrls, type AuthUser, type Ctx } from "../context";
import { ApiError, cancelBooking, changeBooking, createBooking, operatorName } from "../emsp/service";
import { invitePartner, newRegistrationToken, registerWithPartner, syncPartner, unregisterPartner } from "../ocpi/registration";
import { probeOperator } from "../ocpi/probe";
import { simControl, simPrepareRegistration, simStatus, tick, type SimAction } from "../sim/cpo";
import { API_KEY_PREFIX, BODY_LIMITS, BodyTooLarge, checkLogo, clientIp, hint, isApiKey, readLimited, sha256Hex } from "../security";
import { complianceReport, saveTick } from "./compliance";
import { sampleDrivers, sampleVehicles } from "./samples";
import { notifyChannels, notifyDriver } from "../notify";
import { redactPath, reportError, scrub } from "../alerts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const err = (status: number, message: string, code?: string) =>
  new Response(JSON.stringify({ error: { message, code } }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function body<T>(req: Request): Promise<T> {
  let text: string;
  try {
    text = await readLimited(req, BODY_LIMITS.api);
  } catch (e) {
    if (e instanceof BodyTooLarge) throw new ApiError(413, e.message, "TOO_LARGE");
    throw new ApiError(400, "Couldn't read the request");
  }
  try {
    const v = JSON.parse(text) as T;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw new ApiError(400, "Expected a JSON object body");
  }
}

/** Security-relevant actions go to the audit log. Logging must never break the request. */
async function audit(ctx: Ctx, req: Request, user: AuthUser | null, e: { fleet_id?: string | null; action: string; target?: string | null; data?: Record<string, unknown> | null }) {
  const entry: AuditEntry = {
    id: uuid(), at: iso(ctx.now()), actor_id: user?.id ?? null,
    actor_email: user?.apiKey ? `API key: ${user.apiKey.name}` : user?.email ?? null, fleet_id: e.fleet_id ?? null,
    action: e.action, target: e.target ?? null, data: e.data ?? null, ip: ctx.mode === "live" ? clientIp(req) : null,
  };
  try { await ctx.store.addAudit(entry); } catch (err) { console.error("audit log write failed", err); }
}

const MFA_HELP = "Set up two-step verification in Settings → Security, then sign in again.";

/**
 * A request carrying a fleet API key (`Authorization: Bearer fck_…` or `X-API-Key: fck_…`) acts as
 * that key: a planner or viewer of one fleet, with no person signed in. Returns null when the
 * request has no API key, and "invalid" for an unknown, revoked or expired one.
 */
async function apiKeyUser(ctx: Ctx, req: Request): Promise<AuthUser | "invalid" | null> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1] ?? "";
  const raw = (bearer.startsWith(API_KEY_PREFIX) ? bearer : req.headers.get("X-API-Key") ?? "").trim();
  if (!raw) return null;
  if (!isApiKey(raw)) return "invalid";
  const row = await ctx.store.findApiKeyByHash(await sha256Hex(raw));
  const now = ctx.now();
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) <= now)) return "invalid";
  // "Last used" is for spotting forgotten keys, so it only needs to be roughly right.
  if (!row.last_used_at || now.getTime() - new Date(row.last_used_at).getTime() > 10 * 60_000) {
    ctx.waitUntil(ctx.store.updateApiKey(row.id, { last_used_at: iso(now) }).catch((e) => console.warn("api key last_used_at", e)));
  }
  return { id: row.id, email: null, aal: "aal1", mfa: false, apiKey: { id: row.id, fleet_id: row.fleet_id, name: row.name, role: row.role } };
}

/** What an API key may reach: the network, and its own fleet's vehicles, drivers and bookings. */
function apiKeyAllows(key: NonNullable<AuthUser["apiKey"]>, method: string, seg: string[]): boolean {
  if (seg[0] === "network" && seg.length === 1 && method === "GET") return true;
  if (seg[0] !== "fleets" || seg[1] !== key.fleet_id) return false;
  if (seg.length === 2) return method === "GET";
  return ["vehicles", "drivers", "bookings"].includes(seg[2]);
}

async function clientError(ctx: Ctx, req: Request): Promise<{ ref: string }> {
  const b = await body<{ message?: unknown; name?: unknown; source?: unknown; page?: unknown; release?: unknown }>(req).catch(() => ({} as Record<string, unknown>));
  const ref = uuid().slice(0, 8);
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  const error = Object.assign(new Error(scrub(str(b.message, 500)) || "(no message)"), { name: str(b.name, 60) || "Error" });
  const page = redactPath(str(b.page, 200));
  console.warn(`Browser error [${ref}] ${error.name}: ${error.message} on ${page} (${scrub(str(b.source, 200))}, release ${str(b.release, 40)})`);
  reportError({ env: ctx.env, waitUntil: (p) => ctx.waitUntil(p), fetch: (r) => ctx.transport(r) }, { where: "browser", ref, error, path: page });
  return { ref };
}

export async function handleApi(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    // ---- public
    if (seg[0] === "config" && req.method === "GET") return json(await config(ctx));
    if (seg[0] === "pass" && seg[1] && req.method === "GET") return json(await passView(ctx, seg[1]));
    if (seg[0] === "health") return json({ ok: true, mode: ctx.mode, time: iso(ctx.now()) });
    // Errors from the app in people's browsers (src/app/errors.ts). Rate limited in server/live.ts.
    if (seg[0] === "client-errors" && req.method === "POST") return json(await clientError(ctx, req), 202);
    // Invite preview works signed out too, so the sign-in screen can say what you're joining.
    if (seg[0] === "invites" && seg[1] && !seg[2] && req.method === "GET") {
      return json(await invitePreview(ctx, seg[1], await ctx.verifyUser(req).catch(() => null)));
    }

    // ---- authenticated (a person's session, or a fleet API key)
    const keyUser = await apiKeyUser(ctx, req);
    if (keyUser === "invalid") return err(401, "This API key isn't valid. It may have been revoked or expired.", "INVALID_API_KEY");
    if (keyUser?.apiKey && !apiKeyAllows(keyUser.apiKey, req.method, seg)) {
      return err(403, "API keys can read the network and work with their own fleet's vehicles, drivers and bookings only", "API_KEY_SCOPE");
    }
    const user = keyUser ?? (await ctx.verifyUser(req));
    if (!user) return err(401, "Please sign in again", "UNAUTHENTICATED");
    // An account with a second factor must use it: a password alone is not enough.
    if (user.mfa && user.aal !== "aal2" && !(seg[0] === "me" && req.method === "GET")) {
      return err(401, "Enter the code from your authenticator app to continue", "MFA_CHALLENGE");
    }

    if (seg[0] === "invites" && seg[1] && seg[2] === "accept" && req.method === "POST") return json(await acceptInvite(ctx, req, user, seg[1]));

    if (seg[0] === "me" && req.method === "GET") {
      const isAdmin = await ctx.store.isPlatformAdmin(user.id);
      return json({
        user: { id: user.id, email: user.email },
        memberships: await ctx.store.getMemberships(user.id),
        is_admin: isAdmin,
        mfa: { enrolled: !!user.mfa, aal: user.aal ?? "aal1", admin_required: isAdmin && adminMfaRequired(ctx) },
      });
    }
    if (seg[0] === "me" && req.method === "DELETE") return json(await deleteAccount(ctx, req, user));
    if (seg[0] === "fleets" && seg.length === 1 && req.method === "POST") {
      const b = await body<{ name: string; sample?: boolean; accept_terms?: boolean }>(req);
      const name = (b.name ?? "").trim();
      if (!name) throw new ApiError(400, "Give your fleet a name");
      if (b.accept_terms !== true) throw new ApiError(400, "Accept the terms of service and data processing terms to create a fleet", "TERMS_REQUIRED");
      const fleet = await ctx.store.createFleet(name.slice(0, 120), { id: user.id, email: user.email });
      const accepted = await ctx.store.updateFleet(fleet.id, { terms_version: TERMS_VERSION, terms_accepted_at: iso(ctx.now()), terms_accepted_by: user.id });
      await audit(ctx, req, user, { fleet_id: fleet.id, action: "fleet.create", target: fleet.name, data: { terms_version: TERMS_VERSION } });
      if (b.sample) await addSamples(ctx, fleet.id);
      return json(accepted, 201);
    }
    // `return await` so errors thrown in the sub-routers reach the catch below.
    if (seg[0] === "fleets" && seg[1]) return await fleetRoutes(req, ctx, user, seg[1], seg.slice(2), url);
    if (seg[0] === "network" && req.method === "GET") return json(await network(ctx));
    if (seg[0] === "admin") {
      if (!(await ctx.store.isPlatformAdmin(user.id))) return err(403, "Platform admins only", "FORBIDDEN");
      if (adminMfaRequired(ctx) && user.aal !== "aal2") return err(403, `Platform admin actions need two-step verification. ${MFA_HELP}`, "MFA_REQUIRED");
      return await adminRoutes(req, ctx, user, seg.slice(1), url);
    }
    return err(404, "Not found");
  } catch (e) {
    if (e instanceof ApiError) return err(e.status, e.message, e.code);
    const status = (e as { status?: number }).status;
    // Database errors carry an HTTP status too, but their text is for the server log, never users.
    if (status && status >= 400 && status < 500 && !(e as { internal?: boolean }).internal) return err(status, (e as Error).message);
    // Internal details (database errors, stack traces) stay in the server log.
    const ref = uuid().slice(0, 8);
    console.error(`API error [${ref}]`, e);
    reportError({ env: ctx.env, waitUntil: (p) => ctx.waitUntil(p), fetch: (r) => ctx.transport(r) }, { where: "api", ref, error: e, method: req.method, path: url.pathname });
    return err(500, `Something went wrong on our side (reference ${ref})`, "INTERNAL");
  }
}

// ------------------------------------------------------------------ public
async function config(ctx: Ctx): Promise<AppConfig> {
  const [savedBrand, legal, certs] = await Promise.all([
    ctx.store.getBrand().catch(() => null),
    legalInfo(ctx),
    ctx.store.getSetting<Certification[]>("certifications").catch(() => null),
  ]);
  const today = iso(ctx.now()).slice(0, 10);
  return {
    mode: ctx.mode,
    supabase_url: ctx.env.SUPABASE_URL ?? null,
    supabase_anon_key: ctx.env.SUPABASE_ANON_KEY ?? null,
    simulator: ctx.simulatorEnabled,
    party: ctx.party,
    brand: { ...DEFAULT_BRAND, ...brandFromEnv(ctx.env), ...(savedBrand ?? {}) },
    ocpi_versions_url: ocpiUrls(ctx.baseUrl).versions,
    legal,
    // A certificate is shown only while it is valid.
    certifications: (certs ?? []).filter((c) => c.issued_on <= today && c.expires_on >= today),
    terms_version: TERMS_VERSION,
    security: { require_admin_mfa: adminMfaRequired(ctx), password_min_length: PASSWORD_MIN_LENGTH },
    notifications: notifyChannels(ctx.env, ctx.mode),
  };
}

async function legalInfo(ctx: Ctx): Promise<LegalInfo> {
  const saved = await ctx.store.getSetting<Partial<LegalInfo>>("legal").catch(() => null);
  const env = legalFromEnv(ctx.env);
  const out = { ...EMPTY_LEGAL };
  for (const k of Object.keys(out) as (keyof LegalInfo)[]) out[k] = (saved?.[k] || env[k] || EMPTY_LEGAL[k]) as string;
  return out;
}

/** Driver pass links stop working a while after they're needed: 7 days after the slot, 2 days after a cancellation. */
export function passExpired(b: Pick<BookingRow, "end_at" | "updated_at" | "reservation_status">, now: Date): boolean {
  const closed = ["CANCELED", "REJECTED", "FAILED", "NO_SHOW"].includes(b.reservation_status);
  const until = closed ? new Date(b.updated_at).getTime() + 2 * 86_400_000 : new Date(b.end_at).getTime() + 7 * 86_400_000;
  return now.getTime() > until;
}

async function passView(ctx: Ctx, token: string): Promise<PassView> {
  const b = await ctx.store.findBookingByPassToken(token);
  if (!b) throw new ApiError(404, "This pass link isn't valid any more");
  if (passExpired(b, ctx.now())) throw new ApiError(410, "This pass has expired. Ask your fleet desk for a new one if you still need it.", "PASS_EXPIRED");
  const [vehicle, driver, fleet, locObj, brandRow] = await Promise.all([
    b.vehicle_id ? ctx.store.getVehicle(b.vehicle_id) : null,
    b.driver_id ? ctx.store.getDriver(b.driver_id) : null,
    ctx.store.getFleet(b.fleet_id),
    ctx.store.getObject<Location>("locations", b.cpo_country_code, b.cpo_party_id, b.location_id),
    ctx.store.getBrand().catch(() => null),
  ]);
  const loc = locObj?.data;
  const partner = b.partner_id ? await ctx.store.getPartner(b.partner_id) : null;
  const evse = b.evse_uid ? loc?.evses?.find((e) => e.uid === b.evse_uid) : null;
  return {
    brand: { ...DEFAULT_BRAND, ...brandFromEnv(ctx.env), ...(brandRow ?? {}) },
    status: b.reservation_status,
    pending_action: b.pending_action,
    start_at: b.start_at,
    end_at: b.end_at,
    plate: b.plate,
    vehicle_name: vehicle?.name ?? null,
    vehicle_type: vehicle?.vehicle_type ?? null,
    start_method: vehicle?.start_method ?? null,
    power_kw: b.power_required_kw ?? null,
    driver_name: driver?.name ?? null,
    fleet_name: fleet?.name ?? "",
    desk_phone: fleet?.desk_phone ?? null,
    site: {
      name: loc?.name ?? b.location_id, address: loc?.address ?? "", city: loc?.city ?? "", postal_code: loc?.postal_code ?? null,
      lat: Number(loc?.coordinates.latitude ?? 0), lon: Number(loc?.coordinates.longitude ?? 0), time_zone: loc?.time_zone ?? "Europe/London",
      operator: operatorName(partner, b.cpo_country_code, b.cpo_party_id, loc), help_phone: loc?.help_phone ?? null,
      directions: loc?.directions?.find((d) => d.language === "en")?.text ?? loc?.directions?.[0]?.text ?? null,
    },
    bay: evse ? (evse.physical_reference ?? evse.evse_id ?? null) : null,
    access_methods: b.booking?.booking_terms?.supported_access_methods ?? [],
    terms: b.booking?.booking_terms ?? null,
    session: b.session,
  };
}

// ------------------------------------------------------------------ fleets
async function requireMember(ctx: Ctx, user: AuthUser, fleetId: string, write: boolean): Promise<MemberRole> {
  if (user.apiKey) {
    if (user.apiKey.fleet_id !== fleetId) throw new ApiError(404, "Fleet not found");
    if (write && user.apiKey.role === "viewer") throw new ApiError(403, "This API key is read-only");
    return user.apiKey.role;
  }
  const m = (await ctx.store.getMemberships(user.id)).find((x) => x.fleet_id === fleetId);
  if (!m) throw new ApiError(404, "Fleet not found");
  if (write && m.role === "viewer") throw new ApiError(403, "Your role is view-only");
  return m.role;
}

const VEHICLE_TYPES: VehicleType[] = ["TRUCK_WITH_TRAILER", "SEMI_TRACTOR", "RIGID", "VAN", "BUS"];

function cleanVehicle(ctx: Ctx, fleetId: string, input: Partial<Vehicle>, existing: Vehicle | null): Vehicle {
  const name = (input.name ?? existing?.name ?? "").trim();
  const plate = displayPlate(input.plate ?? existing?.plate ?? "");
  if (!name) throw new ApiError(400, "Vehicle name is required");
  if (!normalizePlate(plate)) throw new ApiError(400, "Number plate is required");
  const vehicle_type = (input.vehicle_type ?? existing?.vehicle_type ?? "TRUCK_WITH_TRAILER") as VehicleType;
  if (!VEHICLE_TYPES.includes(vehicle_type)) throw new ApiError(400, "Unknown vehicle type");
  const start_method = input.start_method ?? existing?.start_method ?? "PLUG_AND_CHARGE";
  const token_uid = (input.token_uid ?? existing?.token_uid ?? "").trim().toUpperCase();
  if (!token_uid) throw new ApiError(400, start_method === "AUTOCHARGE" ? "Autocharge vehicle ID is required" : "Plug & Charge contract ID (EMAID) is required");
  if (token_uid.length > 36) throw new ApiError(400, "Charging ID must be at most 36 characters");
  const connectors = (input.connector_types ?? existing?.connector_types ?? ["IEC_62196_T2_COMBO"]) as ConnectorType[];
  if (!connectors.length) throw new ApiError(400, "Pick at least one connector");
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Math.max(0, Math.round(Number(v))) || null);
  const now = iso(ctx.now());
  return {
    id: existing?.id ?? uuid(),
    fleet_id: fleetId,
    name: name.slice(0, 60),
    plate,
    make_model: (input.make_model ?? existing?.make_model ?? null)?.toString().slice(0, 80) || null,
    vehicle_type,
    gross_weight_kg: num(input.gross_weight_kg ?? existing?.gross_weight_kg),
    height_cm: num(input.height_cm ?? existing?.height_cm),
    length_cm: num(input.length_cm ?? existing?.length_cm),
    width_cm: num(input.width_cm ?? existing?.width_cm),
    connector_types: connectors,
    max_charge_kw: num(input.max_charge_kw ?? existing?.max_charge_kw),
    battery_kwh: num(input.battery_kwh ?? existing?.battery_kwh),
    start_method,
    token_uid,
    contract_id: (input.contract_id ?? existing?.contract_id ?? "").trim().toUpperCase() || `${ctx.party.country_code}-${ctx.party.party_id}-${shortId("C", 9)}`,
    dangerous_goods: !!(input.dangerous_goods ?? existing?.dangerous_goods),
    needs_reefer_outlet: !!(input.needs_reefer_outlet ?? existing?.needs_reefer_outlet),
    active: input.active ?? existing?.active ?? true,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

async function addSamples(ctx: Ctx, fleetId: string) {
  for (const v of sampleVehicles(fleetId, ctx.party.country_code, ctx.party.party_id)) {
    const taken = await ctx.store.findVehicleByToken(v.token_uid);
    await ctx.store.upsertVehicle(taken ? { ...v, token_uid: `${v.token_uid.slice(0, 26)}${shortId("", 6)}` } : v);
  }
  for (const d of sampleDrivers(fleetId)) await ctx.store.upsertDriver(d);
}

async function fleetRoutes(req: Request, ctx: Ctx, user: AuthUser, fleetId: string, seg: string[], url: URL): Promise<Response> {
  const m = req.method;
  const write = m !== "GET";
  const role = await requireMember(ctx, user, fleetId, false);
  const fleet = await ctx.store.getFleet(fleetId);
  if (!fleet) throw new ApiError(404, "Fleet not found");
  // The fleet's own policy: everyone on the team signs in with a second factor.
  // (An API key was created by an owner who met that policy; keys are revoked in Settings.)
  if (fleet.require_mfa && !user.apiKey && user.aal !== "aal2") throw new ApiError(403, `${fleet.name} requires two-step verification. ${MFA_HELP}`, "MFA_REQUIRED");
  const [res, id, action] = seg;
  // Team routes check roles themselves (anyone may leave; only owners manage the team).
  if (res === "team" || res === "members" || res === "invites") return teamRoutes(req, ctx, user, fleetId, role, res, id);
  if (res === "api-keys") return apiKeyRoutes(req, ctx, user, fleetId, role, id);
  if (write && role === "viewer") throw new ApiError(403, user.apiKey ? "This API key is read-only" : "Your role is view-only");

  if (!res) {
    if (m === "GET") return json(fleet);
    if (m === "PATCH") {
      if (role !== "owner") throw new ApiError(403, "Only the fleet owner can change fleet settings");
      const b = await body<Partial<Fleet> & { accept_terms?: boolean }>(req);
      const patch: Partial<Fleet> = {};
      if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 120);
      if (b.desk_phone !== undefined) patch.desk_phone = (b.desk_phone ?? "").toString().slice(0, 30) || null;
      if (typeof b.allow_unbooked_charging === "boolean") patch.allow_unbooked_charging = b.allow_unbooked_charging;
      if (b.notify_drivers !== undefined && b.notify_drivers !== fleet.notify_drivers) {
        if (!["off", "sms", "whatsapp"].includes(b.notify_drivers)) throw new ApiError(400, "Choose off, sms or whatsapp");
        if (b.notify_drivers !== "off" && !notifyChannels(ctx.env, ctx.mode)[b.notify_drivers]) throw new ApiError(400, "Messaging isn't set up on this platform yet. Ask your platform admin to add the Twilio settings.", "NOTIFY_UNAVAILABLE");
        patch.notify_drivers = b.notify_drivers;
      }
      if (typeof b.require_mfa === "boolean" && b.require_mfa !== fleet.require_mfa) {
        // Turning it on from a session without a second factor would lock the owner out.
        if (b.require_mfa && user.aal !== "aal2") throw new ApiError(400, "Set up two-step verification for your own account first (Settings → Security)", "MFA_REQUIRED");
        patch.require_mfa = b.require_mfa;
      }
      if (b.accept_terms === true) Object.assign(patch, { terms_version: TERMS_VERSION, terms_accepted_at: iso(ctx.now()), terms_accepted_by: user.id });
      const saved = await ctx.store.updateFleet(fleetId, patch);
      const changed = Object.keys(patch).filter((k) => !k.startsWith("terms_"));
      if (patch.require_mfa !== undefined) await audit(ctx, req, user, { fleet_id: fleetId, action: patch.require_mfa ? "fleet.mfa_required" : "fleet.mfa_optional" });
      if (b.accept_terms === true) await audit(ctx, req, user, { fleet_id: fleetId, action: "fleet.terms_accepted", data: { terms_version: TERMS_VERSION } });
      if (changed.some((k) => k !== "require_mfa")) await audit(ctx, req, user, { fleet_id: fleetId, action: "fleet.update", data: { fields: changed.filter((k) => k !== "require_mfa") } });
      return json(saved);
    }
    if (m === "DELETE") {
      if (role !== "owner") throw new ApiError(403, "Only the fleet owner can delete the fleet");
      const b = await body<{ confirm?: string }>(req);
      if ((b.confirm ?? "").trim().toLowerCase() !== fleet.name.trim().toLowerCase()) throw new ApiError(400, "Type the fleet's name to confirm");
      const open = (await ctx.store.listBookings(fleetId, { from: iso(ctx.now()), limit: 500 }))
        .filter((x) => x.reservation_status === "PENDING" || x.reservation_status === "RESERVED" || x.session?.status === "ACTIVE");
      if (open.length) throw new ApiError(409, `Cancel or finish the ${open.length} upcoming booking${open.length === 1 ? "" : "s"} first, so operators release the bays.`, "OPEN_BOOKINGS");
      await audit(ctx, req, user, { fleet_id: null, action: "fleet.delete", target: fleet.name, data: { fleet_id: fleetId } });
      await ctx.store.deleteFleet(fleetId);
      return json({ ok: true });
    }
  }

  if (res === "export" && m === "GET") {
    if (role !== "owner") throw new ApiError(403, "Only the fleet owner can export the fleet's data");
    const [members, invites, vehicles, drivers, bookings, events, auditLog] = await Promise.all([
      ctx.store.listMembers(fleetId), ctx.store.listInvites(fleetId), ctx.store.listVehicles(fleetId), ctx.store.listDrivers(fleetId),
      ctx.store.listBookings(fleetId, { limit: 100_000 }), ctx.store.listEvents(fleetId, { limit: 100_000 }), ctx.store.listAudit({ fleetId, limit: 10_000 }),
    ]);
    await audit(ctx, req, user, { fleet_id: fleetId, action: "fleet.export" });
    return json({
      exported_at: iso(ctx.now()), format: "depotcharge-export/1", fleet, members,
      invites: invites.map(({ token: _t, ...rest }) => rest), vehicles, drivers,
      bookings: bookings.map(({ pass_token: _p, ...rest }) => rest), booking_events: events, audit_log: auditLog,
    });
  }

  if (res === "audit" && m === "GET") {
    if (role !== "owner") throw new ApiError(403, "Only fleet owners can see the activity log");
    return json(await ctx.store.listAudit({ fleetId, limit: Math.min(500, Number(url.searchParams.get("limit") ?? 200) || 200) }));
  }

  if (res === "samples" && m === "POST") {
    await addSamples(ctx, fleetId);
    return json({ ok: true }, 201);
  }

  if (res === "vehicles") {
    if (!id && m === "GET") return json(await ctx.store.listVehicles(fleetId));
    if (!id && m === "POST") return json(await ctx.store.upsertVehicle(cleanVehicle(ctx, fleetId, await body(req), null)), 201);
    const existing = id ? await ctx.store.getVehicle(id) : null;
    if (!existing || existing.fleet_id !== fleetId) throw new ApiError(404, "Vehicle not found");
    if (m === "PUT") return json(await ctx.store.upsertVehicle(cleanVehicle(ctx, fleetId, await body(req), existing)));
    if (m === "DELETE") {
      await ctx.store.deleteVehicle(existing.id);
      await audit(ctx, req, user, { fleet_id: fleetId, action: "vehicle.delete", target: existing.plate });
      return json({ ok: true });
    }
  }

  if (res === "drivers") {
    if (!id && m === "GET") return json(await ctx.store.listDrivers(fleetId));
    const existing = id ? await ctx.store.getDriver(id) : null;
    if (id && (!existing || existing.fleet_id !== fleetId)) throw new ApiError(404, "Driver not found");
    if ((!id && m === "POST") || (id && m === "PUT")) {
      const b = await body<Partial<Driver>>(req);
      const name = (b.name ?? existing?.name ?? "").trim();
      if (!name) throw new ApiError(400, "Driver name is required");
      const now = iso(ctx.now());
      const d: Driver = { id: existing?.id ?? uuid(), fleet_id: fleetId, name: name.slice(0, 80), phone: (b.phone ?? existing?.phone ?? "")?.toString().slice(0, 30) || null, created_at: existing?.created_at ?? now, updated_at: now };
      return json(await ctx.store.upsertDriver(d), existing ? 200 : 201);
    }
    if (id && m === "DELETE") {
      await ctx.store.deleteDriver(id);
      await audit(ctx, req, user, { fleet_id: fleetId, action: "driver.delete", target: existing?.name ?? id });
      return json({ ok: true });
    }
  }

  if (res === "bookings") {
    if (!id && m === "GET") {
      await maybeTick(ctx);
      const from = url.searchParams.get("from") ?? undefined;
      const to = url.searchParams.get("to") ?? undefined;
      const [bookings, events] = await Promise.all([
        ctx.store.listBookings(fleetId, { from, to, limit: 500 }),
        ctx.store.listEvents(fleetId, { limit: 300 }),
      ]);
      return json({ bookings, events, server_time: iso(ctx.now()) });
    }
    if (!id && m === "POST") {
      const b = await body<{ vehicle_id: string; driver_id?: string | null; cpo_country_code: string; cpo_party_id: string; booking_location_id: string; start_at: string; end_at: string; power_required_kw?: number | null; notes?: string | null }>(req);
      const vehicle = await ctx.store.getVehicle(b.vehicle_id);
      if (!vehicle || vehicle.fleet_id !== fleetId) throw new ApiError(404, "Vehicle not found");
      if (!vehicle.active) throw new ApiError(409, "This vehicle is inactive");
      if (b.driver_id) {
        const d = await ctx.store.getDriver(b.driver_id);
        if (!d || d.fleet_id !== fleetId) throw new ApiError(404, "Driver not found");
      }
      const row = await createBooking(ctx, {
        fleet_id: fleetId, user_id: user.apiKey ? null : user.id, api_key_id: user.apiKey?.id ?? null, vehicle, driver_id: b.driver_id ?? null, cpo_country_code: b.cpo_country_code,
        cpo_party_id: b.cpo_party_id, booking_location_id: b.booking_location_id, start_at: b.start_at, end_at: b.end_at,
        power_required_kw: b.power_required_kw ?? null, notes: b.notes ?? null,
      });
      return json(row, 201);
    }
    const row = id ? await ctx.store.getBooking(id) : null;
    if (!row || row.fleet_id !== fleetId) throw new ApiError(404, "Booking not found");
    if (m === "GET" && !action) return json(row);
    if (m === "PATCH" && !action) {
      const b = await body<{ driver_id?: string | null; notes?: string | null }>(req);
      const patch: Partial<BookingRow> = {};
      if (b.driver_id !== undefined) {
        if (b.driver_id) {
          const d = await ctx.store.getDriver(b.driver_id);
          if (!d || d.fleet_id !== fleetId) throw new ApiError(404, "Driver not found");
        }
        patch.driver_id = b.driver_id || null;
      }
      if (b.notes !== undefined) patch.notes = (b.notes ?? "").toString().slice(0, 500) || null;
      const saved = await ctx.store.updateBooking(row.id, patch);
      if (patch.driver_id !== undefined) ctx.waitUntil(notifyDriver(ctx, row.id));
      return json(saved);
    }
    // A driver pass link is a bearer link: issuing a new one revokes the old straight away.
    if (m === "POST" && action === "pass") {
      const saved = await ctx.store.updateBooking(row.id, { pass_token: randomToken(24) });
      ctx.waitUntil(notifyDriver(ctx, row.id)); // the driver gets the new link (if messages are on)
      await audit(ctx, req, user, { fleet_id: fleetId, action: "booking.pass_reset", target: row.plate, data: { booking_id: row.id } });
      return json(saved);
    }
    const vehicle = row.vehicle_id ? await ctx.store.getVehicle(row.vehicle_id) : null;
    if (m === "POST" && action === "change") {
      if (!vehicle) throw new ApiError(409, "The vehicle for this booking was deleted");
      const b = await body<{ start_at: string; end_at: string; power_required_kw?: number | null }>(req);
      if (!b.start_at || !b.end_at || !(new Date(b.end_at) > new Date(b.start_at))) throw new ApiError(400, "Pick a valid new time");
      return json(await changeBooking(ctx, row, vehicle, b.start_at, b.end_at, b.power_required_kw));
    }
    if (m === "POST" && action === "cancel") {
      const b = await body<{ reason?: CanceledReason }>(req);
      const reason = FLEET_CANCEL_REASONS.includes(b.reason as CanceledReason) ? (b.reason as CanceledReason) : "NO_CANCELED";
      const v = vehicle ?? ({ ...({} as Vehicle), plate: row.plate, token_uid: row.token_uid, start_method: row.token_type === "EMAID" ? "PLUG_AND_CHARGE" : "AUTOCHARGE", connector_types: [], vehicle_type: "TRUCK_WITH_TRAILER", contract_id: row.last_request.tokens?.[0]?.contract_id ?? "" } as Vehicle);
      return json(await cancelBooking(ctx, row, v, reason));
    }
  }
  return err(404, "Not found");
}

// ------------------------------------------------------------------ API keys
const MAX_ACTIVE_KEYS = 20;

async function apiKeyRoutes(req: Request, ctx: Ctx, user: AuthUser, fleetId: string, role: MemberRole, id: string | undefined): Promise<Response> {
  const m = req.method;
  if (user.apiKey || role !== "owner") throw new ApiError(403, "Only fleet owners can manage API keys");
  if (!id && m === "GET") return json(await ctx.store.listApiKeys(fleetId));
  if (!id && m === "POST") {
    const b = await body<{ name?: string; role?: string; expires_in_days?: number | null }>(req);
    const name = (b.name ?? "").toString().replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60);
    if (!name) throw new ApiError(400, "Name the key after the system that will use it, e.g. \"Dispatch TMS\"");
    const keyRole = b.role === "viewer" ? "viewer" : "planner";
    const days = b.expires_in_days == null ? null : Math.round(Number(b.expires_in_days));
    if (days !== null && !(days >= 1 && days <= 730)) throw new ApiError(400, "Expiry must be between 1 and 730 days, or never");
    const now = ctx.now();
    const active = (await ctx.store.listApiKeys(fleetId)).filter((k) => !k.revoked_at && (!k.expires_at || new Date(k.expires_at) > now));
    if (active.length >= MAX_ACTIVE_KEYS) throw new ApiError(409, `A fleet can have ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use first.`);
    const key = `${API_KEY_PREFIX}${randomToken(32)}`;
    const saved = await ctx.store.createApiKey({
      id: uuid(), fleet_id: fleetId, name, role: keyRole, key_hash: await sha256Hex(key), key_hint: hint(key) ?? "",
      created_by: user.id, created_at: iso(now), last_used_at: null, revoked_at: null,
      expires_at: days === null ? null : iso(new Date(now.getTime() + days * 86_400_000)),
    });
    await audit(ctx, req, user, { fleet_id: fleetId, action: "api_key.create", target: name, data: { key_id: saved.id, role: keyRole, expires_at: saved.expires_at } });
    // The key is shown this once; only its hash is kept.
    return json({ ...saved, key } satisfies ApiKey & { key: string }, 201);
  }
  if (id && m === "DELETE") {
    const k = (await ctx.store.listApiKeys(fleetId)).find((x) => x.id === id);
    if (!k) throw new ApiError(404, "API key not found");
    if (!k.revoked_at) {
      await ctx.store.updateApiKey(id, { revoked_at: iso(ctx.now()) });
      await audit(ctx, req, user, { fleet_id: fleetId, action: "api_key.revoke", target: k.name, data: { key_id: id } });
    }
    return json({ ok: true });
  }
  return err(404, "Not found");
}

// ------------------------------------------------------------------ team
const ROLES: MemberRole[] = ["owner", "planner", "viewer"];
const INVITE_DAYS = 7;

async function teamRoutes(req: Request, ctx: Ctx, user: AuthUser, fleetId: string, role: MemberRole, res: string, id: string | undefined): Promise<Response> {
  const m = req.method;
  const owner = role === "owner";
  if (res === "team" && m === "GET") {
    const [members, invites] = await Promise.all([ctx.store.listMembers(fleetId), owner ? ctx.store.listInvites(fleetId) : Promise.resolve([])]);
    const now = ctx.now().getTime();
    return json({ members, invites: invites.filter((i) => new Date(i.expires_at).getTime() > now) } satisfies TeamView);
  }
  if (res === "invites" && !id && m === "POST") {
    if (!owner) throw new ApiError(403, "Only fleet owners can invite people");
    const b = await body<{ email?: string | null; role?: MemberRole }>(req);
    const email = (b.email ?? "").toString().trim().toLowerCase().slice(0, 254) || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "That email address doesn't look right");
    const now = ctx.now();
    const invite: FleetInvite = {
      id: uuid(), fleet_id: fleetId, email, role: ROLES.includes(b.role as MemberRole) ? (b.role as MemberRole) : "planner",
      token: randomToken(24), created_by: user.id, created_at: iso(now), expires_at: iso(new Date(now.getTime() + INVITE_DAYS * 86_400_000)),
      accepted_by: null, accepted_at: null,
    };
    const saved = await ctx.store.createInvite(invite);
    await audit(ctx, req, user, { fleet_id: fleetId, action: "invite.create", target: email, data: { role: invite.role, invite_id: invite.id } });
    return json(saved, 201);
  }
  if (res === "invites" && id && m === "DELETE") {
    if (!owner) throw new ApiError(403, "Only fleet owners can cancel invites");
    const inv = await ctx.store.getInvite(id);
    if (!inv || inv.fleet_id !== fleetId) throw new ApiError(404, "Invite not found");
    await ctx.store.deleteInvite(id);
    await audit(ctx, req, user, { fleet_id: fleetId, action: "invite.revoke", target: inv.email, data: { invite_id: id } });
    return json({ ok: true });
  }
  if (res === "members" && id && (m === "PATCH" || m === "DELETE")) {
    const members = await ctx.store.listMembers(fleetId);
    const target = members.find((x) => x.user_id === id);
    if (!target) throw new ApiError(404, "That person isn't on this team");
    const owners = members.filter((x) => x.role === "owner").length;
    if (m === "PATCH") {
      if (!owner) throw new ApiError(403, "Only fleet owners can change roles");
      const b = await body<{ role?: MemberRole }>(req);
      if (!b.role || !ROLES.includes(b.role)) throw new ApiError(400, "Pick a role");
      if (target.role === "owner" && b.role !== "owner" && owners <= 1) throw new ApiError(409, "A fleet needs at least one owner. Make someone else an owner first.");
      await ctx.store.setMemberRole(fleetId, id, b.role);
      await audit(ctx, req, user, { fleet_id: fleetId, action: "member.role", target: target.email ?? id, data: { from: target.role, to: b.role } });
      return json({ ok: true });
    }
    const self = id === user.id;
    if (!owner && !self) throw new ApiError(403, "Only fleet owners can remove people");
    if (target.role === "owner" && owners <= 1) throw new ApiError(409, self ? "You're the only owner. Make someone else an owner before you leave." : "A fleet needs at least one owner.");
    await ctx.store.removeMember(fleetId, id);
    await audit(ctx, req, user, { fleet_id: fleetId, action: self ? "member.leave" : "member.remove", target: target.email ?? id, data: { role: target.role } });
    return json({ ok: true });
  }
  return err(404, "Not found");
}

async function validInvite(ctx: Ctx, token: string): Promise<FleetInvite> {
  const inv = await ctx.store.getInviteByToken(token);
  if (!inv || inv.accepted_at || new Date(inv.expires_at) <= ctx.now()) {
    throw new ApiError(404, "This invite link has expired or has already been used. Ask for a new one.", "INVITE_INVALID");
  }
  return inv;
}

async function invitePreview(ctx: Ctx, token: string, user: AuthUser | null): Promise<InvitePreview> {
  const inv = await validInvite(ctx, token);
  const fleet = await ctx.store.getFleet(inv.fleet_id);
  if (!fleet) throw new ApiError(404, "This fleet no longer exists", "INVITE_INVALID");
  const already = user ? (await ctx.store.getMemberships(user.id)).some((x) => x.fleet_id === inv.fleet_id) : false;
  return { fleet_name: fleet.name, role: inv.role, email: inv.email, expires_at: inv.expires_at, already_member: already };
}

async function acceptInvite(ctx: Ctx, req: Request, user: AuthUser, token: string): Promise<{ fleet_id: string; already_member: boolean }> {
  const inv = await validInvite(ctx, token);
  // Already on the team: leave the invite unused so it can still reach the person it was meant for.
  if ((await ctx.store.getMemberships(user.id)).some((x) => x.fleet_id === inv.fleet_id)) return { fleet_id: inv.fleet_id, already_member: true };
  // An invite addressed to someone works only for that email address, so a forwarded link can't be used.
  if (inv.email && inv.email.toLowerCase() !== (user.email ?? "").toLowerCase()) {
    throw new ApiError(403, `This invite was sent to ${inv.email}. Sign in with that address, or ask for an invite for ${user.email ?? "your account"}.`, "INVITE_EMAIL_MISMATCH");
  }
  if (!(await ctx.store.markInviteAccepted(inv.id, user.id, iso(ctx.now())))) {
    throw new ApiError(404, "This invite link has already been used. Ask for a new one.", "INVITE_INVALID");
  }
  await ctx.store.addMember(inv.fleet_id, user.id, inv.role, user.email);
  await audit(ctx, req, user, { fleet_id: inv.fleet_id, action: "invite.accept", target: user.email, data: { role: inv.role, invite_id: inv.id } });
  return { fleet_id: inv.fleet_id, already_member: false };
}

/**
 * Deletes the signed-in person's account: leaves every fleet, drops their email from the audit
 * log, and deletes the Supabase Auth user. Refused while they're the only owner of a team.
 */
async function deleteAccount(ctx: Ctx, req: Request, user: AuthUser): Promise<{ ok: true }> {
  const b = await body<{ confirm?: string }>(req);
  if ((b.confirm ?? "").trim().toLowerCase() !== (user.email ?? "delete").toLowerCase()) throw new ApiError(400, "Type your email address to confirm");
  const memberships = await ctx.store.getMemberships(user.id);
  for (const m of memberships) {
    const members = await ctx.store.listMembers(m.fleet_id);
    const owners = members.filter((x) => x.role === "owner");
    if (m.role === "owner" && owners.length === 1) {
      throw new ApiError(409, members.length > 1
        ? `You're the only owner of ${m.fleet_name}. Make someone else an owner first.`
        : `Delete ${m.fleet_name} first (Settings → Fleet → Delete fleet), or invite someone and make them an owner.`, "SOLE_OWNER");
    }
  }
  for (const m of memberships) await ctx.store.removeMember(m.fleet_id, user.id);
  await audit(ctx, req, user, { fleet_id: null, action: "account.delete", target: user.id });
  await ctx.store.anonymiseAuditActor(user.id);
  if (ctx.mode === "live") await deleteAuthUser(ctx, user.id);
  return { ok: true };
}

/** Supabase Auth admin API: removes every MFA factor of a user so they can enrol again. Returns how many. */
async function deleteAuthFactors(ctx: Ctx, userId: string): Promise<number> {
  const key = ctx.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const base = `${(ctx.env.SUPABASE_URL ?? "").replace(/\/+$/, "")}/auth/v1/admin/users/${encodeURIComponent(userId)}`;
  const headers = { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) };
  const res = await fetch(`${base}/factors`, { headers });
  if (!res.ok) throw new Error(`Listing the account's sign-in factors failed (${res.status})`);
  const factors = (await res.json()) as { id: string }[];
  for (const f of factors) {
    const del = await fetch(`${base}/factors/${encodeURIComponent(f.id)}`, { method: "DELETE", headers });
    if (!del.ok && del.status !== 404) throw new Error(`Removing a sign-in factor failed (${del.status})`);
  }
  return factors.length;
}

/** Supabase Auth admin API: removes the user (sessions, factors and identities go with it). */
async function deleteAuthUser(ctx: Ctx, userId: string) {
  const key = ctx.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const res = await fetch(`${(ctx.env.SUPABASE_URL ?? "").replace(/\/+$/, "")}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Deleting the sign-in account failed (${res.status})`);
}

// ------------------------------------------------------------------ network snapshot
let lastSimResync = 0;

async function network(ctx: Ctx): Promise<NetworkSnapshot> {
  const partners = (await ctx.store.listPartners()).filter((p) => p.status === "CONNECTED");
  // Keep the simulator's calendars fresh (a real CPO pushes Calendar updates itself).
  const sim = partners.find((p) => p.is_simulator);
  if (sim && ctx.simulatorEnabled) {
    const age = Date.now() - new Date(sim.last_sync_at ?? 0).getTime();
    if (age > 30 * 60_000 && Date.now() - lastSimResync > 60_000) {
      lastSimResync = Date.now();
      await syncPartner(ctx, sim).catch((e) => console.warn("simulator resync failed", e));
    }
  }
  const ids = new Set(partners.map((p) => p.id));
  const keep = <T extends { partner_id: string | null }>(xs: T[]) => xs.filter((x) => !x.partner_id || ids.has(x.partner_id));
  const [locations, booking_locations, tariffs] = await Promise.all([
    ctx.store.listObjects<Location>("locations"),
    ctx.store.listObjects<BookingLocation>("booking_locations"),
    ctx.store.listObjects<import("../../shared/ocpi/types").Tariff>("tariffs"),
  ]);
  return {
    operators: partners.flatMap((p) => p.roles.filter((r) => r.role === "CPO").map((r) => ({
      country_code: upper(r.country_code), party_id: upper(r.party_id), name: r.business_details?.name ?? `${r.country_code}*${r.party_id}`, partner_id: p.id, is_simulator: p.is_simulator,
    }))),
    locations: keep(locations),
    booking_locations: keep(booking_locations),
    tariffs: keep(tariffs),
    generated_at: iso(ctx.now()),
  };
}

let lastTick = 0;
async function maybeTick(ctx: Ctx) {
  if (!ctx.simulatorEnabled || ctx.mode === "demo") return;
  if (Date.now() - lastTick < 20_000) return;
  lastTick = Date.now();
  await tick(ctx).catch((e) => console.warn("simulator tick failed", e));
}

// ------------------------------------------------------------------ admin
/** Partners as the admin console sees them: no token material, just a hint of the latest token issued. */
function maskPartner(p: Partner) {
  const { our_token_hash: _o, registration_token_hash: _r, their_token, ...rest } = p;
  return { ...rest, has_their_token: !!their_token, awaiting_registration: !!p.registration_token_hash };
}

/** Operator addresses must be public https URLs (this app's own address is allowed, for the simulator). */
export function checkOperatorUrl(raw: string, ctx: Pick<Ctx, "baseUrl">): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ApiError(400, "That isn't a web address. It should look like https://ocpi.operator.example/versions"); }
  const own = (() => { try { return new URL(ctx.baseUrl).origin === u.origin; } catch { return false; } })();
  if (own) return u;
  if (u.protocol !== "https:") throw new ApiError(400, "The operator's address must start with https://");
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateHost = h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")
    || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
    || h === "::1" || /^f[cd]/.test(h) || /^fe80/.test(h);
  if (privateHost) throw new ApiError(400, "The operator's address must be on the public internet");
  return u;
}

/** What an operator will look at before connecting: the "Get ready" step of the operator guide. */
export async function readiness(ctx: Ctx): Promise<Readiness> {
  const host = (() => { try { return new URL(ctx.baseUrl); } catch { return null; } })();
  const local = !host || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host.hostname) || host.hostname.endsWith(".localhost");
  const legal = await legalInfo(ctx).catch(() => EMPTY_LEGAL);
  const partners = await ctx.store.listPartners().catch(() => [] as Partner[]);
  const checks: ReadinessCheck[] = [
    local || host?.protocol !== "https:"
      ? { id: "url", level: "todo", title: "Public HTTPS address", detail: "Operators call this app over the internet, so it needs a public https:// address. Deploy it first." }
      : host.hostname.endsWith(".workers.dev")
        ? { id: "url", level: "warn", title: "Public HTTPS address", detail: `${host.hostname} works. A domain of your own looks more trustworthy to operators and doesn't change if the Worker is renamed; if you add one later, operators need the new versions URL.` }
        : { id: "url", level: "ok", title: "Public HTTPS address", detail: host.hostname },
    ctx.env.OCPI_PARTY_ID && ctx.env.OCPI_COUNTRY_CODE
      ? { id: "party", level: "ok", title: "OCPI party ID", detail: `${ctx.party.country_code}*${ctx.party.party_id}. Check with each operator that no one else on their platform uses it.` }
      : { id: "party", level: "todo", title: "OCPI party ID", detail: "Set OCPI_COUNTRY_CODE and OCPI_PARTY_ID (three letters or digits that identify your company in OCPI) in the Worker's variables." },
    ctx.env.OCPI_BUSINESS_NAME
      ? { id: "name", level: "ok", title: "Business name", detail: ctx.party.name }
      : { id: "name", level: "warn", title: "Business name", detail: `Operators will see "${ctx.party.name}". Set OCPI_BUSINESS_NAME to your company's name.` },
    ctx.env.DATA_ENCRYPTION_KEY || ctx.mode === "demo"
      ? { id: "key", level: "ok", title: "Operator tokens encrypted", detail: "Tokens operators give you are sealed before they're stored." }
      : { id: "key", level: "todo", title: "Operator tokens encrypted", detail: "Set the DATA_ENCRYPTION_KEY secret before connecting a real operator, so their tokens aren't stored in plain text." },
    legal.company_name
      ? { id: "legal", level: "ok", title: "Company details", detail: legal.company_name }
      : { id: "legal", level: "warn", title: "Company details", detail: "Operators sign an agreement with a company. Add your company details in Compliance so they appear on your legal pages." },
    legal.security_contact
      ? { id: "security", level: "ok", title: "Security contact", detail: "Operators can report a problem with the integration." }
      : { id: "security", level: "warn", title: "Security contact", detail: "Set SECURITY_CONTACT so operators know where to report a security problem." },
  ];
  return {
    checks,
    simulator: ctx.simulatorEnabled,
    simulator_connected: partners.some((p) => p.is_simulator && p.status !== "REMOVED"),
    versions_url: ocpiUrls(ctx.baseUrl).versions,
  };
}

async function adminRoutes(req: Request, ctx: Ctx, user: AuthUser, seg: string[], url: URL): Promise<Response> {
  const m = req.method;
  const [res, id, action] = seg;
  if (res === "partners") {
    if (!id && m === "GET") return json((await ctx.store.listPartners()).map(maskPartner));
    if (!id && m === "POST") {
      const b = await body<{ action: "invite" | "connect"; name?: string; versions_url?: string; token?: string }>(req);
      if (b.action === "invite") {
        const { partner, token } = await invitePartner(ctx, (b.name ?? "").trim().slice(0, 80));
        await audit(ctx, req, user, { action: "partner.invite", target: partner.name, data: { partner_id: partner.id } });
        // The registration token is shown this once; only its hash is kept.
        return json({ ...maskPartner(partner), registration_token: token }, 201);
      }
      if (b.action === "connect") {
        if (!b.versions_url || !b.token) throw new ApiError(400, "Versions URL and token are required");
        checkOperatorUrl(b.versions_url.trim(), ctx);
        let p: Partner;
        try {
          p = await registerWithPartner(ctx, b.versions_url.trim(), b.token.trim(), { name: b.name?.trim().slice(0, 80) || undefined });
        } catch (e) {
          throw new ApiError(502, e instanceof Error ? e.message : "Registration failed");
        }
        const counts = await syncPartner(ctx, p).catch(() => ({}));
        await audit(ctx, req, user, { action: "partner.connect", target: p.name, data: { partner_id: p.id, versions_url: b.versions_url.trim() } });
        return json({ partner: maskPartner(p), counts }, 201);
      }
      throw new ApiError(400, "Unknown action");
    }
    const p = id ? await ctx.store.getPartner(id) : null;
    if (!p) throw new ApiError(404, "Partner not found");
    if (m === "POST" && action === "sync") {
      try {
        return json({ counts: await syncPartner(ctx, p) });
      } catch (e) {
        throw new ApiError(502, e instanceof Error ? e.message : "Sync failed");
      }
    }
    if (m === "POST" && action === "token") {
      let out: { partner: Partner; token: string };
      try { out = await newRegistrationToken(ctx, p); } catch (e) { throw new ApiError(409, e instanceof Error ? e.message : "Not possible"); }
      await audit(ctx, req, user, { action: "partner.token_regenerate", target: p.name, data: { partner_id: p.id } });
      return json({ ...maskPartner(out.partner), registration_token: out.token });
    }
    if (m === "DELETE" && !action) {
      await unregisterPartner(ctx, p);
      await audit(ctx, req, user, { action: "partner.disconnect", target: p.name, data: { partner_id: p.id } });
      return json({ ok: true });
    }
  }
  if (res === "readiness" && m === "GET") return json(await readiness(ctx));
  // Read-only check of an operator's OCPI interface before connecting it (GET requests only).
  if (res === "probe" && m === "POST") {
    const b = await body<{ versions_url?: string; token?: string }>(req);
    const versionsUrl = (b.versions_url ?? "").toString().trim();
    const token = (b.token ?? "").toString().trim();
    if (!versionsUrl || !token) throw new ApiError(400, "Enter the operator's versions URL and token");
    checkOperatorUrl(versionsUrl, ctx);
    const report = await probeOperator({ versionsUrl, token, from: { country_code: ctx.party.country_code, party_id: ctx.party.party_id }, maxPages: 3, fetch: (r) => ctx.transport(r) });
    await audit(ctx, req, user, { action: "partner.probe", target: new URL(versionsUrl).hostname, data: { ok: report.ok } });
    return json(report);
  }
  if (res === "audit" && m === "GET") {
    return json(await ctx.store.listAudit({ limit: Math.min(500, Number(url.searchParams.get("limit") ?? 200) || 200) }));
  }
  // Account recovery: someone lost the phone with their authenticator app. The admin checks it's
  // really them first (see docs/compliance/security-policy.md); the person then sets up a new one.
  if (res === "users" && id === "reset-mfa" && m === "POST") {
    const b = await body<{ email?: string; reason?: string }>(req);
    const email = (b.email ?? "").toString().trim().toLowerCase().slice(0, 254);
    const reason = (b.reason ?? "").toString().trim().slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Enter the person's email address");
    if (!reason) throw new ApiError(400, "Say how you confirmed it's really them (this goes in the audit log)");
    if (email === (user.email ?? "").toLowerCase()) throw new ApiError(400, "Ask another platform admin to reset your own two-step verification");
    const target = await ctx.store.findMemberUserId(email);
    if (!target) throw new ApiError(404, "No one with that email address is on a fleet team");
    const removed = ctx.mode === "live" ? await deleteAuthFactors(ctx, target) : 0;
    await audit(ctx, req, user, { action: "user.mfa_reset", target: email, data: { factors_removed: removed, reason } });
    return json({ ok: true, factors_removed: removed });
  }
  // After setting DATA_ENCRYPTION_KEY for the first time, or rotating it (old key in
  // DATA_ENCRYPTION_KEY_PREVIOUS): re-seal every stored operator token with the current key.
  if (res === "security" && id === "reencrypt" && m === "POST") {
    if (ctx.mode === "live" && !ctx.env.DATA_ENCRYPTION_KEY) throw new ApiError(409, "Set DATA_ENCRYPTION_KEY first, then run this again");
    let count = 0;
    for (const p of await ctx.store.listPartners()) {
      if (!p.their_token) continue;
      await ctx.store.upsertPartner(p);
      count++;
    }
    const links = (await ctx.store.resealLinkTokens?.()) ?? 0;
    await audit(ctx, req, user, { action: "security.reencrypt", data: { tokens: count, links } });
    return json({ ok: true, tokens: count, links });
  }
  if (res === "legal") {
    if (m === "GET") return json(await legalInfo(ctx));
    if (m === "PUT") {
      const b = await body<Partial<LegalInfo>>(req);
      const clean = cleanLegal(b);
      await ctx.store.setSetting("legal", clean);
      await audit(ctx, req, user, { action: "legal.update", data: { fields: Object.keys(clean).filter((k) => clean[k as keyof LegalInfo]) } });
      return json(await legalInfo(ctx));
    }
  }
  if (res === "certifications") {
    if (m === "GET") return json((await ctx.store.getSetting<Certification[]>("certifications")) ?? []);
    if (m === "PUT") {
      const b = await body<{ certifications?: Certification[] }>(req);
      const list = (b.certifications ?? []).slice(0, 6).map(cleanCertification);
      await ctx.store.setSetting("certifications", list);
      await audit(ctx, req, user, { action: "certifications.update", data: { certificates: list.map((c) => `${c.scheme} ${c.certificate_number} until ${c.expires_on}`) } });
      return json(list);
    }
  }
  if (res === "compliance") {
    if (!id && m === "GET") return json(await complianceReport(ctx, user));
    if (id && m === "PUT") {
      const b = await body<{ done?: boolean; note?: string | null }>(req);
      await saveTick(ctx, user, id, !!b.done, (b.note ?? "").toString().slice(0, 300) || null);
      await audit(ctx, req, user, { action: b.done ? "compliance.tick" : "compliance.untick", target: id, data: b.note ? { note: b.note.toString().slice(0, 300) } : null });
      return json(await complianceReport(ctx, user));
    }
  }
  if (res === "log" && m === "GET") {
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 100) || 100);
    return json(await ctx.store.listLogs({ limit, before: url.searchParams.get("before") ?? undefined, module: url.searchParams.get("module") ?? undefined }));
  }
  if (res === "brand") {
    if (m === "GET") return json({ ...DEFAULT_BRAND, ...brandFromEnv(ctx.env), ...((await ctx.store.getBrand()) ?? {}) });
    if (m === "PUT") {
      const b = await body<Partial<Brand>>(req);
      const color = /^#[0-9a-f]{6}$/i.test(b.primary_color ?? "") ? b.primary_color! : DEFAULT_BRAND.primary_color;
      const logo = (b.logo_url ?? "").toString();
      if (logo.length > 150_000) throw new ApiError(413, "Logo is too large. Use an SVG or PNG under 100 KB");
      const logoProblem = checkLogo(logo);
      if (logoProblem) throw new ApiError(400, logoProblem);
      const brand: Brand = {
        name: (b.name ?? DEFAULT_BRAND.name).toString().trim().slice(0, 40) || DEFAULT_BRAND.name,
        logo_url: logo,
        primary_color: color,
        support_email: (b.support_email ?? "").toString().slice(0, 120),
        support_phone: (b.support_phone ?? "").toString().slice(0, 30),
        show_powered_by: !!b.show_powered_by,
      };
      await ctx.store.setBrand(brand);
      await audit(ctx, req, user, { action: "brand.update", data: { name: brand.name, logo: brand.logo_url ? (brand.logo_url.startsWith("data:") ? "uploaded" : brand.logo_url) : "monogram" } });
      return json(brand);
    }
  }
  if (res === "simulator") {
    if (!ctx.simulatorEnabled) throw new ApiError(404, "The CPO simulator is disabled (set ENABLE_CPO_SIMULATOR=true)");
    if (!id && m === "GET") return json(await simStatus(ctx));
    if (id === "connect" && m === "POST") {
      const existing = (await ctx.store.listPartners()).find((p) => p.is_simulator && p.status === "CONNECTED");
      if (existing) return json({ partner: maskPartner(existing), counts: await syncPartner(ctx, existing) });
      const { versionsUrl, tokenA } = await simPrepareRegistration(ctx);
      const p = await registerWithPartner(ctx, versionsUrl, tokenA, { isSimulator: true, name: "CPO simulator" });
      await audit(ctx, req, user, { action: "simulator.connect", data: { partner_id: p.id } });
      return json({ partner: maskPartner(p), counts: await syncPartner(ctx, p) }, 201);
    }
    if (id === "action" && m === "POST") {
      const b = await body<{ action: SimAction; booking_id?: string; reason?: CanceledReason }>(req);
      let ref: string | null = null;
      if (b.booking_id) {
        const row = await ctx.store.getBooking(b.booking_id);
        if (!row) throw new ApiError(404, "Booking not found");
        ref = row.ocpi_id ?? row.request_id;
      }
      try {
        return json({ result: await simControl(ctx, b.action, ref, b.reason) });
      } catch (e) {
        throw new ApiError(409, e instanceof Error ? e.message : "Simulator action failed");
      }
    }
  }
  return err(404, "Not found");
}

// ------------------------------------------------------------------ company & certificates
const LEGAL_LIMITS: Record<keyof LegalInfo, number> = {
  company_name: 160, trading_name: 80, company_number: 12, registered_office: 300, place_of_registration: 60,
  vat_number: 20, contact_email: 254, privacy_email: 254, ico_number: 20, security_contact: 254, email_provider: 120, hosting_region: 80,
};

function cleanLegal(b: Partial<LegalInfo>): LegalInfo {
  const out = { ...EMPTY_LEGAL };
  for (const k of Object.keys(LEGAL_LIMITS) as (keyof LegalInfo)[]) {
    out[k] = (b[k] ?? "").toString().replace(/[\u0000-\u001f]/g, " ").trim().slice(0, LEGAL_LIMITS[k]) || (k === "place_of_registration" ? EMPTY_LEGAL.place_of_registration : "");
  }
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const k of ["contact_email", "privacy_email"] as const) if (out[k] && !email.test(out[k])) throw new ApiError(400, `${k === "contact_email" ? "Contact" : "Privacy"} email doesn't look right`);
  if (out.security_contact && !email.test(out.security_contact) && !/^https:\/\/\S+$/.test(out.security_contact)) throw new ApiError(400, "Security contact must be an email address or an https:// link");
  if (out.company_number && !/^[A-Z0-9]{6,10}$/i.test(out.company_number.replace(/\s/g, ""))) throw new ApiError(400, "Company number should be the 8 characters Companies House gave you (e.g. 12345678 or SC123456)");
  out.company_number = out.company_number.replace(/\s/g, "").toUpperCase();
  return out;
}

const SCHEMES = ["Cyber Essentials", "Cyber Essentials Plus", "ISO/IEC 27001"] as const;
const IASME_SEARCH = "https://iasme.co.uk/cyber-essentials/ncsc-certificate-search/";

function cleanCertification(c: Partial<Certification>): Certification {
  const scheme = SCHEMES.find((x) => x === c.scheme);
  if (!scheme) throw new ApiError(400, "Pick a certification scheme");
  const number = (c.certificate_number ?? "").toString().trim().slice(0, 60);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ./-]{2,59}$/.test(number)) throw new ApiError(400, "Enter the certificate number exactly as it appears on the certificate");
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const issued = (c.issued_on ?? "").toString();
  const expires = (c.expires_on ?? "").toString();
  if (!day.test(issued) || !day.test(expires) || expires <= issued) throw new ApiError(400, "Enter the issue and expiry dates from the certificate");
  const verify = (c.verify_url ?? "").toString().trim() || (scheme.startsWith("Cyber Essentials") ? IASME_SEARCH : "");
  if (verify && !/^https:\/\/\S+$/.test(verify)) throw new ApiError(400, "The verification link must start with https://");
  return { scheme, certificate_number: number, issued_on: issued, expires_on: expires, certification_body: (c.certification_body ?? "").toString().trim().slice(0, 120), verify_url: verify };
}
