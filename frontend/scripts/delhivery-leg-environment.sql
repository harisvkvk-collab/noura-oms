-- Records which Delhivery environment each shipment leg was booked in, so the
-- refresh and cancel calls use the same environment as the booking.
alter table shipment_legs
  add column if not exists courier_environment text
  check (courier_environment in ('staging', 'production'));

-- The three test bookings made on staging before go-live.
update shipment_legs
set courier_environment = 'staging'
where tracking_number in ('86589610000011', '86589610000022', '86589610000033');
