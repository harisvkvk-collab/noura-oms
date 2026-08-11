-- Fix for return_items: an earlier run of the returns migration created the
-- table before item_name was added to the design. Snapshot pattern, same
-- reasoning as order_items.item_name — protects historical return records
-- if a product is later renamed or deleted. The app (OrderReturns.tsx)
-- already populates this from the linked order_items.item_name at the
-- moment a return is created; it's never derived via a live join.
--
-- Run this only if return_items already exists in your DB without this
-- column. For a fresh setup, migration-payables-and-returns.sql creates the
-- table with item_name built in from the start — don't run both.

alter table return_items add column if not exists item_name text;

update return_items ri
set item_name = oi.item_name
from order_items oi
where ri.order_item_id = oi.id
  and ri.item_name is null;

alter table return_items alter column item_name set not null;
