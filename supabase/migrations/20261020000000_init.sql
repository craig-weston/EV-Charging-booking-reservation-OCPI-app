-- Depotcharge — initial schema (Supabase / Postgres 15+)
-- Run once in the Supabase SQL editor, or with `supabase db push`.
--
-- Access model
--   * The Cloudflare Pages Functions use the service-role (secret) key: they bypass RLS and
--     enforce fleet membership in code (server/api/router.ts).
--   * RLS below is defence in depth for anything that talks to Supabase directly with a user
--     session (e.g. if you add supabase-js reads or Realtime later).

-- ---------------------------------------------------------------- helpers
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- tenancy
create table public.fleets (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  desk_phone text,
  allow_unbooked_charging boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.fleet_members (
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'planner' check (role in ('owner', 'planner', 'viewer')),
  email text, -- copied from auth.users when they join, for the team list
  created_at timestamptz not null default now(),
  primary key (fleet_id, user_id)
);
create index fleet_members_user_idx on public.fleet_members (user_id);

-- Single-use invite links (Settings → Team). The token is the secret: service role only.
create table public.fleet_invites (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  email text,
  role text not null default 'planner' check (role in ('owner', 'planner', 'viewer')),
  token text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz
);
create index fleet_invites_fleet_idx on public.fleet_invites (fleet_id) where accepted_at is null;

-- Platform operators (you): can manage OCPI partners, branding and the message log.
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- White-label settings (key 'brand' → Brand JSON: name, logo_url, primary_color, …).
create table public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- fleet resources
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  name text not null,
  plate text not null,
  make_model text,
  vehicle_type text not null default 'TRUCK_WITH_TRAILER'
    check (vehicle_type in ('TRUCK_WITH_TRAILER', 'SEMI_TRACTOR', 'RIGID', 'VAN', 'BUS')),
  gross_weight_kg integer check (gross_weight_kg >= 0),
  height_cm integer check (height_cm >= 0),
  length_cm integer check (length_cm >= 0),
  width_cm integer check (width_cm >= 0),
  connector_types text[] not null default array['IEC_62196_T2_COMBO'],
  max_charge_kw integer,
  battery_kwh integer,
  start_method text not null default 'PLUG_AND_CHARGE' check (start_method in ('PLUG_AND_CHARGE', 'AUTOCHARGE')),
  token_uid text not null check (char_length(token_uid) between 1 and 36),   -- EMAID or Autocharge "VID:…"
  contract_id text not null check (char_length(contract_id) between 1 and 36),
  dangerous_goods boolean not null default false,
  needs_reefer_outlet boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index vehicles_token_uid_key on public.vehicles (token_uid);
create unique index vehicles_fleet_plate_key on public.vehicles (fleet_id, (upper(regexp_replace(plate, '[^A-Za-z0-9]', '', 'g'))));
create index vehicles_fleet_idx on public.vehicles (fleet_id);
create index vehicles_autocharge_idx on public.vehicles (created_at) where start_method = 'AUTOCHARGE';

create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  name text not null,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index drivers_fleet_idx on public.drivers (fleet_id);

-- ---------------------------------------------------------------- OCPI
-- One row per connected OCPI platform (may host several CPO roles, see `roles`).
create table public.ocpi_partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'CONNECTED', 'SUSPENDED', 'REMOVED')),
  versions_url text,
  version text,
  endpoints jsonb not null default '[]'::jsonb,      -- Endpoint[] from their version details
  roles jsonb not null default '[]'::jsonb,          -- CredentialsRole[] (country_code/party_id upper-case)
  registration_token text unique,                    -- CREDENTIALS_TOKEN_A we issued (inbound registration)
  our_token text unique,                             -- token they present to us
  their_token text,                                  -- token we present to them
  is_simulator boolean not null default false,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ocpi_partners_roles_idx on public.ocpi_partners using gin (roles jsonb_path_ops);

-- Client-owned objects received from CPOs (Locations, Tariffs, BookingLocations, Sessions, CDRs).
create table public.ocpi_objects (
  module text not null check (module in ('locations', 'tariffs', 'booking_locations', 'sessions', 'cdrs')),
  country_code text not null,
  party_id text not null,
  id text not null,
  data jsonb not null,
  last_updated timestamptz not null,
  partner_id uuid references public.ocpi_partners(id) on delete set null,
  received_at timestamptz not null default now(),
  primary key (module, country_code, party_id, id)
);
create index ocpi_objects_auth_ref_idx on public.ocpi_objects ((data ->> 'authorization_reference')) where module in ('sessions', 'cdrs');

