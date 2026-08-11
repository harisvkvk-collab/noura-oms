-- Snapshots unit cost onto order_items at the time each line item is added,
-- same reasoning as item_name already being a snapshot rather than a live
-- lookup: historical profit reports should stay accurate even if a
-- product's cost_price changes later. products.cost_price has no currency
-- column (assumed AED/business-local), so no exchange_rate_snapshot
-- conversion is needed here, unlike unit_price. Run once in the Supabase
-- SQL editor (or via the CLI) — safe to re-run.

alter table order_items add column if not exists unit_cost_aed numeric;

update order_items
set unit_cost_aed = products.cost_price
from products
where order_items.product_id = products.id
  and order_items.unit_cost_aed is null;
