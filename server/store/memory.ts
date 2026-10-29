import type { DepotVisit } from "../../shared/energy/depot";
// In-memory Store — used by the browser demo (persisted to localStorage) and by the tests.
import type {
  ApiKey, ApiKeyRow, FleetWebhookRow, FleetEnergyRow, Brand, BookingEvent, BookingRow, Driver, Fleet, FleetInvite, Member, Membership, MemberRole, OcpiLogEntry, OcpiModule,
  Partner, StoredObject, Vehicle, AuditEntry,
} from "../../shared/model";
import { iso, upper, uuid } from "../../shared/util";
import type { Page, Store } from "./types";

export interface MemoryData {
  fleets: Fleet[];
  members: Member[];
  invites: FleetInvite[];
  admins: string[];
  brand: Brand | null;
  vehicles: Vehicle[];
  drivers: Driver[];
  partners: Partner[];
  objects: StoredObject[];
  bookings: BookingRow[];
  events: BookingEvent[];
  logs: OcpiLogEntry[];
  sim: Record<string, unknown>;
  settings: Record<string, unknown>;
  audit: AuditEntry[];
  apiKeys: ApiKeyRow[];
  webhooks?: FleetWebhookRow[];
  energy?: FleetEnergyRow[];
  depotVisits?: DepotVisit[];
}

