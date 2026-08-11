-- Reshapes courier_api_key_status for the multi-field, multi-environment
-- Settings screen: couriers like Delhivery need separate staging/production
-- tokens plus a non-environment-scoped pickup_location, so status has to be
-- reported per (courier_id, environment) row rather than one has_key
-- boolean per courier. courier_name/api_provider move out of the view —
-- the frontend now fetches those directly from couriers (already
-- staff-readable) to drive the field picker. Run once in the Supabase SQL
-- editor.

drop view if exists courier_api_key_status;

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
