-- Fleet API keys, for a fleet's own systems (TMS, telematics, dispatch or autonomy platforms) to
-- use the API without a person signing in. Run after 20261021000000_security.sql.
--
--  * Only a SHA-256 hash of each key is stored; the key is shown once when it's created.
--  * A key acts as a planner (reads and books) or viewer (reads) of one fleet; never as an owner.
--  * Service role only: browser sessions can't read keys or their hashes.
--  * Revoked or expired keys are deleted 12 months after they stop working (retention).

create table if not exists public.fleet_api_keys (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.fleets(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  role text not null check (role in ('planner', 'viewer')),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_hint text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create index if not exists fleet_api_keys_fleet_idx on public.fleet_api_keys (fleet_id, created_at desc);
comment on column public.fleet_api_keys.key_hash is 'SHA-256 (hex) of the API key. The key itself is never stored.';
alter table public.fleet_api_keys enable row level security;
revoke all on public.fleet_api_keys from anon, authenticated;

-- Bookings made by an API key record which key (created_by stays null: no person made them).
alter table public.bookings add column if not exists created_by_key uuid references public.fleet_api_keys(id) on delete set null;

-- Retention: the existing job, plus keys that stopped working more than 12 months ago.
create or replace function public.depotcharge_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  result jsonb := '{}'::jsonb;
  n integer;
begin
  delete from public.ocpi_log where at < now() - interval '30 days';
  get diagnostics n = row_count; result := result || jsonb_build_object('ocpi_log', n);

  delete from public.audit_log where at < now() - interval '12 months';
  get diagnostics n = row_count; result := result || jsonb_build_object('audit_log', n);

  delete from public.fleet_invites where coalesce(accepted_at, expires_at) < now() - interval '30 days';
  get diagnostics n = row_count; result := result || jsonb_build_object('fleet_invites', n);

  delete from public.fleet_api_keys where least(coalesce(revoked_at, 'infinity'), coalesce(expires_at, 'infinity')) < now() - interval '12 months';
  get diagnostics n = row_count; result := result || jsonb_build_object('fleet_api_keys', n);

  -- Charge records are kept six years (accounting and VAT records), then deleted with their events.
  delete from public.bookings where end_at < now() - interval '6 years';
  get diagnostics n = row_count; result := result || jsonb_build_object('bookings', n);

  delete from public.ocpi_objects where module in ('sessions', 'cdrs') and last_updated < now() - interval '6 years';
  get diagnostics n = row_count; result := result || jsonb_build_object('sessions_cdrs', n);

  return result;
end $$;
revoke all on function public.depotcharge_retention() from public, anon, authenticated;
