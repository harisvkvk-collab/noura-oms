-- Surface or Express for each shipment leg. Existing legs were all booked as
-- Surface, so the default keeps them as they are.
alter table shipment_legs
  add column if not exists shipping_mode text not null default 'Surface'
  check (shipping_mode in ('Surface', 'Express'));
