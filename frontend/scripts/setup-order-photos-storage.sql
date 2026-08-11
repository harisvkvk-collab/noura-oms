-- One-time: creates the order-photos Storage bucket and locks it down with
-- the same "staff full access" pattern as every other table in policies.sql.
-- Run once in the Supabase SQL editor.
--
-- storage.buckets is a plain Postgres table, so bucket creation is just an
-- insert — no service_role/Admin API call needed here.
--
-- The bucket is PRIVATE (public = false): reading an object requires either
-- an authenticated request that satisfies the policy below, or a signed URL
-- generated server/client-side via supabase.storage.from(...).createSignedUrl().
-- A public bucket would serve files to anyone with the URL, no auth check —
-- that's the opposite of "authenticated-staff-only", so don't flip this.

insert into storage.buckets (id, name, public)
values ('order-photos', 'order-photos', false)
on conflict (id) do nothing;

create policy "staff full access to order-photos"
on storage.objects
for all
using (bucket_id = 'order-photos' and auth.role() = 'authenticated')
with check (bucket_id = 'order-photos' and auth.role() = 'authenticated');
