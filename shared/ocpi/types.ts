// OCPI 2.3.0 + Bookings module 1.1 (2.3.0-booking-1.1) types.
// Field names, cardinality and enum values follow the specification:
// https://github.com/ocpi/ocpi/tree/2.3.0/release/bookings  (mod_bookings.asciidoc)
//
// Cardinality: `?` → optional property, `*` → optional array, `+` → required non-empty array.

export type DateTime = string; // RFC 3339, UTC ("2026-10-20T12:00:00Z")
export type CiString = string;
export type URL = string;

export interface DisplayText {
  language: string; // ISO 639-1
  text: string;
}

// ---------------------------------------------------------------- Transport / common
export interface OcpiResponse<T = unknown> {
  data?: T;
  status_code: number;
  status_message?: string;
  timestamp: DateTime;
}

export const OCPI_STATUS = {
  SUCCESS: 1000,
  CLIENT_ERROR: 2000,
  INVALID_PARAMS: 2001,
  NOT_ENOUGH_INFO: 2002,
  UNKNOWN_LOCATION: 2003,
  UNKNOWN_TOKEN: 2004,
  SERVER_ERROR: 3000,
  UNABLE_TO_USE_CLIENT_API: 3001,
  UNSUPPORTED_VERSION: 3002,
  NO_MATCHING_ENDPOINTS: 3003,
} as const;

export type Role = "CPO" | "EMSP" | "NAP" | "NSP" | "OTHER" | "SCSP";
export type InterfaceRole = "SENDER" | "RECEIVER";

export interface Version {
  version: string;
  url: URL;
}
export interface Endpoint {
  identifier: string; // ModuleID (OpenEnum)
  role: InterfaceRole;
  url: URL;
}
export interface VersionDetails {
  version: string;
  endpoints: Endpoint[];
}

export interface BusinessDetails {
  name: string;
  website?: URL;
  logo?: Image;
}
export interface CredentialsRole {
  role: Role;
  business_details: BusinessDetails;
  party_id: CiString;
  country_code: CiString;
}
export interface Credentials {
  token: string;
  url: URL;
  hub_party_id?: CiString;
  roles: CredentialsRole[];
}

export interface Price {
  before_taxes: number;
  taxes?: TaxAmount[];
}
export interface TaxAmount {
  name: string;
  account_number?: string;
  percentage?: number;
  amount: number;
}

// ---------------------------------------------------------------- Locations (2.3.0)
export type VehicleType =
  | "MOTORCYCLE"
  | "PERSONAL_VEHICLE"
  | "PERSONAL_VEHICLE_WITH_TRAILER"
  | "VAN"
  | "SEMI_TRACTOR"
  | "RIGID"
  | "TRUCK_WITH_TRAILER"
  | "BUS"
  | "DISABLED";

export type ConnectorType =
  | "CHADEMO" | "CHAOJI" | "GBT_AC" | "GBT_DC" | "IEC_62196_T1" | "IEC_62196_T1_COMBO"
  | "IEC_62196_T2" | "IEC_62196_T2_COMBO" | "IEC_62196_T3A" | "IEC_62196_T3C" | "MCS"
  | "IEC_60309_2_single_16" | "IEC_60309_2_three_16" | "IEC_60309_2_three_32" | "IEC_60309_2_three_64"
  | "DOMESTIC_G" | "TESLA_S" | "NACS"
  | (string & {}); // OpenEnum

export type ConnectorFormat = "SOCKET" | "CABLE";
export type PowerType = "AC_1_PHASE" | "AC_2_PHASE" | "AC_2_PHASE_SPLIT" | "AC_3_PHASE" | "DC";

/** ConnectorCapability is an OpenEnum. `AUTOCHARGE` is this platform's extension (see README). */
export type ConnectorCapability =
  | "ISO_15118_2_PLUG_AND_CHARGE"
  | "ISO_15118_20_PLUG_AND_CHARGE"
  | "AUTOCHARGE"
  | (string & {});

