-- Lets a shipment leg record the real courier company name when the picked
-- courier is one of the generic 'Other UAE courier' / 'Other local courier'
-- placeholders. Run once in the Supabase SQL editor.
alter table shipment_legs add column manual_courier_name text;
