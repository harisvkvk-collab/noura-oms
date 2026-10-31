-- Links an app pickup location to a Delhivery warehouse. Both columns are
-- optional: a location without a Delhivery name is not offered for Delhivery
-- bookings or pickups. The name must match the warehouse registered at Delhivery.
alter table pickup_locations
  add column if not exists delhivery_warehouse_name text,
  add column if not exists delhivery_pincode text
    check (delhivery_pincode is null or delhivery_pincode ~ '^[0-9]{6}$');
