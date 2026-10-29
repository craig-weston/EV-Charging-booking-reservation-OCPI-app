-- Grid flexibility events (NESO Demand Flexibility Service, local network / DNO flexibility,
-- Balancing Mechanism) offered to a fleet's depots by an aggregator, what we committed and what it
-- earned. Run after 20261103000000_smart_charging.sql. Service role only.
create table if not exists public.flex_events (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  depot_id text not null check (char_length(depot_id) <= 60),
  provider_event_id text check (char_length(provider_event_id) <= 120),
  programme text not null check (programme in ('DFS', 'DNO', 'BM')),
  direction text not null check (direction in ('down', 'up')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  price_per_mwh numeric not null check (price_per_mwh >= 0),
  requested_kw numeric,
  status text not null default 'offered' check (status in ('offered', 'accepted', 'declined', 'delivered', 'settled', 'cancelled')),
  reason text,
  committed_kw numeric,
  cap_kw numeric,
  baseline_kw numeric,
  delivered_kwh numeric,
  payment_gbp numeric,
  fleet_share_pct numeric,
  fleet_credit_gbp numeric,
  estimated boolean not null default true,
  decided_by text,
  source text not null default 'aggregator' check (source in ('simulated', 'aggregator')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index if not exists flex_events_fleet_end_idx on public.flex_events (fleet_id, end_at);
create unique index if not exists flex_events_provider_idx on public.flex_events (fleet_id, provider_event_id) where provider_event_id is not null;
alter table public.flex_events enable row level security;
revoke all on public.flex_events from anon, authenticated;
grant all on public.flex_events to service_role;
