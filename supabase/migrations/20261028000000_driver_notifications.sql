-- Automatic driver messages (text or WhatsApp) when a booking is confirmed, changed or cancelled.
-- Off by default; a fleet owner turns it on in Settings → Fleet once Twilio is configured.
alter table public.fleets
  add column if not exists notify_drivers text not null default 'off'
  check (notify_drivers in ('off', 'sms', 'whatsapp'));

-- What the driver was last told about this booking, so a repeated operator push never sends twice.
alter table public.bookings
  add column if not exists driver_notified text;
