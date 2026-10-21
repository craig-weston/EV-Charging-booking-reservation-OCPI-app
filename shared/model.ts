// Application domain model shared by the web app, the Pages Functions and the tests.
import type {
  Booking, BookingRequest, CDR, CanceledReason, ConnectorType, CredentialsRole, Endpoint,
  ReservationStatus, Session, TokenType, VehicleType,
} from "./ocpi/types";

export type StartMethod = "PLUG_AND_CHARGE" | "AUTOCHARGE";
export type MemberRole = "owner" | "planner" | "viewer";

export interface Fleet {
  id: string;
  name: string;
  desk_phone: string | null;
  allow_unbooked_charging: boolean;
  /** Everyone on the team must sign in with two-step verification (authenticator app). */
  require_mfa: boolean;
  /** Version of the terms of service the owner accepted for the organisation, and when / by whom. */
  terms_version: string | null;
  terms_accepted_at: string | null;
  terms_accepted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Membership {
  fleet_id: string;
  user_id: string;
  role: MemberRole;
  fleet_name: string;
  /** The fleet requires two-step verification. */
  require_mfa?: boolean;
}

/** A person on a fleet's team (Settings → Team). */
export interface Member {
  fleet_id: string;
  user_id: string;
  role: MemberRole;
  email: string | null;
  created_at: string;
}

/** A single-use link that adds whoever opens it (signed in) to a fleet. */
export interface FleetInvite {
  id: string;
  fleet_id: string;
  /** Who it was meant for; shown in the team list, not enforced. */
  email: string | null;
  role: MemberRole;
  token: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
}

export interface TeamView {
  members: Member[];
  /** Pending invites; only returned to owners. */
  invites: FleetInvite[];
}

/** What someone holding an invite link sees before joining. */
export interface InvitePreview {
  fleet_name: string;
  role: MemberRole;
  email: string | null;
  expires_at: string;
  /** True when the signed-in user is already on this fleet's team. */
  already_member: boolean;
}

export interface Vehicle {
  id: string;
  fleet_id: string;
  name: string;
  plate: string; // display form, e.g. "PN74 EVH"
  make_model: string | null;
  vehicle_type: VehicleType;
  gross_weight_kg: number | null;
  height_cm: number | null;
  length_cm: number | null;
  width_cm: number | null;
  connector_types: ConnectorType[];
  max_charge_kw: number | null;
  battery_kwh: number | null;
  start_method: StartMethod;
  /** EMAID (Plug & Charge contract) or Autocharge vehicle id, e.g. "VID:3C2A9B4E1F07". */
  token_uid: string;
  /** eMSP contract id used in BookingToken.contract_id. */
  contract_id: string;
  dangerous_goods: boolean;
  needs_reefer_outlet: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Driver {
  id: string;
  fleet_id: string;
  name: string;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface PendingAction {
  kind: "CHANGE" | "CANCEL";
  requested_at: string;
  start_at?: string;
  end_at?: string;
  reason?: CanceledReason;
}

export interface SessionSummary {
  id: string;
  status: Session["status"];
  kwh: number;
  start_date_time: string;
  end_date_time?: string;
  evse_uid: string;
  total_cost?: number;
  currency: string;
  last_updated: string;
  /** Battery state of charge in %, from the Session's STATE_OF_CHARGE charging-period dimension (if the CPO sends it). */
  soc?: number | null;
  /** State of charge when the session started. */
  soc_start?: number | null;
  /** Latest POWER dimension in kW while the session is active. */
  power_kw?: number | null;
}

export interface CdrSummary {
  id: string;
  total_energy: number;
  total_time: number;
  total_cost: number;
  total_cost_incl_tax?: number;
  total_reservation_cost?: number;
  currency: string;
  start_date_time: string;
  end_date_time: string;
}

export interface BookingRow {
  id: string;
  fleet_id: string;
  vehicle_id: string | null;
  driver_id: string | null;
  created_by: string | null;
  partner_id: string | null;
  cpo_country_code: string;
  cpo_party_id: string;
  location_id: string;
  booking_location_id: string;
  request_id: string;
  authorization_reference: string;
  ocpi_id: string | null;
  reservation_status: ReservationStatus;
  start_at: string;
  end_at: string;
  power_required_kw: number | null;
  evse_uid: string | null;
  plate: string;
  token_uid: string;
  token_type: TokenType;
  last_request: BookingRequest;
  booking: Booking | null;
  pending_action: PendingAction | null;
  session: SessionSummary | null;
  cdr: CdrSummary | null;
  pass_token: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type BookingEventKind =
  | "REQUESTED" | "PENDING" | "RESERVED" | "REJECTED" | "FAILED" | "CANCELED" | "NO_SHOW" | "FULFILLED"
  | "CHANGE_REQUESTED" | "CHANGE_ACCEPTED" | "CHANGE_DECLINED" | "CANCEL_REQUESTED" | "CANCEL_DECLINED"
  | "BAY_ASSIGNED" | "AUTHORIZED" | "SESSION_STARTED" | "SESSION_COMPLETED" | "CDR_RECEIVED" | "NOTE";

export interface BookingEvent {
  id: string;
  booking_id: string;
  fleet_id: string;
  at: string;
  kind: BookingEventKind;
  message: string;
  data?: Record<string, unknown> | null;
}

export type PartnerStatus = "PENDING" | "CONNECTED" | "SUSPENDED" | "REMOVED";

export interface Partner {
  id: string;
  name: string;
  status: PartnerStatus;
  versions_url: string | null;
  version: string | null;
  endpoints: Endpoint[];
  roles: CredentialsRole[];
  /** SHA-256 of the CREDENTIALS_TOKEN_A we issued so the partner can register with us (shown once). */
  registration_token_hash: string | null;
  /** SHA-256 of the token the partner presents to us (we issued it; never stored in clear). */
  our_token_hash: string | null;
  /** Last characters of the most recent token we issued, for display ("…k3Qz"). */
  token_hint: string | null;
  /** Token we present to the partner (they issued it). Encrypted at rest when DATA_ENCRYPTION_KEY is set. */
  their_token: string | null;
  is_simulator: boolean;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export type OcpiModule = "locations" | "tariffs" | "booking_locations" | "sessions" | "cdrs";

export interface StoredObject<T = unknown> {
  module: OcpiModule;
  country_code: string;
  party_id: string;
  id: string;
  data: T;
  last_updated: string;
  partner_id: string | null;
}

export interface OcpiLogEntry {
  id: string;
  at: string;
  direction: "IN" | "OUT";
  partner_id: string | null;
  party: string | null; // "GB*VHL"
  module: string | null;
  method: string;
  url: string;
  http_status: number | null;
  status_code: number | null;
  request_id: string | null;
  correlation_id: string | null;
  request_body: unknown;
  response_body: unknown;
  duration_ms: number | null;
  booking_id: string | null;
}

export interface Brand {
  name: string;
  /** Optional logo (https URL or data: URL). When empty, a monogram is drawn from the name. */
  logo_url: string;
  /** Primary colour, any CSS hex colour. Every tint in the UI is derived from it. */
  primary_color: string;
  support_email: string;
  support_phone: string;
  /** Show a small "Powered by …" line in the footer of the driver pass. */
  show_powered_by: boolean;
}

export const DEFAULT_BRAND: Brand = {
  name: "Depotcharge",
  logo_url: "",
  primary_color: "#2F5BEA",
  support_email: "",
  support_phone: "",
  show_powered_by: false,
};

export interface AppConfig {
  mode: "live" | "demo";
  supabase_url: string | null;
  supabase_anon_key: string | null;
  simulator: boolean;
  party: { country_code: string; party_id: string; name: string };
  brand: Brand;
  ocpi_versions_url: string;
  /** Who runs this platform (shown on legal pages and in the footer). */
  legal: LegalInfo;
  /** Certificates that are currently valid (expired ones are left out). */
  certifications: Certification[];
  /** Current version of the terms of service and privacy notice. */
  terms_version: string;
  security: { require_admin_mfa: boolean; password_min_length: number };
}

/** The legal entity operating the platform. Required disclosures for a UK company website. */
export interface LegalInfo {
  company_name: string; // registered name, e.g. "Depotcharge Ltd"
  trading_name: string;
  company_number: string; // Companies House number
  registered_office: string;
  place_of_registration: string; // "England and Wales"
  vat_number: string;
  contact_email: string;
  privacy_email: string; // data protection contact
  ico_number: string; // ICO registration (data protection fee) reference
  security_contact: string; // where to report vulnerabilities
  email_provider: string; // SMTP provider used for sign-in emails (a sub-processor), e.g. "Postmark"
  hosting_region: string; // where the database lives, e.g. "London, UK (AWS eu-west-2)"
}

export const EMPTY_LEGAL: LegalInfo = {
  company_name: "", trading_name: "", company_number: "", registered_office: "", place_of_registration: "England and Wales",
  vat_number: "", contact_email: "", privacy_email: "", ico_number: "", security_contact: "", email_provider: "", hosting_region: "",
};

export type CertificationScheme = "Cyber Essentials" | "Cyber Essentials Plus" | "ISO/IEC 27001";

/** A certificate held by the operator. Shown only while valid, with a link to verify it. */
export interface Certification {
  scheme: CertificationScheme;
  certificate_number: string;
  issued_on: string; // YYYY-MM-DD
  expires_on: string; // YYYY-MM-DD
  certification_body: string;
  verify_url: string;
}

/** Security-relevant actions, kept for 12 months (see the retention schedule). */
export interface AuditEntry {
  id: string;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  fleet_id: string | null; // null: platform-level
  action: string; // e.g. "member.role", "fleet.mfa_required", "partner.connect"
  target: string | null;
  data: Record<string, unknown> | null;
  ip: string | null;
}

/** Everything the planner UI needs to show and filter sites. */
export interface NetworkSnapshot {
  operators: { country_code: string; party_id: string; name: string; partner_id: string | null; is_simulator: boolean }[];
  locations: StoredObject<import("./ocpi/types").Location>[];
  booking_locations: StoredObject<import("./ocpi/types").BookingLocation>[];
  tariffs: StoredObject<import("./ocpi/types").Tariff>[];
  generated_at: string;
}

export interface PassView {
  brand: Brand;
  status: ReservationStatus;
  pending_action: PendingAction | null;
  start_at: string;
  end_at: string;
  plate: string;
  vehicle_name: string | null;
  vehicle_type: VehicleType | null;
  start_method: StartMethod | null;
  power_kw: number | null;
  driver_name: string | null;
  fleet_name: string;
  desk_phone: string | null;
  site: {
    name: string;
    address: string;
    city: string;
    postal_code: string | null;
    lat: number;
    lon: number;
    time_zone: string;
    operator: string;
    help_phone: string | null;
    directions: string | null;
  };
  bay: string | null;
  access_methods: string[];
  terms: import("./ocpi/types").BookingTerms | null;
  session: SessionSummary | null;
}

export type { Booking, BookingRequest, CDR, Session };
