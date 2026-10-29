-- Smart charging at public sites (OCPI ChargingProfiles): what we asked the operator's charger to
-- do for a booking, its answer, and the expected saving. Run after 20261102000000_depot_energy.sql.
alter table public.bookings add column if not exists smart_charging jsonb;
comment on column public.bookings.smart_charging is 'OCPI ChargingProfiles state for this booking (shared/model.ts → SmartCharging).';
