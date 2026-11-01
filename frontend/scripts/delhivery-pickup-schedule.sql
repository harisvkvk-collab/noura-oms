-- Pickup date and time chosen on the order form for a Delhivery leg. Set only
-- for Delhivery legs; the booking function requests the pickup for them.
alter table shipment_legs
  add column if not exists pickup_date date,
  add column if not exists pickup_time time;