-- Bookings made by fleets (our side of OCPI Booking objects).
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  driver_id uuid references public.drivers(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  partner_id uuid references public.ocpi_partners(id) on delete set null,
  cpo_country_code text not null,
  cpo_party_id text not null,
  location_id text not null,
  booking_location_id text not null,
  request_id text not null unique,                   -- BookingRequest.request_id (same for every edit)
  authorization_reference text not null unique,      -- links Sessions / CDRs / real-time authorisation
  ocpi_id text,                                      -- Booking.id on the CPO side
  reservation_status text not null default 'PENDING'
    check (reservation_status in ('PENDING', 'RESERVED', 'CANCELED', 'FAILED', 'NO_SHOW', 'FULFILLED', 'REJECTED', 'UNKNOWN')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  power_required_kw integer,
  evse_uid text,
  plate text not null,
  token_uid text not null,
  token_type text not null,
  last_request jsonb not null,                       -- last BookingRequest we sent
  booking jsonb,                                     -- latest Booking object from the CPO
  pending_action jsonb,                              -- in-flight change / cancellation
  session jsonb,                                     -- latest Session summary
  cdr jsonb,                                         -- CDR summary
  pass_token text not null unique,                   -- driver pass link secret
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index bookings_fleet_start_idx on public.bookings (fleet_id, start_at);
create index bookings_vehicle_location_idx on public.bookings (vehicle_id, location_id);
create unique index bookings_cpo_ref_key on public.bookings (cpo_country_code, cpo_party_id, ocpi_id) where ocpi_id is not null;

create table public.booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  message text not null,
  data jsonb
);
create index booking_events_fleet_at_idx on public.booking_events (fleet_id, at desc);
create index booking_events_booking_idx on public.booking_events (booking_id, at);

-- Every OCPI request in or out (for support and certification testing).
create table public.ocpi_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  direction text not null check (direction in ('IN', 'OUT')),
  partner_id uuid references public.ocpi_partners(id) on delete set null,
  party text,
  module text,
  method text not null,
  url text not null,
  http_status integer,
  status_code integer,
  request_id text,
  correlation_id text,
  request_body jsonb,
  response_body jsonb,
  duration_ms integer,
  booking_id uuid references public.bookings(id) on delete set null
);
create index ocpi_log_at_idx on public.ocpi_log (at desc);
create index ocpi_log_module_at_idx on public.ocpi_log (module, at desc);

-- State of the built-in CPO simulator (only used with ENABLE_CPO_SIMULATOR=true).
create table public.sim_state (
  key text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- updated_at triggers
create trigger fleets_updated_at before update on public.fleets for each row execute function public.set_updated_at();
create trigger vehicles_updated_at before update on public.vehicles for each row execute function public.set_updated_at();
create trigger drivers_updated_at before update on public.drivers for each row execute function public.set_updated_at();
create trigger ocpi_partners_updated_at before update on public.ocpi_partners for each row execute function public.set_updated_at();
create trigger bookings_updated_at before update on public.bookings for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- row level security
create or replace function public.is_fleet_member(f uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.fleet_members m where m.fleet_id = f and m.user_id = auth.uid());
$$;

create or replace function public.is_fleet_writer(f uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.fleet_members m where m.fleet_id = f and m.user_id = auth.uid() and m.role in ('owner', 'planner'));
$$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins a where a.user_id = auth.uid());
$$;

revoke execute on function public.is_fleet_member(uuid) from anon;
revoke execute on function public.is_fleet_writer(uuid) from anon;
revoke execute on function public.is_platform_admin() from anon;

alter table public.fleets enable row level security;
alter table public.fleet_members enable row level security;
alter table public.fleet_invites enable row level security;
alter table public.platform_admins enable row level security;
alter table public.platform_settings enable row level security;
alter table public.vehicles enable row level security;
alter table public.drivers enable row level security;
alter table public.ocpi_partners enable row level security;
alter table public.ocpi_objects enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_events enable row level security;
alter table public.ocpi_log enable row level security;
alter table public.sim_state enable row level security;

create policy fleets_read on public.fleets for select to authenticated using (public.is_fleet_member(id));
create policy fleet_members_read on public.fleet_members for select to authenticated using (user_id = auth.uid() or public.is_fleet_member(fleet_id));
create policy platform_admins_read on public.platform_admins for select to authenticated using (user_id = auth.uid());
create policy platform_settings_read on public.platform_settings for select to anon, authenticated using (key = 'brand');

create policy vehicles_read on public.vehicles for select to authenticated using (public.is_fleet_member(fleet_id));
create policy vehicles_write on public.vehicles for all to authenticated using (public.is_fleet_writer(fleet_id)) with check (public.is_fleet_writer(fleet_id));
create policy drivers_read on public.drivers for select to authenticated using (public.is_fleet_member(fleet_id));
create policy drivers_write on public.drivers for all to authenticated using (public.is_fleet_writer(fleet_id)) with check (public.is_fleet_writer(fleet_id));

create policy bookings_read on public.bookings for select to authenticated using (public.is_fleet_member(fleet_id));
create policy booking_events_read on public.booking_events for select to authenticated using (public.is_fleet_member(fleet_id));

-- Network data (sites, bays, prices) is readable by any signed-in user; sessions/CDRs are not.
create policy ocpi_objects_read on public.ocpi_objects for select to authenticated using (module in ('locations', 'tariffs', 'booking_locations'));
create policy ocpi_partners_admin on public.ocpi_partners for select to authenticated using (public.is_platform_admin());
create policy ocpi_log_admin on public.ocpi_log for select to authenticated using (public.is_platform_admin());
-- fleet_invites, sim_state: no policies → service role only.
