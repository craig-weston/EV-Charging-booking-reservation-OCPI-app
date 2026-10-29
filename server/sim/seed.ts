// Seed data for the CPO simulator: three FICTIONAL charge point operators running HGV sites at real
// UK freight locations. Nothing here describes a real operator's network, prices or terms.
import type {
  BookingLocation, BookingTerms, ConnectorCapability, ConnectorType, EVSE, Facility, Location, Parking, Tariff, VehicleType,
} from "../../shared/ocpi/types";

export interface SimParty {
  country_code: string;
  party_id: string;
  name: string;
  website: string;
  help_phone: string;
}

export const SIM_PARTIES: SimParty[] = [
  { country_code: "GB", party_id: "VHL", name: "VoltHaul (demo)", website: "https://example.com/volthaul", help_phone: "+441632960101" },
  { country_code: "GB", party_id: "KCH", name: "Kestrel Charge (demo)", website: "https://example.com/kestrel", help_phone: "+441632960202" },
  { country_code: "GB", party_id: "DSN", name: "DepotShare (demo)", website: "https://example.com/depotshare", help_phone: "+441632960303" },
];

interface BayGroup {
  key: string; // option key, part of the BookingLocation id
  label: string;
  refs: string[]; // physical references of the EVSEs
  connector: ConnectorType;
  kw: number;
  caps: ConnectorCapability[];
  vehicleTypes: VehicleType[];
  maxWeight: number; // kg
  maxHeight: number; // cm
  maxLength: number; // cm
  maxWidth: number; // cm
  spaceLength: number;
  spaceWidth: number;
  adr: boolean;
  driveThrough: boolean;
  reefer: boolean;
  /** Local bookable hours [startHour, endHour) — may wrap past midnight. */
  hours?: [number, number];
  /** Weekly maintenance: ISO weekday (1=Mon), local hours. */
  maintenance?: { weekday: number; from: number; to: number };
  green?: [number, number]; // local hours with green energy
}

export interface TimedEnergyRate { price: number; start: string; end: string; days?: string[] }

interface SiteDef {
  id: string;
  party: string;
  name: string;
  address: string;
  city: string;
  postal_code: string;
  lat: number;
  lon: number;
  road: string; // shown in the UI, e.g. "M1 J18"
  parking_type: Location["parking_type"];
  facilities: Facility[];
  directions: string;
  terms: Partial<BookingTerms>;
  energyPrice: number;
  /** Time-of-use energy rates that override energyPrice in their hours (listed first in the tariff). */
  rates?: TimedEnergyRate[];
  booking: { flat: number; perHour: number; noShow: number; cancel: number; overtimePerHour: number };
  policyRequired?: boolean;
  bays: BayGroup[];
}

const HGV: VehicleType[] = ["TRUCK_WITH_TRAILER", "SEMI_TRACTOR", "RIGID"];
const ALL_HEAVY: VehicleType[] = ["TRUCK_WITH_TRAILER", "SEMI_TRACTOR", "RIGID", "BUS", "VAN"];
const PNC2: ConnectorCapability[] = ["ISO_15118_2_PLUG_AND_CHARGE"];
const PNC20: ConnectorCapability[] = ["ISO_15118_20_PLUG_AND_CHARGE", "ISO_15118_2_PLUG_AND_CHARGE"];
const AC: ConnectorCapability = "AUTOCHARGE";

const mcs = (refs: string[], extra: Partial<BayGroup> = {}): BayGroup => ({
  key: "MCS", label: "MCS drive-through lanes", refs, connector: "MCS", kw: 1000, caps: [...PNC20, AC],
  vehicleTypes: HGV, maxWeight: 44000, maxHeight: 450, maxLength: 2200, maxWidth: 300, spaceLength: 2400, spaceWidth: 400,
  adr: true, driveThrough: true, reefer: true, green: [10, 16], ...extra,
});
const ccs = (refs: string[], kw: number, extra: Partial<BayGroup> = {}): BayGroup => ({
  key: "CCS", label: "CCS HGV bays", refs, connector: "IEC_62196_T2_COMBO", kw, caps: [...PNC2, AC],
  vehicleTypes: ALL_HEAVY, maxWeight: 44000, maxHeight: 450, maxLength: 1900, maxWidth: 300, spaceLength: 1950, spaceWidth: 400,
  adr: false, driveThrough: false, reefer: false, ...extra,
});

