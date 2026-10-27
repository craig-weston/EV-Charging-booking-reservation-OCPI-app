-- Minimal stand-in for the Supabase platform pieces the migration relies on, so the schema and
-- RLS policies can be tested on a plain Postgres:  psql -f supabase_stub.sql -f ../../supabase/migrations/*.sql -f rls_check.sql
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), current_setting('request.jwt.claims', true)::jsonb ->> 'sub'), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Like newer Supabase projects: tables in public get no automatic grants for the API roles, so the
-- migrations must grant what the app needs (20261031000000_grants.sql).
