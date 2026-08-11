-- Lets admin staff manage courier API keys through a Settings screen
-- instead of the CLI/dashboard, without ever exposing api_token to the
-- frontend.
--
-- courier_api_credentials itself stays SELECT-locked exactly as before
-- (see policies.sql — zero SELECT policy means only service_role can read
-- it, which is what Edge Functions use). This migration only adds:
--   1. INSERT/UPDATE policies scoped to staff_users.role = 'admin'.
--   2. A column-level revoke on api_token as defense in depth, so even a
--      `return=representation` on an insert/update can't echo it back.
--   3. A masking view (courier_api_key_status) exposing only a has_key
--      boolean per courier — never the raw value — visible only to admins.
--
-- Run once in the Supabase SQL editor (with "Enable Row Level Security"
-- checked, though these tables already have RLS enabled from earlier
-- migrations).

create policy "admin insert api credentials" on courier_api_credentials
  for insert
  with check (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

create policy "admin update api credentials" on courier_api_credentials
  for update
  using (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

revoke select (api_token) on courier_api_credentials from authenticated;

-- One row per (courier_id, environment) that's actually been configured —
-- couriers like Delhivery can have both a 'staging' and 'production' row.
-- courier_name/api_provider aren't included; the Settings screen already
-- has those from `couriers` to drive its per-courier field picker.
create view courier_api_key_status as
select
  cred.courier_id,
  cred.environment,
  (cred.api_token is not null and cred.api_token <> '') as has_api_token,
  (cred.pickup_location is not null and cred.pickup_location <> '') as has_pickup_location,
  cred.active
from courier_api_credentials cred
where exists (
  select 1 from staff_users su where su.id = auth.uid() and su.role = 'admin'
);

grant select on courier_api_key_status to authenticated;