export function emptyData(): MemoryData {
  return { fleets: [], members: [], invites: [], admins: [], brand: null, vehicles: [], drivers: [], partners: [], objects: [], bookings: [], events: [], logs: [], sim: {}, settings: {}, audit: [], apiKeys: [], webhooks: [], energy: [], depotVisits: [] };
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const objKey = (m: string, cc: string, pid: string, id: string) => `${m}|${upper(cc)}|${upper(pid)}|${id}`;

export class MemoryStore implements Store {
  data: MemoryData;
  private listeners = new Set<() => void>();
  private notifyScheduled = false;
  maxLogs = 400;

  constructor(data?: Partial<MemoryData>) {
    // Fill in collections added after the data was saved (older demo snapshots in localStorage).
    this.data = { ...emptyData(), ...(data ?? {}) };
  }

  /** Subscribe to any write. Returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const l of this.listeners) l();
    });
  }

  // tenancy ------------------------------------------------------------------
  async getMemberships(userId: string): Promise<Membership[]> {
    return this.data.members
      .filter((m) => m.user_id === userId)
      .map((m) => {
        const f = this.data.fleets.find((x) => x.id === m.fleet_id);
        return { fleet_id: m.fleet_id, user_id: m.user_id, role: m.role, fleet_name: f?.name ?? "", require_mfa: !!f?.require_mfa };
      });
  }
  async isPlatformAdmin(userId: string) {
    return this.data.admins.includes(userId);
  }
  async getFleet(id: string) {
    return clone(this.data.fleets.find((f) => f.id === id) ?? null);
  }
  async createFleet(name: string, owner: { id: string; email: string | null }) {
    const now = iso(new Date());
    const f: Fleet = {
      id: uuid(), name, desk_phone: null, allow_unbooked_charging: true, require_mfa: false, notify_drivers: "off",
      terms_version: null, terms_accepted_at: null, terms_accepted_by: null, created_at: now, updated_at: now,
    };
    this.data.fleets.push(f);
    this.data.members.push({ fleet_id: f.id, user_id: owner.id, role: "owner", email: owner.email, created_at: now });
    this.changed();
    return clone(f);
  }
  async updateFleet(id: string, patch: Partial<Fleet>) {
    const f = this.data.fleets.find((x) => x.id === id);
    if (!f) throw new Error("fleet not found");
    Object.assign(f, clone(patch), { updated_at: iso(new Date()) });
    this.changed();
    return clone(f);
  }
  async deleteFleet(id: string) {
    const bookingIds = new Set(this.data.bookings.filter((b) => b.fleet_id === id).map((b) => b.id));
    this.data.fleets = this.data.fleets.filter((f) => f.id !== id);
    this.data.members = this.data.members.filter((m) => m.fleet_id !== id);
    this.data.invites = this.data.invites.filter((i) => i.fleet_id !== id);
    this.data.apiKeys = this.data.apiKeys.filter((k) => k.fleet_id !== id);
    this.data.vehicles = this.data.vehicles.filter((v) => v.fleet_id !== id);
    this.data.drivers = this.data.drivers.filter((d) => d.fleet_id !== id);
    this.data.bookings = this.data.bookings.filter((b) => b.fleet_id !== id);
    this.data.events = this.data.events.filter((e) => e.fleet_id !== id);
    this.data.energy = (this.data.energy ?? []).filter((e) => e.fleet_id !== id);
    this.data.depotVisits = (this.data.depotVisits ?? []).filter((v) => v.fleet_id !== id);
    for (const l of this.data.logs) if (l.booking_id && bookingIds.has(l.booking_id)) l.booking_id = null;
    this.changed();
  }
  // team ---------------------------------------------------------------------------
  async listMembers(fleetId: string) {
    return clone(this.data.members.filter((m) => m.fleet_id === fleetId).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")));
  }
  async findMemberUserId(email: string) {
    const e = email.trim().toLowerCase();
    return this.data.members.find((m) => (m.email ?? "").toLowerCase() === e)?.user_id ?? null;
  }
  async addMember(fleetId: string, userId: string, role: MemberRole, email: string | null) {
    if (!this.data.members.some((m) => m.fleet_id === fleetId && m.user_id === userId)) {
      this.data.members.push({ fleet_id: fleetId, user_id: userId, role, email, created_at: iso(new Date()) });
      this.changed();
    }
  }
  async setMemberRole(fleetId: string, userId: string, role: MemberRole) {
    const m = this.data.members.find((x) => x.fleet_id === fleetId && x.user_id === userId);
    if (m) { m.role = role; this.changed(); }
  }
  async removeMember(fleetId: string, userId: string) {
    this.data.members = this.data.members.filter((m) => !(m.fleet_id === fleetId && m.user_id === userId));
    this.changed();
  }
  async createInvite(invite: FleetInvite) {
    this.data.invites.push(clone(invite));
    this.changed();
    return clone(invite);
  }
  async listInvites(fleetId: string) {
    return clone(this.data.invites.filter((i) => i.fleet_id === fleetId && !i.accepted_at).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  }
  async getInvite(id: string) {
    return clone(this.data.invites.find((i) => i.id === id) ?? null);
  }
  async getInviteByToken(token: string) {
    return clone(this.data.invites.find((i) => i.token === token) ?? null);
  }
  async markInviteAccepted(id: string, userId: string, at: string) {
    const i = this.data.invites.find((x) => x.id === id);
    if (!i || i.accepted_at) return false;
    i.accepted_by = userId;
    i.accepted_at = at;
    this.changed();
    return true;
  }
  async deleteInvite(id: string) {
    this.data.invites = this.data.invites.filter((i) => i.id !== id);
    this.changed();
  }

  // API keys -----------------------------------------------------------------------
  async listWebhooks(fleetId: string) {
    return clone((this.data.webhooks ?? []).filter((w) => w.fleet_id === fleetId).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  }
  async createWebhook(row: FleetWebhookRow) {
    (this.data.webhooks ??= []).push(clone(row));
    this.changed();
  }
  async updateWebhook(id: string, patch: Partial<FleetWebhookRow>) {
    const w = (this.data.webhooks ?? []).find((x) => x.id === id);
    if (w) { Object.assign(w, clone(patch)); this.changed(); }
  }
  async deleteWebhook(id: string) {
    this.data.webhooks = (this.data.webhooks ?? []).filter((w) => w.id !== id);
    this.changed();
  }
  // depot energy ---------------------------------------------------------------------
  async getEnergy(fleetId: string) {
    const r = (this.data.energy ?? []).find((e) => e.fleet_id === fleetId);
    return r ? clone(r) : null;
  }
  async saveEnergy(row: FleetEnergyRow) {
    const list = (this.data.energy ??= []);
    const i = list.findIndex((e) => e.fleet_id === row.fleet_id);
    if (i >= 0) list[i] = clone(row); else list.push(clone(row));
    this.changed();
  }
  async listEnergy() {
    return clone(this.data.energy ?? []);
  }
  async listDepotVisits(fleetId: string, fromIso: string) {
    return clone((this.data.depotVisits ?? []).filter((v) => v.fleet_id === fleetId && v.depart_at >= fromIso).sort((a, b) => a.arrive_at.localeCompare(b.arrive_at)));
  }
  async upsertDepotVisit(v: DepotVisit) {
    const list = (this.data.depotVisits ??= []);
    const i = list.findIndex((x) => x.id === v.id);
    if (i >= 0) list[i] = clone(v); else list.push(clone(v));
    this.changed();
    return clone(v);
  }
  async deleteDepotVisit(id: string) {
    this.data.depotVisits = (this.data.depotVisits ?? []).filter((v) => v.id !== id);
    this.changed();
  }
  async listApiKeys(fleetId: string): Promise<ApiKey[]> {
    return clone(this.data.apiKeys.filter((k) => k.fleet_id === fleetId).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ key_hash: _h, ...k }) => k));
  }
  async createApiKey(row: ApiKeyRow): Promise<ApiKey> {
    this.data.apiKeys.push(clone(row));
    this.changed();
    const { key_hash: _h, ...k } = row;
    return clone(k);
  }
  async findApiKeyByHash(hash: string) {
    return clone(this.data.apiKeys.find((k) => k.key_hash === hash) ?? null);
  }
  async updateApiKey(id: string, patch: Partial<Pick<ApiKey, "last_used_at" | "revoked_at" | "name">>) {
    const k = this.data.apiKeys.find((x) => x.id === id);
    if (k) { Object.assign(k, clone(patch)); this.changed(); }
  }

  async getBrand() {
    return clone(this.data.brand);
  }
  async setBrand(brand: Brand) {
    this.data.brand = clone(brand);
    this.changed();
  }

  // vehicles & drivers ---------------------------------------------------------------
  async listVehicles(fleetId: string) {
    return clone(this.data.vehicles.filter((v) => v.fleet_id === fleetId).sort((a, b) => a.name.localeCompare(b.name)));
  }
  async getVehicle(id: string) {
    return clone(this.data.vehicles.find((v) => v.id === id) ?? null);
  }
  async upsertVehicle(v: Vehicle) {
    const i = this.data.vehicles.findIndex((x) => x.id === v.id);
    const clash = this.data.vehicles.find((x) => x.id !== v.id && (upper(x.token_uid) === upper(v.token_uid) || (x.fleet_id === v.fleet_id && upper(x.plate).replace(/\s/g, "") === upper(v.plate).replace(/\s/g, ""))));
    if (clash) throw Object.assign(new Error(upper(clash.token_uid) === upper(v.token_uid) ? "Another vehicle already uses this charging ID" : "A vehicle with this number plate already exists"), { status: 409 });
    if (i >= 0) this.data.vehicles[i] = clone(v);
    else this.data.vehicles.push(clone(v));
    this.changed();
    return clone(v);
  }
  async deleteVehicle(id: string) {
    this.data.vehicles = this.data.vehicles.filter((v) => v.id !== id);
    this.changed();
  }
  async findVehicleByToken(uid: string) {
    return clone(this.data.vehicles.find((v) => upper(v.token_uid) === upper(uid)) ?? null);
  }
  async listTokenVehicles(opts: { offset: number; limit: number; dateFrom?: string; dateTo?: string }): Promise<Page<Vehicle>> {
    const all = this.data.vehicles
      .filter((v) => !opts.dateFrom || v.updated_at >= opts.dateFrom)
      .filter((v) => !opts.dateTo || v.updated_at < opts.dateTo)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { items: clone(all.slice(opts.offset, opts.offset + opts.limit)), total: all.length };
  }
  async listDrivers(fleetId: string) {
    return clone(this.data.drivers.filter((d) => d.fleet_id === fleetId).sort((a, b) => a.name.localeCompare(b.name)));
  }
  async getDriver(id: string) {
    return clone(this.data.drivers.find((d) => d.id === id) ?? null);
  }
  async upsertDriver(d: Driver) {
    const i = this.data.drivers.findIndex((x) => x.id === d.id);
    if (i >= 0) this.data.drivers[i] = clone(d);
    else this.data.drivers.push(clone(d));
    this.changed();
    return clone(d);
  }
  async deleteDriver(id: string) {
    this.data.drivers = this.data.drivers.filter((d) => d.id !== id);
    for (const b of this.data.bookings) if (b.driver_id === id) b.driver_id = null;
    this.changed();
  }

  // partners ---------------------------------------------------------------------------
  async listPartners() {
    return clone([...this.data.partners].sort((a, b) => a.created_at.localeCompare(b.created_at)));
  }
  async getPartner(id: string) {
    return clone(this.data.partners.find((p) => p.id === id) ?? null);
  }
  async findPartnerByTokenHash(hash: string) {
    return clone(this.data.partners.find((p) => p.our_token_hash === hash && p.status !== "REMOVED") ?? null);
  }
  async findPartnerByRegistrationHash(hash: string) {
    return clone(this.data.partners.find((p) => p.registration_token_hash === hash && p.status === "PENDING") ?? null);
  }
  async findPartnerByParty(cc: string, pid: string) {
    return clone(
      this.data.partners.find((p) => p.status !== "REMOVED" && p.roles.some((r) => upper(r.country_code) === upper(cc) && upper(r.party_id) === upper(pid))) ?? null,
    );
  }
  async upsertPartner(p: Partner) {
    const i = this.data.partners.findIndex((x) => x.id === p.id);
    if (i >= 0) this.data.partners[i] = clone(p);
    else this.data.partners.push(clone(p));
    this.changed();
    return clone(p);
  }

  // OCPI objects -------------------------------------------------------------------------
  private objIndex = new Map<string, number>();
  private reindex() {
    this.objIndex.clear();
    this.data.objects.forEach((o, i) => this.objIndex.set(objKey(o.module, o.country_code, o.party_id, o.id), i));
  }
  private findObj(m: string, cc: string, pid: string, id: string) {
    if (this.objIndex.size !== this.data.objects.length) this.reindex();
    const i = this.objIndex.get(objKey(m, cc, pid, id));
    return i == null ? -1 : i;
  }
  async getObject<T>(module: OcpiModule, cc: string, pid: string, id: string) {
    const i = this.findObj(module, cc, pid, id);
    return i < 0 ? null : (clone(this.data.objects[i]) as StoredObject<T>);
  }
  async putObject<T>(obj: StoredObject<T>) {
    const o = clone({ ...obj, country_code: upper(obj.country_code), party_id: upper(obj.party_id) }) as StoredObject;
    const i = this.findObj(o.module, o.country_code, o.party_id, o.id);
    if (i >= 0) this.data.objects[i] = o;
    else {
      this.data.objects.push(o);
      this.objIndex.set(objKey(o.module, o.country_code, o.party_id, o.id), this.data.objects.length - 1);
    }
    this.changed();
  }
  async putObjects<T>(objs: StoredObject<T>[]) {
    for (const o of objs) await this.putObject(o);
  }
  async deleteObject(module: OcpiModule, cc: string, pid: string, id: string) {
    const i = this.findObj(module, cc, pid, id);
    if (i >= 0) {
      this.data.objects.splice(i, 1);
      this.reindex();
      this.changed();
    }
  }
  async listObjects<T>(module: OcpiModule) {
    return clone(this.data.objects.filter((o) => o.module === module)) as StoredObject<T>[];
  }

  // bookings -------------------------------------------------------------------------------
  async insertBooking(b: BookingRow) {
    this.data.bookings.push(clone(b));
    this.changed();
    return clone(b);
  }
  async updateBooking(id: string, patch: Partial<BookingRow>) {
    const b = this.data.bookings.find((x) => x.id === id);
    if (!b) throw new Error("booking not found");
    Object.assign(b, clone(patch), { updated_at: iso(new Date()) });
    this.changed();
    return clone(b);
  }
  async getBooking(id: string) {
    return clone(this.data.bookings.find((b) => b.id === id) ?? null);
  }
  async findBookingByRequestId(requestId: string) {
    return clone(this.data.bookings.find((b) => b.request_id === requestId) ?? null);
  }
  async findBookingByCpoRef(cc: string, pid: string, ref: string) {
    const mine = this.data.bookings.filter((b) => upper(b.cpo_country_code) === upper(cc) && upper(b.cpo_party_id) === upper(pid));
    return clone(mine.find((b) => b.ocpi_id === ref) ?? mine.find((b) => b.request_id === ref) ?? null);
  }
  async findBookingByAuthRef(authRef: string) {
    return clone(this.data.bookings.find((b) => b.authorization_reference === authRef) ?? null);
  }
  async findBookingByPassToken(token: string) {
    return clone(this.data.bookings.find((b) => b.pass_token === token) ?? null);
  }
  async listBookings(fleetId: string, opts: { from?: string; to?: string; limit?: number } = {}) {
    return clone(
      this.data.bookings
        .filter((b) => b.fleet_id === fleetId)
        .filter((b) => !opts.from || b.end_at >= opts.from)
        .filter((b) => !opts.to || b.start_at < opts.to)
        .sort((a, b) => a.start_at.localeCompare(b.start_at))
        .slice(0, opts.limit ?? 500),
    );
  }
  async listVehicleBookings(vehicleId: string, locationId: string) {
    return clone(this.data.bookings.filter((b) => b.vehicle_id === vehicleId && b.location_id === locationId));
  }
  async addEvents(events: BookingEvent[]) {
    this.data.events.push(...clone(events));
    if (this.data.events.length > 3000) this.data.events.splice(0, this.data.events.length - 3000);
    this.changed();
  }
  async listEvents(fleetId: string, opts: { since?: string; limit?: number } = {}) {
    return clone(
      this.data.events
        .filter((e) => e.fleet_id === fleetId && (!opts.since || e.at >= opts.since))
        .sort((a, b) => b.at.localeCompare(a.at) || Number(b.id > a.id) - Number(b.id < a.id))
        .slice(0, opts.limit ?? 300),
    );
  }

  // log ---------------------------------------------------------------------------------------
  async addLogs(entries: OcpiLogEntry[]) {
    this.data.logs.push(...clone(entries));
    if (this.data.logs.length > this.maxLogs) this.data.logs.splice(0, this.data.logs.length - this.maxLogs);
    this.changed();
  }
  async listLogs(opts: { limit: number; before?: string; module?: string }) {
    return clone(
      [...this.data.logs]
        .reverse()
        .filter((l) => !opts.before || l.at < opts.before)
        .filter((l) => !opts.module || l.module === opts.module)
        .slice(0, opts.limit),
    );
  }

  async getSetting<T>(key: string) {
    return clone((this.data.settings[key] as T | undefined) ?? null);
  }
  async setSetting<T>(key: string, value: T) {
    this.data.settings[key] = clone(value);
    this.changed();
  }
  async addAudit(entry: AuditEntry) {
    this.data.audit.push(clone(entry));
    if (this.data.audit.length > 2000) this.data.audit.splice(0, this.data.audit.length - 2000);
    this.changed();
  }
  async listAudit(opts: { fleetId?: string; limit: number }) {
    return clone(
      this.data.audit
        .filter((e) => (opts.fleetId ? e.fleet_id === opts.fleetId : e.fleet_id === null))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, opts.limit),
    );
  }
  async anonymiseAuditActor(userId: string) {
    for (const e of this.data.audit) if (e.actor_id === userId) e.actor_email = null;
    this.changed();
  }
  async getSimState<T>(key: string) {
    return clone((this.data.sim[key] as T) ?? null);
  }
  async putSimState<T>(key: string, state: T) {
    this.data.sim[key] = clone(state);
    this.changed();
  }
}
