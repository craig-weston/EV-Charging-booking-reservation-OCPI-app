-- Webhooks: a fleet's own systems (TMS, dispatch, telematics) are told when a booking changes.
-- Run after 20261031000000_grants.sql.
--
--  * The signing secret is sealed with DATA_ENCRYPTION_KEY (AES-256-GCM); it's shown once.
--  * Service role only: browser sessions can't read webhooks or their secrets.
--  * Owners manage them in Settings; deliveries record their last result for troubleshooting.

create table if not exists public.fleet_webhooks (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  url text not null check (url ~ '^https://' and char_length(url) <= 500),
  description text not null default '' check (char_length(description) <= 80),
  secret text not null,
  secret_hint text not null default '',
  events text[] not null default '{}',
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_status integer,
  last_error text,
  failures integer not null default 0
);
create index if not exists fleet_webhooks_fleet_idx on public.fleet_webhooks (fleet_id);
comment on column public.fleet_webhooks.secret is 'Signing secret, sealed with DATA_ENCRYPTION_KEY. Shown to the owner once.';
alter table public.fleet_webhooks enable row level security;
revoke all on public.fleet_webhooks from anon, authenticated;
grant all on public.fleet_webhooks to service_role;