export type Capability =
  | "CHARGING_PROFILE_CAPABLE" | "CHARGING_PREFERENCES_CAPABLE" | "CHIP_CARD_SUPPORT"
  | "CONTACTLESS_CARD_SUPPORT" | "CREDIT_CARD_PAYABLE" | "DEBIT_CARD_PAYABLE" | "PED_TERMINAL"
  | "REMOTE_START_STOP_CAPABLE" | "RESERVABLE" | "RFID_READER" | "START_SESSION_CONNECTOR_REQUIRED"
  | "TOKEN_GROUP_CAPABLE" | "UNLOCK_CAPABLE" | (string & {});

export type EVSEStatus =
  | "AVAILABLE" | "BLOCKED" | "CHARGING" | "INOPERATIVE" | "OUTOFORDER"
  | "PLANNED" | "REMOVED" | "RESERVED" | "UNKNOWN";

export type EVSEPosition = "LEFT" | "RIGHT" | "CENTER";
export type ParkingDirection = "PARALLEL" | "PERPENDICULAR" | "ANGLE";
export type ParkingType =
  | "ALONG_MOTORWAY" | "PARKING_GARAGE" | "PARKING_LOT" | "ON_DRIVEWAY" | "ON_STREET" | "UNDERGROUND_GARAGE"
  | (string & {});
export type Facility =
  | "HOTEL" | "RESTAURANT" | "CAFE" | "MALL" | "SUPERMARKET" | "SPORT" | "RECREATION_AREA" | "NATURE"
  | "MUSEUM" | "BIKE_SHARING" | "BUS_STOP" | "TAXI_STAND" | "TRAM_STOP" | "METRO_STATION"
  | "TRAIN_STATION" | "AIRPORT" | "PARKING_LOT" | "CARPOOL_PARKING" | "FUEL_STATION" | "WIFI"
  | (string & {});

export interface GeoLocation {
  latitude: string;
  longitude: string;
}
export interface Image {
  url: URL;
  thumbnail?: URL;
  category: string;
  type: string;
  width?: number;
  height?: number;
}
export interface RegularHours {
  weekday: number; // 1 = Monday … 7 = Sunday
  period_begin: string; // "06:00"
  period_end: string;
}
export interface ExceptionalPeriod {
  period_begin: DateTime;
  period_end: DateTime;
}
export interface Hours {
  twentyfourseven: boolean;
  regular_hours?: RegularHours[];
  exceptional_openings?: ExceptionalPeriod[];
  exceptional_closings?: ExceptionalPeriod[];
}

export interface Connector {
  id: CiString;
  standard: ConnectorType;
  format: ConnectorFormat;
  power_type: PowerType;
  max_voltage: number;
  max_amperage: number;
  max_electric_power?: number; // W
  tariff_ids?: CiString[];
  terms_and_conditions?: URL;
  capabilities?: ConnectorCapability[];
  last_updated: DateTime;
}

export interface EVSEParking {
  parking_id: CiString;
  evse_position?: EVSEPosition;
}

export interface EVSE {
  uid: CiString;
  evse_id?: CiString;
  status: EVSEStatus;
  status_schedule?: { period_begin: DateTime; period_end?: DateTime; status: EVSEStatus }[];
  capabilities?: Capability[];
  connectors: Connector[];
  floor_level?: string;
  coordinates?: GeoLocation;
  physical_reference?: string;
  directions?: DisplayText[];
  parking_restrictions?: string[];
  parking?: EVSEParking[];
  images?: Image[];
  accepted_service_providers?: string[];
  last_updated: DateTime;
}

export interface Parking {
  id: CiString;
  physical_reference?: string;
  vehicle_types: VehicleType[];
  max_vehicle_weight?: number; // kg
  max_vehicle_height?: number; // cm
  max_vehicle_length?: number; // cm
  max_vehicle_width?: number; // cm
  parking_space_length?: number; // cm
  parking_space_width?: number; // cm
  dangerous_goods_allowed?: boolean;
  direction?: ParkingDirection;
  drive_through?: boolean;
  restricted_to_type: boolean;
  reservation_required: boolean;
  time_limit?: number;
  roofed?: boolean;
  images?: Image[];
  lighting?: boolean;
  refrigeration_outlet?: boolean;
  standards?: string[];
  apds_reference?: string;
}

