-- Adds has_customer_branch to courier_api_key_status, mirroring
-- has_api_token/has_pickup_location — needed now that Settings.tsx exposes
-- a Customer Branch field for NextDrop (stored in extra_config.customer_branch,
-- the one mandatory field on every NextDrop booking call that had no UI to
-- set it before, which is why bookings failed with "Incomplete request
-- parameters" even with a valid API key on file). CREATE OR REPLACE VIEW
-- only adds a column here, so existing grants survive. Run once in the
-- Supabase SQL editor.

-- New column appended at the end, not inserted before `active` — Postgres
-- treats CREATE OR REPLACE VIEW column-position changes as a rename
-- attempt and refuses them (42P16), it only tolerates pure appends.
create or replace view courier_api_key_status as
select
  cred.courier_id,
  cred.environment,
  (cred.api_token is not null and cred.api_token <> '') as has_api_token,
  (cred.pickup_location is not null and cred.pickup_location <> '') as has_pickup_location,
  cred.active,
  (cred.extra_config ->> 'customer_branch' is not null and cred.extra_config ->> 'customer_branch' <> '') as has_customer_branch
from courier_api_credentials cred
where exists (
  select 1 from staff_users su where su.id = auth.uid() and su.role = 'admin'
);