const BASE_TERMS: BookingTerms = {
  rfid_auth_required: false,
  token_groups_supported: false,
  remote_auth_supported: true,
  supported_access_methods: ["LICENSE_PLATE", "TOKEN"],
  change_until_minutes: 60,
  cancel_until_minutes: 120,
  change_not_allowed: false,
  early_start_allowed: true,
  early_start_time: 20,
  noshow_timeout: 20,
  noshow_fee: true,
  late_stop_allowed: true,
  late_stop_time: 10,
  overlapping_bookings_allowed: false,
  min_booking_duration: 30,
  max_booking_duration: 120,
};

export const SITES: SiteDef[] = [
  {
    id: "VHL-DAV", party: "VHL", name: "VoltHaul Daventry DIRFT", address: "Danes Way, DIRFT", city: "Daventry", postal_code: "NN6 7GX",
    lat: 52.31985, lon: -1.16242, road: "M1 J18", parking_type: "PARKING_LOT", facilities: ["CAFE", "WIFI"],
    directions: "Leave the M1 at J18 and follow DIRFT signs. The charging hub is on Danes Way, entry lane 2.",
    terms: { booking_terms: "https://example.com/volthaul/booking-terms" }, energyPrice: 0.59,
    booking: { flat: 4, perHour: 6, noShow: 35, cancel: 15, overtimePerHour: 60 },
    bays: [mcs(["M1", "M2", "M3", "M4"], { maintenance: { weekday: 2, from: 1, to: 3 } }), ccs(["C1", "C2", "C3", "C4", "C5", "C6"], 400)],
  },
  {
    id: "VHL-LUT", party: "VHL", name: "VoltHaul Magna Park", address: "Magna Park, Mere Lane", city: "Lutterworth", postal_code: "LE17 4XN",
    lat: 52.43805, lon: -1.21401, road: "M1 J20, M6 J1", parking_type: "PARKING_LOT", facilities: ["CAFE"],
    directions: "From M1 J20 take the A4303 to Magna Park; the hub is opposite Gate 4.",
    terms: { booking_terms: "https://example.com/volthaul/booking-terms" }, energyPrice: 0.59,
    booking: { flat: 4, perHour: 6, noShow: 35, cancel: 15, overtimePerHour: 60 },
    bays: [ccs(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"], 400, { green: [10, 16] })],
  },
  {
    id: "VHL-SMM", party: "VHL", name: "VoltHaul South Mimms", address: "Bignells Corner", city: "Potters Bar", postal_code: "EN6 3QQ",
    lat: 51.68902, lon: -0.22305, road: "M25 J23, A1(M)", parking_type: "ALONG_MOTORWAY", facilities: ["RESTAURANT", "CAFE", "WIFI", "FUEL_STATION"],
    directions: "Leave the M25 at J23 and follow signs for the HGV park. Charging lanes are at the rear.",
    terms: { booking_terms: "https://example.com/volthaul/booking-terms" }, energyPrice: 0.62,
    booking: { flat: 4, perHour: 8, noShow: 40, cancel: 15, overtimePerHour: 75 },
    bays: [mcs(["M1", "M2"]), ccs(["C1", "C2", "C3", "C4"], 400)],
  },
  {
    id: "VHL-FXT", party: "VHL", name: "VoltHaul Felixstowe Port", address: "Walton Avenue", city: "Felixstowe", postal_code: "IP11 3HP",
    lat: 51.96194, lon: 1.32901, road: "A14, port", parking_type: "PARKING_LOT", facilities: ["CAFE", "WIFI"],
    directions: "Follow the A14 to the Dock Gate 2 roundabout, then Walton Avenue. Hub is next to the trailer park.",
    terms: { booking_terms: "https://example.com/volthaul/booking-terms" }, energyPrice: 0.6,
    booking: { flat: 4, perHour: 6, noShow: 35, cancel: 15, overtimePerHour: 60 },
    bays: [mcs(["M1", "M2"]), ccs(["C1", "C2", "C3", "C4", "C5", "C6"], 400, { reefer: true, adr: true })],
  },
  {
    id: "VHL-EUC", party: "VHL", name: "VoltHaul Eurocentral", address: "Maxim Park, Eurocentral", city: "Motherwell", postal_code: "ML1 4UF",
    lat: 55.84124, lon: -3.98102, road: "M8 J6, M73", parking_type: "PARKING_LOT", facilities: ["CAFE"],
    directions: "Leave the M8 at J6 for Eurocentral; the hub is at the north end of Maxim Park.",
    terms: { booking_terms: "https://example.com/volthaul/booking-terms" }, energyPrice: 0.57,
    booking: { flat: 4, perHour: 6, noShow: 35, cancel: 15, overtimePerHour: 60 },
    bays: [ccs(["C1", "C2", "C3", "C4", "C5", "C6"], 400)],
  },
  {
    id: "KCH-LYM", party: "KCH", name: "Kestrel Lymm Interchange", address: "Warrington Road", city: "Lymm", postal_code: "WA13 0SP",
    lat: 53.37086, lon: -2.45567, road: "M6 J20, M56", parking_type: "ALONG_MOTORWAY", facilities: ["RESTAURANT", "CAFE", "WIFI", "FUEL_STATION"],
    directions: "Leave the M6 at J20 (M56 J9) and follow the HGV signs. Charging is behind the fuel island.",
    terms: { change_until_minutes: 30, cancel_until_minutes: 60, noshow_timeout: 30, early_start_time: 30, max_booking_duration: 180, booking_terms: "https://example.com/kestrel/terms" },
    energyPrice: 0.64, booking: { flat: 3, perHour: 5, noShow: 30, cancel: 10, overtimePerHour: 50 },
    bays: [mcs(["M1", "M2"], { caps: [...PNC20, AC] }), ccs(["C1", "C2", "C3", "C4", "C5", "C6"], 400, { reefer: true })],
  },
  {
    id: "KCH-DON", party: "KCH", name: "Kestrel Doncaster iPort", address: "iPort Avenue", city: "Rossington", postal_code: "DN11 0BG",
    lat: 53.47205, lon: -1.09905, road: "M18 J3", parking_type: "PARKING_LOT", facilities: ["CAFE"],
    directions: "From M18 J3 take the Great Yorkshire Way to iPort; chargers are at the south car park.",
    terms: { change_until_minutes: 30, cancel_until_minutes: 60, noshow_timeout: 30, booking_terms: "https://example.com/kestrel/terms" },
    energyPrice: 0.61, booking: { flat: 3, perHour: 5, noShow: 30, cancel: 10, overtimePerHour: 50 },
    // Autocharge only — Plug & Charge trucks need driver action here.
    bays: [ccs(["C1", "C2", "C3", "C4", "C5", "C6"], 350, { caps: [AC] })],
  },
  {
    id: "KCH-AVO", party: "KCH", name: "Kestrel Avonmouth", address: "Kings Weston Lane", city: "Bristol", postal_code: "BS11 8DG",
    lat: 51.51012, lon: -2.69298, road: "M5 J18", parking_type: "PARKING_LOT", facilities: ["CAFE", "WIFI"],
    directions: "Leave the M5 at J18 and follow Avonmouth Docks; turn into Kings Weston Lane after the second roundabout.",
    terms: { change_until_minutes: 30, cancel_until_minutes: 60, booking_terms: "https://example.com/kestrel/terms" },
    energyPrice: 0.63, booking: { flat: 3, perHour: 5, noShow: 30, cancel: 10, overtimePerHour: 50 },
    bays: [
      ccs(["C1", "C2", "C3", "C4"], 400, { maxHeight: 420, maxLength: 1700, spaceLength: 1750 }),
      { ...ccs(["R1", "R2"], 180), key: "RIGID", label: "Rigid & van bays", vehicleTypes: ["RIGID", "VAN"], maxWeight: 26000, maxLength: 1200, spaceLength: 1250 },
    ],
  },
  {
    id: "KCH-CAR", party: "KCH", name: "Kestrel Carlisle Kingstown", address: "Kingstown Broadway", city: "Carlisle", postal_code: "CA6 4BY",
    lat: 54.92603, lon: -2.94798, road: "M6 J44", parking_type: "PARKING_LOT", facilities: ["CAFE", "FUEL_STATION"],
    directions: "Leave the M6 at J44; the site is the first left on Kingstown Broadway.",
    // Older site: RFID card needed at the charger.
    terms: { rfid_auth_required: true, supported_access_methods: ["LICENSE_PLATE", "TOKEN"], change_until_minutes: 30, cancel_until_minutes: 60, booking_terms: "https://example.com/kestrel/terms" },
    energyPrice: 0.6, booking: { flat: 3, perHour: 5, noShow: 30, cancel: 10, overtimePerHour: 50 },
    bays: [ccs(["C1", "C2", "C3", "C4"], 400, { caps: [] })],
  },
  {
    id: "KCH-WAK", party: "KCH", name: "Kestrel Wakefield Europort", address: "Europort Way", city: "Normanton", postal_code: "WF10 5QW",
    lat: 53.70496, lon: -1.39197, road: "M62 J31", parking_type: "PARKING_LOT", facilities: ["CAFE"],
    directions: "Leave the M62 at J31 for Wakefield Europort; charging is at the HGV park entrance.",
    terms: { change_until_minutes: 30, cancel_until_minutes: 60, booking_terms: "https://example.com/kestrel/terms" },
    energyPrice: 0.62, booking: { flat: 3, perHour: 5, noShow: 30, cancel: 10, overtimePerHour: 50 },
    bays: [mcs(["M1"]), ccs(["C1", "C2", "C3", "C4"], 400)],
  },
  {
    id: "DSN-NTH", party: "DSN", name: "Brackmills depot (Ridgeway Logistics)", address: "Brackmills Industrial Estate, Pavilion Drive", city: "Northampton", postal_code: "NN4 7PB",
    lat: 52.21894, lon: -0.85899, road: "M1 J15, A45", parking_type: "PARKING_LOT", facilities: [],
    directions: "Shared fleet depot. Enter via the north gate on Pavilion Drive; ANPR opens the barrier for booked plates.",
    terms: {
      change_until_minutes: 180, cancel_until_minutes: 240, early_start_time: 15, noshow_timeout: 45,
      min_booking_duration: 120, max_booking_duration: 600, late_stop_allowed: false, booking_terms: "https://example.com/depotshare/terms",
    },
    energyPrice: 0.42, booking: { flat: 12, perHour: 0, noShow: 25, cancel: 10, overtimePerHour: 40 }, policyRequired: true,
    bays: [ccs(["D1", "D2", "D3", "D4", "D5", "D6"], 180, { label: "Overnight depot bays", hours: [19, 6], maxLength: 1700, spaceLength: 1750, reefer: true, caps: [...PNC2, AC] })],
  },
  {
    id: "DSN-THU", party: "DSN", name: "West Thurrock depot (Estuary Freight)", address: "London Road", city: "Grays", postal_code: "RM20 3LP",
    lat: 51.4839, lon: 0.29701, road: "M25 J31, A13", parking_type: "PARKING_LOT", facilities: [],
    directions: "Shared fleet depot. Enter at the gatehouse on London Road and key in the access code.",
    terms: {
      supported_access_methods: ["ACCESS_CODE"], change_until_minutes: 180, cancel_until_minutes: 240, min_booking_duration: 60,
      max_booking_duration: 480, booking_terms: "https://example.com/depotshare/terms",
    },
    energyPrice: 0.44, booking: { flat: 10, perHour: 0, noShow: 25, cancel: 10, overtimePerHour: 40 }, policyRequired: true,
    bays: [ccs(["D1", "D2", "D3", "D4"], 150, { label: "Depot bays", hours: [18, 7], caps: [...PNC2] })],
  },
];

// Time-of-use pricing so cheaper and pricier hours show up in planning: VoltHaul has a night rate,
// Kestrel a weekday evening peak, DepotShare an overnight depot rate.
const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
const r2 = (n: number) => Math.round(n * 100) / 100;
for (const site of SITES) {
  if (site.rates) continue;
  if (site.party === "VHL") site.rates = [{ price: r2(site.energyPrice - 0.14), start: "22:00", end: "06:00" }];
  if (site.party === "KCH") site.rates = [{ price: r2(site.energyPrice + 0.12), start: "16:00", end: "19:00", days: WEEKDAYS }];
  if (site.party === "DSN") site.rates = [{ price: r2(site.energyPrice - 0.1), start: "00:00", end: "07:00" }];
}

export const SEED_TIMESTAMP = "2026-09-01T08:00:00Z";
const T = SEED_TIMESTAMP;

export function partyOf(site: SiteDef) {
  return SIM_PARTIES.find((p) => p.party_id === site.party)!;
}

export function blId(site: SiteDef, bay: BayGroup) {
  return `${site.id}-${bay.key}`;
}

export function buildLocation(site: SiteDef): Location {
  const party = partyOf(site);
  const evses: EVSE[] = [];
  const parking: Parking[] = [];
  site.bays.forEach((bay, gi) => {
    const parkingId = `P${gi + 1}`;
    parking.push({
      id: parkingId, physical_reference: bay.label.slice(0, 12), vehicle_types: bay.vehicleTypes,
      max_vehicle_weight: bay.maxWeight, max_vehicle_height: bay.maxHeight, max_vehicle_length: bay.maxLength, max_vehicle_width: bay.maxWidth,
      parking_space_length: bay.spaceLength, parking_space_width: bay.spaceWidth, dangerous_goods_allowed: bay.adr,
      direction: bay.driveThrough ? "PARALLEL" : "PERPENDICULAR", drive_through: bay.driveThrough, restricted_to_type: true,
      reservation_required: !!site.policyRequired, lighting: true, refrigeration_outlet: bay.reefer, roofed: bay.driveThrough,
    });
    for (const ref of bay.refs) {
      const watts = bay.kw * 1000;
      const voltage = bay.connector === "MCS" ? 1250 : 1000;
      evses.push({
        uid: `${site.id}-${ref}`,
        evse_id: `${party.country_code}*${party.party_id}*E${site.id.split("-")[1]}${ref}`,
        status: "AVAILABLE",
        capabilities: ["RESERVABLE", "REMOTE_START_STOP_CAPABLE", ...(site.terms.rfid_auth_required ? ["RFID_READER"] : [])],
        connectors: [{
          id: "1", standard: bay.connector, format: "CABLE", power_type: "DC", max_voltage: voltage,
          max_amperage: Math.round(watts / voltage), max_electric_power: watts, tariff_ids: [`${site.party}-ENERGY-${site.id}`],
          capabilities: bay.caps, last_updated: T,
        }],
        physical_reference: ref,
        parking: [{ parking_id: parkingId, evse_position: "LEFT" }],
        last_updated: T,
      });
    }
  });
  return {
    country_code: party.country_code, party_id: party.party_id, id: site.id, publish: true, name: site.name,
    address: site.address, city: site.city, postal_code: site.postal_code, country: "GBR",
    coordinates: { latitude: site.lat.toFixed(6), longitude: site.lon.toFixed(6) },
    parking_type: site.parking_type, evses, parking_places: parking,
    directions: [{ language: "en", text: site.directions }],
    related_locations: [{ latitude: site.lat.toFixed(6), longitude: site.lon.toFixed(6), name: { language: "en", text: site.road } }],
    operator: { name: party.name, website: party.website }, facilities: site.facilities, time_zone: "Europe/London",
    opening_times: { twentyfourseven: true }, charging_when_closed: true, help_phone: party.help_phone, last_updated: T,
  };
}

export function buildTariffs(site: SiteDef): Tariff[] {
  const party = partyOf(site);
  const base = { country_code: party.country_code, party_id: party.party_id, currency: "GBP", tax_included: "NO" as const, last_updated: T };
  const b = site.booking;
  return [
    {
      ...base, id: `${site.party}-ENERGY-${site.id}`, type: "REGULAR",
      tariff_alt_text: [{ language: "en", text: `£${site.energyPrice.toFixed(2)} per kWh + VAT${(site.rates ?? []).map((r) => `, £${r.price.toFixed(2)} ${r.start}–${r.end}${r.days ? " weekdays" : ""}`).join("")}` }],
      elements: [
        ...(site.rates ?? []).map((r) => ({ price_components: [{ type: "ENERGY" as const, price: r.price, vat: 20, step_size: 1 }], restrictions: { start_time: r.start, end_time: r.end, ...(r.days ? { day_of_week: r.days } : {}) } })),
        { price_components: [{ type: "ENERGY", price: site.energyPrice, vat: 20, step_size: 1 }] },
      ],
    },
    {
      ...base, id: `${site.party}-BOOKING-${site.id}`,
      tariff_alt_text: [{ language: "en", text: `Booking £${b.flat.toFixed(2)}${b.perHour ? ` + £${b.perHour.toFixed(2)}/h` : ""}. No-show £${b.noShow}. Late cancellation £${b.cancel}.` }],
      elements: [
        { price_components: [{ type: "FLAT", price: b.flat, vat: 20, step_size: 1 }, ...(b.perHour ? [{ type: "TIME" as const, price: b.perHour, vat: 20, step_size: 900 }] : [])], restrictions: { booking: "BOOKING" } },
        { price_components: [{ type: "FLAT", price: b.noShow, vat: 20, step_size: 1 }], restrictions: { booking: "BOOKING_EXPIRES" } },
        { price_components: [{ type: "FLAT", price: b.cancel, vat: 20, step_size: 1 }], restrictions: { booking: "BOOKING_CANCELLATION_FEES" } },
        { price_components: [{ type: "TIME", price: b.overtimePerHour, vat: 20, step_size: 60 }], restrictions: { booking: "BOOKING_OVERTIME" } },
      ],
    },
  ];
}

export interface SimOption {
  site: SiteDef;
  bay: BayGroup;
  bl: Omit<BookingLocation, "calendars">;
  evseUids: string[];
}

export function buildOptions(): SimOption[] {
  const out: SimOption[] = [];
  for (const site of SITES) {
    const party = partyOf(site);
    site.bays.forEach((bay, gi) => {
      out.push({
        site, bay,
        evseUids: bay.refs.map((r) => `${site.id}-${r}`),
        bl: {
          country_code: party.country_code, party_id: party.party_id, id: blId(site, bay), location_id: site.id,
          booking_option: {
            evse_uid: "#NA", parking_id: `P${gi + 1}`, evse_position: ["LEFT"], vehicle_types: bay.vehicleTypes,
            connector_format: ["CABLE"], connector_types: [bay.connector], power_types: ["DC"],
            max_vehicle_weight: bay.maxWeight, max_vehicle_height: bay.maxHeight, max_vehicle_length: bay.maxLength,
            max_vehicle_width: bay.maxWidth, min_parking_space_length: bay.spaceLength, min_parking_space_width: bay.spaceWidth,
            dangerous_goods_allowed: bay.adr, drive_through: bay.driveThrough, refrigeration_outlet: bay.reefer,
          },
          policy: { reservation_required: !!site.policyRequired, ...(site.policyRequired ? {} : { ad_hoc: Math.max(1, Math.floor(bay.refs.length / 3)) }) },
          tariff_ids: [`${site.party}-ENERGY-${site.id}`, `${site.party}-BOOKING-${site.id}`],
          booking_terms: { ...BASE_TERMS, ...site.terms },
          last_updated: T,
        },
      });
    });
  }
  return out;
}
