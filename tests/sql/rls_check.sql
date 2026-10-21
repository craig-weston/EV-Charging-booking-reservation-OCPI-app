-- RLS smoke test: two fleets, two users; each user only sees their own fleet's rows.
\set ON_ERROR_STOP on
insert into auth.users values ('00000000-0000-0000-0000-00000000000a', 'a@example.com'), ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.fleets (id, name) values ('10000000-0000-0000-0000-00000000000a', 'Fleet A'), ('10000000-0000-0000-0000-00000000000b', 'Fleet B');
insert into public.fleet_members (fleet_id, user_id, role) values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'owner'),
                                        ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'viewer');
insert into public.vehicles (fleet_id, name, plate, token_uid, contract_id) values
  ('10000000-0000-0000-0000-00000000000a', 'A1', 'PN74 EVH', 'GBDPCC00000101K', 'GB-DPC-C1'),
  ('10000000-0000-0000-0000-00000000000b', 'B1', 'KX25 HGV', 'VID:A4B2C3D4E5F6', 'GB-DPC-C2');
insert into public.ocpi_objects (module, country_code, party_id, id, data, last_updated) values
  ('locations', 'GB', 'VHL', 'L1', '{}', now()), ('sessions', 'GB', 'VHL', 'S1', '{}', now());
insert into public.fleet_invites (fleet_id, email, role, token, expires_at) values
  ('10000000-0000-0000-0000-00000000000a', 'c@example.com', 'planner', 'secret-invite-token', now() + interval '7 days');
insert into public.audit_log (fleet_id, action, actor_email) values ('10000000-0000-0000-0000-00000000000a', 'member.role', 'a@example.com');
insert into public.platform_settings (key, value) values ('brand', '{"name":"Depotcharge"}'), ('legal', '{"company_name":"Depotcharge Ltd"}'), ('compliance', '{"mfa-cloud":{}}');
insert into public.ocpi_partners (name, our_token_hash) values ('Op', encode(extensions.digest('t', 'sha256'), 'hex'));
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'ocpi_partners' and column_name in ('our_token', 'registration_token')) then
    raise exception 'plaintext token columns must be gone';
  end if;
end $$;

-- duplicate plate in the same fleet (spacing/case-insensitive) must fail
do $$ begin
  insert into public.vehicles (fleet_id, name, plate, token_uid, contract_id) values ('10000000-0000-0000-0000-00000000000a', 'dup', 'pn74evh', 'X1', 'C');
  raise exception 'duplicate plate accepted';
exception when unique_violation then null; end $$;

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a"}', false);
do $$ begin
  if (select count(*) from public.fleets) <> 1 then raise exception 'user A should see 1 fleet'; end if;
  if (select count(*) from public.vehicles) <> 1 then raise exception 'user A should see 1 vehicle'; end if;
  if (select count(*) from public.ocpi_objects) <> 1 then raise exception 'sessions must be hidden'; end if;
  if (select count(*) from public.fleet_members) <> 1 then raise exception 'user A should see only their own team'; end if;
end $$;
-- server-only tables: no access at all from a browser session
do $$ begin perform 1 from public.ocpi_partners; raise exception 'partners readable'; exception when insufficient_privilege then null; end $$;
do $$ begin perform 1 from public.fleet_invites; raise exception 'invite tokens readable'; exception when insufficient_privilege then null; end $$;
do $$ begin perform 1 from public.ocpi_log; raise exception 'OCPI message log readable'; exception when insufficient_privilege then null; end $$;
-- browser sessions are read-only: even an owner writes through the API (service role), never directly
do $$ begin
  insert into public.vehicles (fleet_id, name, plate, token_uid, contract_id) values ('10000000-0000-0000-0000-00000000000a', 'A2', 'YD74 ZRO', 'VID:3C2A9B4E1F07', 'GB-DPC-C3');
  raise exception 'direct insert accepted';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into public.vehicles (fleet_id, name, plate, token_uid, contract_id) values ('10000000-0000-0000-0000-00000000000b', 'evil', 'AA11 AAA', 'X2', 'C');
  raise exception 'cross-fleet insert accepted';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update public.fleets set require_mfa = false;
  raise exception 'direct update accepted';
exception when insufficient_privilege then null; end $$;
do $$ begin
  if exists (select 1 from public.audit_log) then raise exception 'audit log must be hidden'; end if;
  raise exception 'audit log readable';
exception when insufficient_privilege then null; end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b"}', false);
do $$ begin
  if (select count(*) from public.vehicles) <> 1 then raise exception 'user B should see only fleet B'; end if;
end $$;
-- viewer cannot write
do $$ begin
  insert into public.vehicles (fleet_id, name, plate, token_uid, contract_id) values ('10000000-0000-0000-0000-00000000000b', 'v', 'BB22 BBB', 'X3', 'C');
  raise exception 'viewer insert accepted';
exception when insufficient_privilege then null; end $$;
reset role;

set role anon;
do $$ begin
  if (select count(*) from public.vehicles) <> 0 then raise exception 'anon must see nothing'; end if;
  if (select count(*) from public.platform_settings) <> 2 then raise exception 'anon sees brand and legal settings only'; end if;
end $$;
reset role;
-- retention runs as the owner and returns what it removed
select public.depotcharge_retention() is not null as retention_ok;
select 'RLS checks passed' as result;
