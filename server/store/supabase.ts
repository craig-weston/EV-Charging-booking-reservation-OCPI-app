// Store backed by Supabase Postgres through PostgREST (plain fetch, no SDK — runs on Workers).
// Uses the service-role / secret key, so it bypasses RLS: the API layer enforces fleet access.
import type {
  ApiKey, ApiKeyRow, AuditEntry, Brand, BookingEvent, BookingRow, Driver, Fleet, FleetInvite, Member, Membership, MemberRole, OcpiLogEntry, OcpiModule,
  Partner, StoredObject, Vehicle,
} from "../../shared/model";
import { iso, upper } from "../../shared/util";
import { openSecret, sealSecret, sha256Hex } from "../security";
import type { Page, Store } from "./types";

class RestError extends Error {
  constructor(public status: number, public pgCode: string | undefined, message: string) {
    super(message);
  }
}

const TS_KEYS = new Set(["at", "created_at", "updated_at", "start_at", "end_at", "last_sync_at", "last_updated", "received_at", "expires_at", "accepted_at", "last_used_at", "revoked_at"]);

/** PostgREST returns "2026-10-20T12:00:00+00:00"; the app uses OCPI-style "…Z". */
function normalize<T>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out = row as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (TS_KEYS.has(k) && typeof v === "string" && v) out[k] = iso(v);
  }
  return row;
}

const enc = (v: string | number | boolean) => encodeURIComponent(String(v));

