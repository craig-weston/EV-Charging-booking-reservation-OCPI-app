-- Depotcharge — security hardening. Run after 20261020000000_init.sql (SQL editor or `supabase db push`).
--
--  * Credentials tokens we issue to operators are stored as SHA-256 hashes only; the token an
--    operator gives us is encrypted by the app (AES-256-GCM, DATA_ENCRYPTION_KEY) before storage.
--  * Fleet policy "require two-step verification"; acceptance of the terms recorded per fleet.
--  * Audit log of security-relevant actions (service role only).
--  * Least privilege: browser sessions get read-only access to their own fleet's rows. Every write
--    goes through the API (service role), which validates and audits it.
--  * Retention: OCPI messages after 30 days, audit entries after 12 months, used or expired
--    invites after 30 days, bookings and charge records after 6 years (scheduled with pg_cron).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- fleets
alter table public.fleets add column if not exists require_mfa boolean not null default false;
alter table public.fleets add column if not exists terms_version text;
alter table public.fleets add column if not exists terms_accepted_at timestamptz;
alter table public.fleets add column if not exists terms_accepted_by uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------- OCPI credentials
alter table public.ocpi_partners add column if not exists our_token_hash text;
alter table public.ocpi_partners add column if not exists registration_token_hash text;
alter table public.ocpi_partners add column if not exists token_hint text;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ocpi_partners' and column_name = 'our_token') then
    update public.ocpi_partners set
      our_token_hash = coalesce(our_token_hash, case when our_token is not null then encode(extensions.digest(our_token, 'sha256'), 'hex') end),
      registration_token_hash = coalesce(registration_token_hash, case when registration_token is not null then encode(extensions.digest(registration_token, 'sha256'), 'hex') end),
      token_hint = coalesce(token_hint, case when coalesce(our_token, registration_token) is not null then '…' || right(coalesce(our_token, registration_token), 4) end);
    alter table public.ocpi_partners drop column our_token;
    alter table public.ocpi_partners drop column registration_token;
  end if;
end $$;

create unique index if not exists ocpi_partners_our_token_hash_key on public.ocpi_partners (our_token_hash) where our_token_hash is not null;
create unique index if not exists ocpi_partners_registration_token_hash_key on public.ocpi_partners (registration_token_hash) where registration_token_hash is not null;
comment on column public.ocpi_partners.our_token_hash is 'SHA-256 (hex) of the credentials token we issued to the operator. The token itself is never stored.';
comment on column public.ocpi_partners.their_token is 'Token we present to the operator; the app stores it AES-256-GCM encrypted (enc:v1:…) when DATA_ENCRYPTION_KEY is set.';

-- ---------------------------------------------------------------- audit log
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_id uuid,          -- no foreign key: entries outlive a deleted account (its email is cleared)
  actor_email text,
  fleet_id uuid,          -- null = platform level; no foreign key, so a deleted fleet's trail is kept for the retention period
  action text not null check (char_length(action) between 1 and 60),
  target text,
  data jsonb,
  ip text
);
create index if not exists audit_log_fleet_at_idx on public.audit_log (fleet_id, at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id);
alter table public.audit_log enable row level security;

-- ---------------------------------------------------------------- least privilege
-- Public settings: branding, company details and valid certificates (shown before sign-in).
drop policy if exists platform_settings_read on public.platform_settings;
create policy platform_settings_read on public.platform_settings for select to anon, authenticated using (key in ('brand', 'legal', 'certifications'));

-- Browser sessions never write directly; the API does, with validation and an audit trail.
drop policy if exists vehicles_write on public.vehicles;
drop policy if exists drivers_write on public.drivers;
-- Partner credentials and OCPI message bodies (which hold plates and token IDs) are API-only.
drop policy if exists ocpi_partners_admin on public.ocpi_partners;
drop policy if exists ocpi_log_admin on public.ocpi_log;

revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;
revoke all on public.fleet_invites, public.sim_state, public.audit_log, public.ocpi_partners, public.ocpi_log from anon, authenticated;
do $$
begin
  -- New tables stay read-only for browser roles too (Supabase creates tables as "postgres").
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    execute 'alter default privileges for role postgres in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------- retention
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

  -- Charge records are kept six years (accounting and VAT records), then deleted with their events.
  delete from public.bookings where end_at < now() - interval '6 years';
  get diagnostics n = row_count; result := result || jsonb_build_object('bookings', n);

  delete from public.ocpi_objects where module in ('sessions', 'cdrs') and last_updated < now() - interval '6 years';
  get diagnostics n = row_count; result := result || jsonb_build_object('sessions_cdrs', n);

  return result;
end $$;
revoke all on function public.depotcharge_retention() from public, anon, authenticated;

-- Daily at 03:17 UTC when pg_cron is available (Supabase: Database → Extensions → pg_cron).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.schedule('depotcharge-retention', '17 3 * * *', 'select public.depotcharge_retention()');
    exception when others then
      raise notice 'pg_cron not scheduled (%). Run select public.depotcharge_retention() daily another way.', sqlerrm;
    end;
  else
    raise notice 'pg_cron is not available: run select public.depotcharge_retention() daily another way.';
  end if;
end $$;
