// Persistence boundary. Two implementations:
//  - SupabaseStore (Postgres via PostgREST) for production on Cloudflare Pages
//  - MemoryStore for the in-browser demo and the test-suite
import type {
  ApiKey, ApiKeyRow, FleetWebhookRow, AuditEntry, Brand, BookingEvent, BookingRow, Driver, Fleet, FleetInvite, Member, Membership, MemberRole, OcpiLogEntry, OcpiModule,
  Partner, StoredObject, Vehicle,
} from "../../shared/model";

export interface Page<T> {
  items: T[];
  total: number;
}

export interface Store {
  // tenancy -------------------------------------------------------------------
  getMemberships(userId: string): Promise<Membership[]>;
  isPlatformAdmin(userId: string): Promise<boolean>;
  getFleet(id: string): Promise<Fleet | null>;
  createFleet(name: string, owner: { id: string; email: string | null }): Promise<Fleet>;
  updateFleet(id: string, patch: Partial<Fleet>): Promise<Fleet>;
  /** Deletes the fleet and everything that belongs to it (team, invites, vehicles, drivers, bookings). */
  deleteFleet(id: string): Promise<void>;

  // team -------------------------------------------------------------------------
  listMembers(fleetId: string): Promise<Member[]>;
  /** User id of the team member (in any fleet) with this email, for account recovery by platform admins. */
  findMemberUserId(email: string): Promise<string | null>;
  /** Adds the user if they're not on the team yet; existing members keep their role. */
  addMember(fleetId: string, userId: string, role: MemberRole, email: string | null): Promise<void>;
  setMemberRole(fleetId: string, userId: string, role: MemberRole): Promise<void>;
  removeMember(fleetId: string, userId: string): Promise<void>;
  createInvite(invite: FleetInvite): Promise<FleetInvite>;
  /** Invites not accepted yet (expired ones included; the API filters). */
  listInvites(fleetId: string): Promise<FleetInvite[]>;
  getInvite(id: string): Promise<FleetInvite | null>;
  getInviteByToken(token: string): Promise<FleetInvite | null>;
  /** Claims the invite; false when someone else already used it. */
  markInviteAccepted(id: string, userId: string, at: string): Promise<boolean>;
  deleteInvite(id: string): Promise<void>;
  /** Re-seal stored pass and invite tokens with the current encryption key (stores that seal them). */
  resealLinkTokens?(): Promise<number>;

  // API keys --------------------------------------------------------------------
  /** The fleet's keys, newest first, revoked ones included (no hashes). */
  listWebhooks(fleetId: string): Promise<FleetWebhookRow[]>;
  createWebhook(row: FleetWebhookRow): Promise<void>;
  updateWebhook(id: string, patch: Partial<Pick<FleetWebhookRow, "active" | "last_attempt_at" | "last_status" | "last_error" | "failures" | "url" | "description" | "events">>): Promise<void>;
  deleteWebhook(id: string): Promise<void>;
  listApiKeys(fleetId: string): Promise<ApiKey[]>;
  createApiKey(row: ApiKeyRow): Promise<ApiKey>;
  findApiKeyByHash(hash: string): Promise<ApiKeyRow | null>;
  updateApiKey(id: string, patch: Partial<Pick<ApiKey, "last_used_at" | "revoked_at" | "name">>): Promise<void>;

  // platform settings -----------------------------------------------------------
  getBrand(): Promise<Brand | null>;
  setBrand(brand: Brand): Promise<void>;
  /** Other platform settings by key: "legal", "certifications", "compliance". */
  getSetting<T>(key: string): Promise<T | null>;
  setSetting<T>(key: string, value: T): Promise<void>;

  // audit log ----------------------------------------------------------------------
  addAudit(entry: AuditEntry): Promise<void>;
  /** Newest first. Without fleetId: platform-level entries only. */
  listAudit(opts: { fleetId?: string; limit: number }): Promise<AuditEntry[]>;
  /** Account deletion: keep the entries but drop the email of the person who acted. */
  anonymiseAuditActor(userId: string): Promise<void>;

  // fleet resources ---------------------------------------------------------------
  listVehicles(fleetId: string): Promise<Vehicle[]>;
  getVehicle(id: string): Promise<Vehicle | null>;
  upsertVehicle(v: Vehicle): Promise<Vehicle>;
  deleteVehicle(id: string): Promise<void>;
  findVehicleByToken(uid: string): Promise<Vehicle | null>;
  listTokenVehicles(opts: { offset: number; limit: number; dateFrom?: string; dateTo?: string }): Promise<Page<Vehicle>>;

  listDrivers(fleetId: string): Promise<Driver[]>;
  getDriver(id: string): Promise<Driver | null>;
  upsertDriver(d: Driver): Promise<Driver>;
  deleteDriver(id: string): Promise<void>;

  // OCPI partners -------------------------------------------------------------------
  listPartners(): Promise<Partner[]>;
  getPartner(id: string): Promise<Partner | null>;
  /** Matches the SHA-256 of the token the partner presents (our_token_hash), ignoring removed partners. */
  findPartnerByTokenHash(hash: string): Promise<Partner | null>;
  findPartnerByRegistrationHash(hash: string): Promise<Partner | null>;
  findPartnerByParty(countryCode: string, partyId: string): Promise<Partner | null>;
  upsertPartner(p: Partner): Promise<Partner>;

  // OCPI objects pushed/pulled from partners -------------------------------------------
  getObject<T>(module: OcpiModule, cc: string, pid: string, id: string): Promise<StoredObject<T> | null>;
  putObject<T>(obj: StoredObject<T>): Promise<void>;
  putObjects<T>(objs: StoredObject<T>[]): Promise<void>;
  deleteObject(module: OcpiModule, cc: string, pid: string, id: string): Promise<void>;
  listObjects<T>(module: OcpiModule): Promise<StoredObject<T>[]>;

  // bookings ------------------------------------------------------------------------------
  insertBooking(b: BookingRow): Promise<BookingRow>;
  updateBooking(id: string, patch: Partial<BookingRow>): Promise<BookingRow>;
  getBooking(id: string): Promise<BookingRow | null>;
  findBookingByRequestId(requestId: string): Promise<BookingRow | null>;
  findBookingByCpoRef(cc: string, pid: string, ref: string): Promise<BookingRow | null>; // ocpi_id or request_id
  findBookingByAuthRef(authRef: string): Promise<BookingRow | null>;
  findBookingByPassToken(token: string): Promise<BookingRow | null>;
  listBookings(fleetId: string, opts?: { from?: string; to?: string; limit?: number }): Promise<BookingRow[]>;
  listVehicleBookings(vehicleId: string, locationId: string): Promise<BookingRow[]>;

  addEvents(events: BookingEvent[]): Promise<void>;
  listEvents(fleetId: string, opts?: { since?: string; limit?: number }): Promise<BookingEvent[]>;

  // OCPI message log -------------------------------------------------------------------------
  addLogs(entries: OcpiLogEntry[]): Promise<void>;
  listLogs(opts: { limit: number; before?: string; module?: string }): Promise<OcpiLogEntry[]>;

  // simulator state (only used when the CPO simulator is enabled) ------------------------------
  getSimState<T>(key: string): Promise<T | null>;
  putSimState<T>(key: string, state: T): Promise<void>;
}