export interface Location {
  country_code: CiString;
  party_id: CiString;
  id: CiString;
  publish: boolean;
  publish_allowed_to?: unknown[];
  name?: string;
  address: string;
  city: string;
  postal_code?: string;
  state?: string;
  country: string; // ISO 3166-1 alpha-3
  coordinates: GeoLocation;
  related_locations?: unknown[];
  parking_type?: ParkingType;
  evses?: EVSE[];
  parking_places?: Parking[];
  directions?: DisplayText[];
  operator?: BusinessDetails;
  suboperator?: BusinessDetails;
  owner?: BusinessDetails;
  facilities?: Facility[];
  time_zone: string;
  opening_times?: Hours;
  charging_when_closed?: boolean;
  images?: Image[];
  energy_mix?: unknown;
  help_phone?: CiString;
  last_updated: DateTime;
}

// ---------------------------------------------------------------- Tariffs
export type TariffDimensionType = "ENERGY" | "FLAT" | "PARKING_TIME" | "TIME";
export type TariffType = "AD_HOC_PAYMENT" | "PROFILE_CHEAP" | "PROFILE_FAST" | "PROFILE_GREEN" | "REGULAR";
export type TaxIncluded = "YES" | "NO" | "N/A";
export type ReservationRestrictionType = "RESERVATION" | "RESERVATION_EXPIRES";
export type BookingRestrictionType = "BOOKING" | "BOOKING_EXPIRES" | "BOOKING_CANCELLATION_FEES" | "BOOKING_OVERTIME";

export interface PriceComponent {
  type: TariffDimensionType;
  price: number;
  vat?: number;
  step_size: number;
}
export interface TariffRestrictions {
  start_time?: string;
  end_time?: string;
  start_date?: string;
  end_date?: string;
  min_kwh?: number;
  max_kwh?: number;
  min_current?: number;
  max_current?: number;
  min_power?: number;
  max_power?: number;
  min_duration?: number;
  max_duration?: number;
  day_of_week?: string[];
  reservation?: ReservationRestrictionType;
  booking?: BookingRestrictionType;
}
export interface TariffElement {
  price_components: PriceComponent[];
  restrictions?: TariffRestrictions;
}
export interface PriceLimit {
  before_taxes: number;
  after_taxes?: number;
}
export interface Tariff {
  country_code: CiString;
  party_id: CiString;
  id: CiString;
  currency: string;
  type?: TariffType;
  tariff_alt_text?: DisplayText[];
  tariff_alt_url?: URL;
  min_price?: PriceLimit;
  max_price?: PriceLimit;
  elements: TariffElement[];
  tax_included: TaxIncluded;
  start_date_time?: DateTime;
  end_date_time?: DateTime;
  energy_mix?: unknown;
  last_updated: DateTime;
}

// ---------------------------------------------------------------- Tokens
export type TokenType = "AD_HOC_USER" | "APP_USER" | "EMAID" | "OTHER" | "RFID" | (string & {});
export type WhitelistType = "ALWAYS" | "ALLOWED" | "ALLOWED_OFFLINE" | "NEVER";
export type AllowedType = "ALLOWED" | "BLOCKED" | "EXPIRED" | "NO_CREDIT" | "NOT_ALLOWED";

export interface Token {
  country_code: CiString;
  party_id: CiString;
  uid: CiString;
  type: TokenType;
  contract_id: CiString;
  visual_number?: string;
  issuer: string;
  group_id?: CiString;
  valid: boolean;
  whitelist: WhitelistType;
  language?: string;
  default_profile_type?: string;
  energy_contract?: { supplier_name: string; contract_id?: string };
  last_updated: DateTime;
}
export interface LocationReferences {
  location_id: CiString;
  evse_uids?: CiString[];
}
export interface AuthorizationInfo {
  allowed: AllowedType;
  token: Token;
  location?: LocationReferences;
  authorization_reference?: CiString;
  info?: DisplayText;
}

