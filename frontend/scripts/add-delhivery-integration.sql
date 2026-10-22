-- Delhivery B2C integration: schema + storage. Idempotent; run once in the
-- Supabase SQL editor BEFORE deploying the matching frontend and functions.
--
-- 1. customer_addresses.state — Delhivery routes Indian deliveries by state,
--    alongside the 6-digit pincode already stored in zip_code.
alter table customer_addresses add column if not exists state text;

-- 2. couriers.api_environment — which credentials new bookings use. 'staging'
--    lets us test against Delhivery's sandbox while the courier's
--    integration_status stays 'manual' (see functions/_shared/courierBooking.ts).
alter table couriers
  add column if not exists api_environment text not null default 'production'
  check (api_environment in ('staging', 'production'));

-- Delhivery's row already exists from schema.sql; make sure it points at the adapter.
update couriers set api_provider = 'delhivery' where name = 'Delhivery' and api_provider is distinct from 'delhivery';

-- 3. Private bucket for courier-issued shipping label PDFs. Same locked-down
--    pattern as order-photos (setup-order-photos-storage.sql): staff only,
--    read via signed URLs, never public.
insert into storage.buckets (id, name, public)
values ('courier-labels', 'courier-labels', false)
on conflict (id) do nothing;

drop policy if exists "staff full access to courier-labels" on storage.objects;
create policy "staff full access to courier-labels"
on storage.objects
for all
using (bucket_id = 'courier-labels' and auth.role() = 'authenticated')
with check (bucket_id = 'courier-labels' and auth.role() = 'authenticated');
