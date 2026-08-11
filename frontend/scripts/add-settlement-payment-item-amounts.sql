-- Adds per-row allocation tracking to the settlement/payment junction
-- tables. Deliveries.tsx previously linked a lump-sum settlement/payment to
-- every outstanding receivable/payable it covered with no record of how
-- much of that lump sum applied to which row — fine for deciding
-- pending/partial/paid status, but useless for computing a real remaining
-- balance per row (or per courier), which just kept showing the original
-- amount forever. amount_applied is how much of that specific settlement/
-- payment went toward that specific row; summing it per receivable/payable
-- id (across possibly several partial rounds over time) plus original
-- amount minus that sum is the actual remaining balance. Run once in the
-- Supabase SQL editor.

alter table courier_settlement_items add column if not exists amount_applied numeric(12,2) not null default 0;
alter table courier_payment_items add column if not exists amount_applied numeric(12,2) not null default 0;
