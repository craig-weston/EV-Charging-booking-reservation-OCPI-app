-- Depot energy: a fleet's own depots (chargers, grid limit, tariff, control) and trucks' depot
-- visits, for smart charging. Run after 20261101000000_fleet_webhooks.sql.
--
--  * fleet_energy.config is the depot settings (shared/energy/depot.ts → EnergyConfig).
--  * fleet_energy.secrets holds credentials sealed with DATA_ENCRYPTION_KEY (AES-256-GCM).
--  * fleet_energy.state remembers the last schedules sent to each depot's chargers.
--  * Service role only, like webhooks: the app's API checks fleet membership and roles.

create table if not exists public.fleet_energy (
  fleet_id uuid primary key references public.fleets(id) on delete cascade,
  config jsonb not null default '{"depots": []}'::jsonb,
  secrets jsonb not null default '{}'::jsonb,
  state jsonb not null default '{"dispatch": {}}'::jsonb,
  updated_at timestamptz not null default now()
);
comment on column public.fleet_energy.secrets is 'Per-depot credentials sealed with DATA_ENCRYPTION_KEY. Never sent to browsers.';
alter table public.fleet_energy enable row level security;
revoke all on public.fleet_energy from anon, authenticated;
grant all on public.fleet_energy to service_role;

create table if not exists public.depot_visits (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  depot_id text not null check (char_length(depot_id) <= 60),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  charger_id text check (char_length(charger_id) <= 60),
  arrive_at timestamptz not null,
  depart_at timestamptz not null,
  soc_start numeric not null check (soc_start between 0 and 100),
  soc_target numeric not null check (soc_target between 0 and 100),
  status text not null default 'planned' check (status in ('planned', 'plugged_in', 'done', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (depart_at > arrive_at)
);
create index if not exists depot_visits_fleet_depart_idx on public.depot_visits (fleet_id, depart_at);
alter table public.depot_visits enable row level security;
revoke all on public.depot_visits from anon, authenticated;
grant all on public.depot_visits to service_role;
