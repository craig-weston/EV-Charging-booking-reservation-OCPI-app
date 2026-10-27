-- Live updates: Supabase Realtime tells signed-in planners when a booking in their fleet changes.
-- Row level security (bookings_read, booking_events_read) decides who is told about which rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings') then
      alter publication supabase_realtime add table public.bookings;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'booking_events') then
      alter publication supabase_realtime add table public.booking_events;
    end if;
  end if;
end $$;