export class Rest {
  constructor(private base: string, private key: string) {
    this.base = base.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { apikey: this.key, "Content-Type": "application/json", ...extra };
    // Legacy JWT keys go in Authorization too; new sb_secret_ keys are accepted via `apikey` alone.
    if (this.key.startsWith("eyJ")) h.Authorization = `Bearer ${this.key}`;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<{ rows: T; headers: Headers }> {
    const res = await fetch(`${this.base}/rest/v1/${path}`, {
      method,
      headers: this.headers(prefer ? { Prefer: prefer } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail: { message?: string; code?: string; details?: string } = {};
      try { detail = JSON.parse(text); } catch { /* ignore */ }
      // Database details stay in the server log; callers see a generic error (see the API router).
      throw new RestError(res.status, detail.code, detail.message ?? `Supabase ${method} ${path.split("?")[0]} failed (${res.status})`);
    }
    return { rows: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  async select<T>(table: string, query: string): Promise<T[]> {
    const { rows } = await this.request<T[]>("GET", `${table}?${query}`);
    return (rows ?? []).map(normalize);
  }
  async one<T>(table: string, query: string): Promise<T | null> {
    return (await this.select<T>(table, `${query}&limit=1`))[0] ?? null;
  }
  async insert<T>(table: string, rows: unknown, opts: { onConflict?: string; returning?: boolean } = {}): Promise<T[]> {
    const q = opts.onConflict ? `?on_conflict=${opts.onConflict}` : "";
    const prefer = [opts.onConflict ? "resolution=merge-duplicates" : "", opts.returning === false ? "return=minimal" : "return=representation"].filter(Boolean).join(",");
    const { rows: out } = await this.request<T[]>("POST", `${table}${q}`, rows, prefer);
    return (out ?? []).map(normalize);
  }
  async update<T>(table: string, query: string, patch: unknown): Promise<T[]> {
    const { rows } = await this.request<T[]>("PATCH", `${table}?${query}`, patch, "return=representation");
    return (rows ?? []).map(normalize);
  }
  async remove(table: string, query: string): Promise<void> {
    await this.request("DELETE", `${table}?${query}`, undefined, "return=minimal");
  }
  async page<T>(table: string, query: string): Promise<Page<T>> {
    const { rows, headers } = await this.request<T[]>("GET", `${table}?${query}`, undefined, "count=exact");
    const range = headers.get("Content-Range") ?? "";
    const total = Number(range.split("/")[1]);
    return { items: (rows ?? []).map(normalize), total: Number.isFinite(total) ? total : (rows ?? []).length };
  }
}

function friendly(e: unknown): never {
  if (e instanceof RestError && e.pgCode === "23505") {
    const msg = /token_uid/.test(e.message) ? "Another vehicle already uses this charging ID" : /plate/.test(e.message) ? "A vehicle with this number plate already exists" : "That record already exists";
    throw Object.assign(new Error(msg), { status: 409 });
  }
  throw e;
}

export class SupabaseStore implements Store {
  private rest: Rest;
  /**
   * encryptionKey (DATA_ENCRYPTION_KEY) seals the credentials tokens partners gave us. During a key
   * rotation, previousKey (DATA_ENCRYPTION_KEY_PREVIOUS) still opens values sealed with the old key.
   */
  constructor(url: string, serviceKey: string, private encryptionKey?: string, private previousKey?: string) {
    this.rest = new Rest(url, serviceKey);
  }

  // Link tokens (driver passes, team invites) are bearer secrets. At rest they're sealed with
  // DATA_ENCRYPTION_KEY (planners can still copy the link again) and found by their SHA-256, so a
  // copy of the database or a backup doesn't hand out working links.
  private async sealLink<T extends object>(row: T, field: "pass_token" | "token", hashField: "pass_token_hash" | "token_hash"): Promise<T> {
    const v = (row as Record<string, unknown>)[field];
    if (typeof v !== "string") return row;
    return { ...row, [field]: await sealSecret(v, this.encryptionKey), [hashField]: await sha256Hex(v) };
  }
  private async openLink<T extends object>(row: T | null, field: "pass_token" | "token", hashField: "pass_token_hash" | "token_hash"): Promise<T | null> {
    if (!row) return row;
    const { [hashField]: _h, ...rest } = row as Record<string, unknown>;
    const v = rest[field];
    return { ...rest, [field]: typeof v === "string" ? await openSecret(v, this.encryptionKey, this.previousKey) : v } as T;
  }
  private openBooking = (b: BookingRow | null) => this.openLink(b, "pass_token", "pass_token_hash");
  private openBookings = (rows: BookingRow[]) => Promise.all(rows.map((b) => this.openLink(b, "pass_token", "pass_token_hash") as Promise<BookingRow>));
  private openInvite = (i: FleetInvite | null) => this.openLink(i, "token", "token_hash");

  /** Re-seal every pass and invite token with the current key (Security → Re-encrypt). */
  async resealLinkTokens(): Promise<number> {
    let count = 0;
    for (const [table, field, hashField] of [["bookings", "pass_token", "pass_token_hash"], ["fleet_invites", "token", "token_hash"]] as const) {
      for (let offset = 0; ; offset += 500) {
        const rows = await this.rest.select<Record<string, string>>(table, `select=id,${field}&order=id.asc&limit=500&offset=${offset}`);
        for (const r of rows) {
          const plain = await openSecret(r[field], this.encryptionKey, this.previousKey);
          if (plain == null) continue;
          const sealed = await this.sealLink({ [field]: plain } as Record<string, string>, field, hashField);
          await this.rest.update(table, `id=eq.${enc(r.id)}`, sealed);
          count++;
        }
        if (rows.length < 500) break;
      }
    }
    return count;
  }

  // tenancy -------------------------------------------------------------------
  async getMemberships(userId: string): Promise<Membership[]> {
    const rows = await this.rest.select<{ fleet_id: string; user_id: string; role: MemberRole; fleets: { name: string; require_mfa: boolean } | null }>(
      "fleet_members", `select=fleet_id,user_id,role,fleets(name,require_mfa)&user_id=eq.${enc(userId)}&order=created_at.asc`,
    );
    return rows.map((r) => ({ fleet_id: r.fleet_id, user_id: r.user_id, role: r.role, fleet_name: r.fleets?.name ?? "", require_mfa: !!r.fleets?.require_mfa }));
  }
  async isPlatformAdmin(userId: string) {
    return !!(await this.rest.one("platform_admins", `select=user_id&user_id=eq.${enc(userId)}`));
  }
  async getFleet(id: string) {
    return this.rest.one<Fleet>("fleets", `select=*&id=eq.${enc(id)}`);
  }
  async createFleet(name: string, owner: { id: string; email: string | null }) {
    const [f] = await this.rest.insert<Fleet>("fleets", { name });
    await this.rest.insert("fleet_members", { fleet_id: f.id, user_id: owner.id, role: "owner", email: owner.email }, { returning: false });
    return f;
  }
  async updateFleet(id: string, patch: Partial<Fleet>) {
    const [f] = await this.rest.update<Fleet>("fleets", `id=eq.${enc(id)}`, { ...patch, updated_at: iso(new Date()) });
    return f;
  }
  async deleteFleet(id: string) {
    // ON DELETE CASCADE removes members, invites, vehicles, drivers, bookings and booking events.
    await this.rest.remove("fleets", `id=eq.${enc(id)}`);
  }
  // team ---------------------------------------------------------------------------
  listMembers(fleetId: string) {
    return this.rest.select<Member>("fleet_members", `select=fleet_id,user_id,role,email,created_at&fleet_id=eq.${enc(fleetId)}&order=created_at.asc`);
  }
  async findMemberUserId(email: string) {
    // Supabase Auth stores emails in lower case, and so does the API when it adds members.
    const row = await this.rest.one<{ user_id: string }>("fleet_members", `select=user_id&email=eq.${enc(email.trim().toLowerCase())}&limit=1`);
    return row?.user_id ?? null;
  }
  async addMember(fleetId: string, userId: string, role: MemberRole, email: string | null) {
    // ignore-duplicates: an existing member keeps their role.
    await this.rest.request("POST", "fleet_members?on_conflict=fleet_id,user_id", { fleet_id: fleetId, user_id: userId, role, email }, "resolution=ignore-duplicates,return=minimal");
  }
  async setMemberRole(fleetId: string, userId: string, role: MemberRole) {
    await this.rest.update("fleet_members", `fleet_id=eq.${enc(fleetId)}&user_id=eq.${enc(userId)}`, { role });
  }
  async removeMember(fleetId: string, userId: string) {
    await this.rest.remove("fleet_members", `fleet_id=eq.${enc(fleetId)}&user_id=eq.${enc(userId)}`);
  }
  async createInvite(invite: FleetInvite) {
    const [row] = await this.rest.insert<FleetInvite>("fleet_invites", await this.sealLink(invite, "token", "token_hash"));
    return (await this.openInvite(row))!;
  }
  async listInvites(fleetId: string) {
    const rows = await this.rest.select<FleetInvite>("fleet_invites", `select=*&fleet_id=eq.${enc(fleetId)}&accepted_at=is.null&order=created_at.asc`);
    return Promise.all(rows.map((i) => this.openInvite(i) as Promise<FleetInvite>));
  }
  async getInvite(id: string) {
    return this.openInvite(await this.rest.one<FleetInvite>("fleet_invites", `select=*&id=eq.${enc(id)}`));
  }
  async getInviteByToken(token: string) {
    return this.openInvite(await this.rest.one<FleetInvite>("fleet_invites", `select=*&token_hash=eq.${await sha256Hex(token)}`));
  }
  async markInviteAccepted(id: string, userId: string, at: string) {
    const rows = await this.rest.update("fleet_invites", `id=eq.${enc(id)}&accepted_at=is.null`, { accepted_by: userId, accepted_at: at });
    return rows.length > 0;
  }
  async deleteInvite(id: string) {
    await this.rest.remove("fleet_invites", `id=eq.${enc(id)}`);
  }

  // API keys -----------------------------------------------------------------------
  listApiKeys(fleetId: string) {
    return this.rest.select<ApiKey>("fleet_api_keys", `select=id,fleet_id,name,role,key_hint,created_by,created_at,last_used_at,expires_at,revoked_at&fleet_id=eq.${enc(fleetId)}&order=created_at.desc`);
  }
  async createApiKey(row: ApiKeyRow) {
    await this.rest.insert("fleet_api_keys", row, { returning: false });
    const { key_hash: _h, ...k } = row;
    return k;
  }
  findApiKeyByHash(hash: string) {
    return this.rest.one<ApiKeyRow>("fleet_api_keys", `select=*&key_hash=eq.${enc(hash)}`);
  }
  async updateApiKey(id: string, patch: Partial<Pick<ApiKey, "last_used_at" | "revoked_at" | "name">>) {
    await this.rest.update("fleet_api_keys", `id=eq.${enc(id)}`, patch);
  }

  async getBrand() {
    const r = await this.rest.one<{ value: Brand }>("platform_settings", "select=value&key=eq.brand");
    return r?.value ?? null;
  }
  async setBrand(brand: Brand) {
    await this.setSetting("brand", brand);
  }
  async getSetting<T>(key: string) {
    const r = await this.rest.one<{ value: T }>("platform_settings", `select=value&key=eq.${enc(key)}`);
    return r?.value ?? null;
  }
  async setSetting<T>(key: string, value: T) {
    await this.rest.insert("platform_settings", { key, value, updated_at: iso(new Date()) }, { onConflict: "key", returning: false });
  }

  // audit log -----------------------------------------------------------------------------
  async addAudit(entry: AuditEntry) {
    await this.rest.insert("audit_log", entry, { returning: false });
  }
  listAudit(o: { fleetId?: string; limit: number }) {
    const scope = o.fleetId ? `fleet_id=eq.${enc(o.fleetId)}` : "fleet_id=is.null";
    return this.rest.select<AuditEntry>("audit_log", `select=*&${scope}&order=at.desc&limit=${o.limit}`);
  }
  async anonymiseAuditActor(userId: string) {
    await this.rest.update("audit_log", `actor_id=eq.${enc(userId)}`, { actor_email: null });
  }

  // vehicles & drivers ---------------------------------------------------------------
  listVehicles(fleetId: string) {
    return this.rest.select<Vehicle>("vehicles", `select=*&fleet_id=eq.${enc(fleetId)}&order=name.asc`);
  }
  getVehicle(id: string) {
    return this.rest.one<Vehicle>("vehicles", `select=*&id=eq.${enc(id)}`);
  }
  async upsertVehicle(v: Vehicle) {
    try {
      const [row] = await this.rest.insert<Vehicle>("vehicles", v, { onConflict: "id" });
      return row;
    } catch (e) {
      return friendly(e);
    }
  }
  async deleteVehicle(id: string) {
    await this.rest.remove("vehicles", `id=eq.${enc(id)}`);
  }
  findVehicleByToken(uid: string) {
    return this.rest.one<Vehicle>("vehicles", `select=*&token_uid=eq.${enc(upper(uid))}`);
  }
  listTokenVehicles(o: { offset: number; limit: number; dateFrom?: string; dateTo?: string }) {
    let q = `select=*&order=created_at.asc&offset=${o.offset}&limit=${o.limit}`;
    if (o.dateFrom) q += `&updated_at=gte.${enc(o.dateFrom)}`;
    if (o.dateTo) q += `&updated_at=lt.${enc(o.dateTo)}`;
    return this.rest.page<Vehicle>("vehicles", q);
  }
  listDrivers(fleetId: string) {
    return this.rest.select<Driver>("drivers", `select=*&fleet_id=eq.${enc(fleetId)}&order=name.asc`);
  }
  getDriver(id: string) {
    return this.rest.one<Driver>("drivers", `select=*&id=eq.${enc(id)}`);
  }
  async upsertDriver(d: Driver) {
    const [row] = await this.rest.insert<Driver>("drivers", d, { onConflict: "id" });
    return row;
  }
  async deleteDriver(id: string) {
    await this.rest.remove("drivers", `id=eq.${enc(id)}`);
  }

  // partners ---------------------------------------------------------------------------
  // their_token is sealed (AES-256-GCM) on the way in and opened on the way out.
  private async open(p: Partner | null): Promise<Partner | null> {
    return p ? { ...p, their_token: await openSecret(p.their_token, this.encryptionKey, this.previousKey) } : null;
  }
  async listPartners() {
    const rows = await this.rest.select<Partner>("ocpi_partners", "select=*&order=created_at.asc");
    return Promise.all(rows.map(async (r) => (await this.open(r))!));
  }
  async getPartner(id: string) {
    return this.open(await this.rest.one<Partner>("ocpi_partners", `select=*&id=eq.${enc(id)}`));
  }
  async findPartnerByTokenHash(hash: string) {
    return this.open(await this.rest.one<Partner>("ocpi_partners", `select=*&our_token_hash=eq.${enc(hash)}&status=neq.REMOVED`));
  }
  async findPartnerByRegistrationHash(hash: string) {
    return this.open(await this.rest.one<Partner>("ocpi_partners", `select=*&registration_token_hash=eq.${enc(hash)}&status=eq.PENDING`));
  }
  async findPartnerByParty(cc: string, pid: string) {
    const filter = enc(JSON.stringify([{ country_code: upper(cc), party_id: upper(pid) }]));
    return this.open(await this.rest.one<Partner>("ocpi_partners", `select=*&roles=cs.${filter}&status=neq.REMOVED&order=updated_at.desc`));
  }
  async upsertPartner(p: Partner) {
    const sealed = { ...p, their_token: await sealSecret(p.their_token, this.encryptionKey), updated_at: iso(new Date()) };
    const [row] = await this.rest.insert<Partner>("ocpi_partners", sealed, { onConflict: "id" });
    return (await this.open(row))!;
  }

  // OCPI objects ---------------------------------------------------------------------------
  private objQ(module: string, cc: string, pid: string, id: string) {
    return `module=eq.${enc(module)}&country_code=eq.${enc(upper(cc))}&party_id=eq.${enc(upper(pid))}&id=eq.${enc(id)}`;
  }
  getObject<T>(module: OcpiModule, cc: string, pid: string, id: string) {
    return this.rest.one<StoredObject<T>>("ocpi_objects", `select=module,country_code,party_id,id,data,last_updated,partner_id&${this.objQ(module, cc, pid, id)}`);
  }
  async putObject<T>(obj: StoredObject<T>) {
    await this.putObjects([obj]);
  }
  async putObjects<T>(objs: StoredObject<T>[]) {
    if (!objs.length) return;
    const rows = objs.map((o) => ({ ...o, country_code: upper(o.country_code), party_id: upper(o.party_id), last_updated: iso(o.last_updated), received_at: iso(new Date()) }));
    for (let i = 0; i < rows.length; i += 200) {
      await this.rest.insert("ocpi_objects", rows.slice(i, i + 200), { onConflict: "module,country_code,party_id,id", returning: false });
    }
  }
  async deleteObject(module: OcpiModule, cc: string, pid: string, id: string) {
    await this.rest.remove("ocpi_objects", this.objQ(module, cc, pid, id));
  }
  listObjects<T>(module: OcpiModule) {
    return this.rest.select<StoredObject<T>>("ocpi_objects", `select=module,country_code,party_id,id,data,last_updated,partner_id&module=eq.${enc(module)}&limit=5000`);
  }

  // bookings ---------------------------------------------------------------------------------
  async insertBooking(b: BookingRow) {
    const [row] = await this.rest.insert<BookingRow>("bookings", await this.sealLink(b, "pass_token", "pass_token_hash"));
    return (await this.openBooking(row))!;
  }
  async updateBooking(id: string, patch: Partial<BookingRow>) {
    const [row] = await this.rest.update<BookingRow>("bookings", `id=eq.${enc(id)}`, { ...(await this.sealLink(patch, "pass_token", "pass_token_hash")), updated_at: iso(new Date()) });
    if (!row) throw new Error("booking not found");
    return (await this.openBooking(row))!;
  }
  async getBooking(id: string) {
    return this.openBooking(await this.rest.one<BookingRow>("bookings", `select=*&id=eq.${enc(id)}`));
  }
  async findBookingByRequestId(requestId: string) {
    return this.openBooking(await this.rest.one<BookingRow>("bookings", `select=*&request_id=eq.${enc(requestId)}`));
  }
  async findBookingByCpoRef(cc: string, pid: string, ref: string) {
    const quoted = `"${ref.replace(/["\\]/g, "")}"`;
    const rows = await this.rest.select<BookingRow>("bookings", `select=*&cpo_country_code=eq.${enc(upper(cc))}&cpo_party_id=eq.${enc(upper(pid))}&or=${enc(`(ocpi_id.eq.${quoted},request_id.eq.${quoted})`)}&limit=2`);
    return this.openBooking(rows.find((r) => r.ocpi_id === ref) ?? rows[0] ?? null);
  }
  async findBookingByAuthRef(authRef: string) {
    return this.openBooking(await this.rest.one<BookingRow>("bookings", `select=*&authorization_reference=eq.${enc(authRef)}`));
  }
  async findBookingByPassToken(token: string) {
    return this.openBooking(await this.rest.one<BookingRow>("bookings", `select=*&pass_token_hash=eq.${await sha256Hex(token)}`));
  }
  async listBookings(fleetId: string, o: { from?: string; to?: string; limit?: number } = {}) {
    let q = `select=*&fleet_id=eq.${enc(fleetId)}&order=start_at.asc&limit=${o.limit ?? 500}`;
    if (o.from) q += `&end_at=gte.${enc(o.from)}`;
    if (o.to) q += `&start_at=lt.${enc(o.to)}`;
    return this.openBookings(await this.rest.select<BookingRow>("bookings", q));
  }
  async listVehicleBookings(vehicleId: string, locationId: string) {
    return this.openBookings(await this.rest.select<BookingRow>("bookings", `select=*&vehicle_id=eq.${enc(vehicleId)}&location_id=eq.${enc(locationId)}&order=start_at.desc&limit=50`));
  }
  async addEvents(events: BookingEvent[]) {
    if (events.length) await this.rest.insert("booking_events", events, { returning: false });
  }
  listEvents(fleetId: string, o: { since?: string; limit?: number } = {}) {
    let q = `select=*&fleet_id=eq.${enc(fleetId)}&order=at.desc&limit=${o.limit ?? 300}`;
    if (o.since) q += `&at=gte.${enc(o.since)}`;
    return this.rest.select<BookingEvent>("booking_events", q);
  }

  // log ------------------------------------------------------------------------------------------
  async addLogs(entries: OcpiLogEntry[]) {
    if (entries.length) await this.rest.insert("ocpi_log", entries, { returning: false });
  }
  listLogs(o: { limit: number; before?: string; module?: string }) {
    let q = `select=*&order=at.desc&limit=${o.limit}`;
    if (o.before) q += `&at=lt.${enc(o.before)}`;
    if (o.module) q += `&module=eq.${enc(o.module)}`;
    return this.rest.select<OcpiLogEntry>("ocpi_log", q);
  }

  async getSimState<T>(key: string) {
    return (await this.rest.one<{ state: T }>("sim_state", `select=state&key=eq.${enc(key)}`))?.state ?? null;
  }
  async putSimState<T>(key: string, state: T) {
    await this.rest.insert("sim_state", { key, state, updated_at: iso(new Date()) }, { onConflict: "key", returning: false });
  }
}
