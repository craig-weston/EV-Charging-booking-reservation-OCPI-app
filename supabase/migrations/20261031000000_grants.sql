-- Explicit table privileges. Newer Supabase projects no longer grant the API roles (anon,
-- authenticated, service_role) access to new tables in `public` automatically, so without this
-- the app's own server gets "permission denied for table …". Safe to run on any project: it only
-- grants what the app needs, and re-running it changes nothing.
--
--  * service_role (the app's server, via SUPABASE_SERVICE_ROLE_KEY): full access to every table.
--    It bypasses row level security by design; it never reaches browsers.
--  * authenticated (signed-in browsers): read-only, and only tables with a read policy. Row level
--    security still decides which rows; writes always go through the app's API.
--  * anon (signed-out browsers): only the public brand settings.

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Browsers: read-only, row level security applies.
grant select on public.fleets, public.fleet_members, public.platform_admins, public.platform_settings,
  public.vehicles, public.drivers, public.bookings, public.booking_events, public.ocpi_objects
  to authenticated;
grant select on public.platform_settings to anon;

-- The helper functions the read policies call.
grant execute on function public.is_fleet_member(uuid), public.is_fleet_writer(uuid), public.is_platform_admin()
  to authenticated, service_role;

-- Tables added by later migrations: the server gets access automatically, browsers don't.
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