// ---------------------------------------------------------------- Sessions & CDRs
export type AuthMethod = "AUTH_REQUEST" | "COMMAND" | "WHITELIST";
export type SessionStatus = "ACTIVE" | "COMPLETED" | "INVALID" | "PENDING" | "RESERVATION";
export type CdrDimensionType =
  | "CURRENT" | "ENERGY" | "ENERGY_EXPORT" | "ENERGY_IMPORT" | "MAX_CURRENT" | "MIN_CURRENT"
  | "MAX_POWER" | "MIN_POWER" | "PARKING_TIME" | "POWER" | "RESERVATION_TIME" | "STATE_OF_CHARGE" | "TIME";

export interface CdrToken {
  country_code: CiString;
  party_id: CiString;
  uid: CiString;
  type: TokenType;
  contract_id: CiString;
}
export interface CdrDimension {
  type: CdrDimensionType;
  volume: number;
}
export interface ChargingPeriod {
  start_date_time: DateTime;
  dimensions: CdrDimension[];
  tariff_id?: CiString;
}
export interface Session {
  country_code: CiString;
  party_id: CiString;
  id: CiString;
  start_date_time: DateTime;
  end_date_time?: DateTime;
  kwh: number;
  cdr_token: CdrToken;
  auth_method: AuthMethod;
  authorization_reference?: CiString;
  location_id: CiString;
  evse_uid: CiString;
  connector_id: CiString;
  meter_id?: string;
  currency: string;
  charging_periods?: ChargingPeriod[];
  total_cost?: Price;
  status: SessionStatus;
  last_updated: DateTime;
}
export interface CdrLocation {
  id: CiString;
  name?: string;
  address: string;
  city: string;
  postal_code?: string;
  state?: string;
  country: string;
  coordinates: GeoLocation;
  evse_uid: CiString;
  evse_id: CiString;
  connector_id: CiString;
  connector_standard: ConnectorType;
  connector_format: ConnectorFormat;
  connector_power_type: PowerType;
}
export interface CDR {
  country_code: CiString;
  party_id: CiString;
  id: CiString;
  start_date_time: DateTime;
  end_date_time: DateTime;
  booking_id?: CiString; // added by the Bookings module
  session_id?: CiString;
  cdr_token: CdrToken;
  auth_method: AuthMethod;
  authorization_reference?: CiString;
  cdr_location: CdrLocation;
  meter_id?: string;
  currency: string;
  tariffs?: Tariff[];
  charging_periods: ChargingPeriod[];
  signed_data?: unknown;
  total_cost: Price;
  total_fixed_cost?: Price;
  total_energy: number;
  total_energy_cost?: Price;
  total_time: number;
  total_time_cost?: Price;
  total_parking_time?: number;
  total_parking_cost?: Price;
  total_reservation_cost?: Price;
  remark?: string;
  invoice_reference_id?: CiString;
  credit?: boolean;
  credit_reference_id?: CiString;
  home_charging_compensation?: boolean;
  last_updated: DateTime;
}

// ---------------------------------------------------------------- Bookings module 1.1
export type AccessMethod = "OPEN" | "TOKEN" | "LICENSE_PLATE" | "ACCESS_CODE" | "INTERCOM" | "PARKING_TICKET";

export interface AccessInformation {
  method: AccessMethod;
  value?: string;
}

export interface BookingOption {
  evse_uid?: CiString; // may be "#NA" when not yet assigned
  connector_id?: CiString;
  parking_id?: CiString;
  evse_position?: EVSEPosition[];
  vehicle_types?: VehicleType[];
  connector_format?: ConnectorFormat[];
  connector_types?: ConnectorType[];
  power_types?: PowerType[];
  max_vehicle_weight?: number; // kg
  max_vehicle_height?: number; // cm
  max_vehicle_length?: number; // cm
  max_vehicle_width?: number; // cm
  min_parking_space_length?: number; // cm
  min_parking_space_width?: number; // cm
  dangerous_goods_allowed?: boolean;
  drive_through?: boolean;
  refrigeration_outlet?: boolean;
}

