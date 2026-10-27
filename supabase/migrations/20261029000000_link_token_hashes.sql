-- Driver pass links and team invite links are bearer secrets. The app now stores them sealed with
-- DATA_ENCRYPTION_KEY (so planners can copy a link again) and looks them up by SHA-256, so a copy
-- of the database or a backup doesn't hand out working links.
--
-- After running this, go to Compliance → Encryption key → "Re-encrypt stored credentials" once to
-- seal the links saved before this change.

alter table public.bookings add column if not exists pass_token_hash text;
update public.bookings
  set pass_token_hash = encode(sha256(convert_to(pass_token, 'UTF8')), 'hex')
  where pass_token_hash is null and pass_token not like 'enc:v1:%';
create unique index if not exists bookings_pass_token_hash_key on public.bookings (pass_token_hash);

alter table public.fleet_invites add column if not exists token_hash text;
update public.fleet_invites
  set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
  where token_hash is null and token not like 'enc:v1:%';
create unique index if not exists fleet_invites_token_hash_key on public.fleet_invites (token_hash);