export interface Policy {
  reservation_required: boolean;
  ad_hoc?: number;
}

export interface BookingTerms {
  rfid_auth_required?: boolean;
  token_groups_supported?: boolean;
  remote_auth_supported?: boolean;
  supported_access_methods: AccessMethod[];
  change_until_minutes: number;
  cancel_until_minutes: number;
  change_not_allowed?: boolean;
  early_start_allowed?: boolean;
  early_start_time?: number;
  noshow_timeout?: number;
  noshow_fee?: boolean;
  late_stop_allowed?: boolean;
  late_stop_time?: number;
  overlapping_bookings_allowed?: boolean;
  min_booking_duration?: number;
  max_booking_duration?: number;
  booking_terms?: URL;
}

/** Timeslot — `min_power` / `max_power` are in Watts per the specification. */
export interface Timeslot {
  start_date_time: DateTime;
  end_date_time: DateTime;
  min_power?: number;
  max_power?: number;
  green_energy_support?: boolean;
}

export interface Period {
  start_date_time: DateTime;
  end_date_time: DateTime;
}

export interface Calendar {
  id: CiString;
  begin_from: DateTime;
  end_before: DateTime;
  timeslot_increment?: number; // minutes
  available_timeslots: Timeslot[];
  last_updated: DateTime;
}

export interface BookingLocation {
  country_code: CiString;
  party_id: CiString;
  id: CiString;
  location_id: CiString;
  booking_option?: BookingOption;
  policy?: Policy;
  tariff_ids?: CiString[];
  booking_terms?: BookingTerms;
  calendars?: Calendar[];
  last_updated: DateTime;
}

export interface BookingToken {
  country_code: CiString;
  party_id: CiString;
  uid: CiString;
  type: TokenType;
  contract_id: CiString;
}

export type CanceledReason =
  | "POWER_OUTAGE" | "BROKEN_CHARGER" | "FULL" | "BLOCKED" | "TRAFFIC" | "BROKEN_VEHICLE" | "NO_CANCELED" | "UNKNOWN";

export interface Cancellation {
  cancellation_reason: CanceledReason;
  who_canceled: Role;
}

export interface BookingRequest {
  country_code: CiString; // of the eMSP
  party_id: CiString; // of the eMSP
  request_id: CiString;
  booking_option?: BookingOption;
  location_id: CiString;
  booking_location_id: CiString;
  tokens?: BookingToken[];
  access_information?: AccessInformation[];
  period: Period;
  authorization_reference: CiString;
  power_required?: number; // kW
  canceled?: Cancellation;
}

export type ReservationRequestStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "FAILED";
export type ReservationStatus =
  | "PENDING" | "RESERVED" | "CANCELED" | "FAILED" | "NO_SHOW" | "FULFILLED" | "REJECTED" | "UNKNOWN";

export interface BookingRequestStatus {
  request_status: ReservationRequestStatus;
  booking_request: BookingRequest;
  request_received: DateTime;
}

export interface Booking {
  id: CiString; // CPO side id
  country_code: CiString; // of the CPO
  party_id: CiString; // of the CPO
  request_id: CiString;
  booking_option?: BookingOption;
  location_id: CiString;
  booking_tokens?: BookingToken[];
  tariff_ids?: CiString[];
  period: Timeslot;
  reservation_status: ReservationStatus;
  canceled?: Cancellation;
  access_information?: AccessInformation[];
  authorization_reference: CiString;
  booking_terms: BookingTerms;
  booking_requests: BookingRequestStatus[];
  last_updated: DateTime;
}

export const FINAL_RESERVATION_STATUSES: ReservationStatus[] = ["CANCELED", "NO_SHOW", "REJECTED", "FAILED", "FULFILLED"];

/** The "not available" marker OCPI uses for ids that are not assigned yet. */
export const NOT_AVAILABLE = "#NA";
