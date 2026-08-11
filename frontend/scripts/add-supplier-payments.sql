-- Adds supplier payment tracking: a supplier_payments table (mirrors the
-- existing `payments` table used for sales orders) plus a payment_status
-- column on purchase_orders, which the app keeps in sync whenever a payment
-- is recorded. Run once in the Supabase SQL editor.

alter table purchase_orders
  add column payment_status text not null default 'unpaid';
  -- 'unpaid' | 'partial' | 'paid'

create table supplier_payments (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references purchase_orders(id) on delete cascade,
  amount              numeric(12,2) not null,
  method              text not null,          -- 'cash' | 'card' | 'bank_transfer'
  payment_type        text not null,          -- 'advance' | 'balance' | 'full' | 'partial'
  note                text,
  paid_at             timestamptz not null default now(),
  recorded_by         uuid references staff_users(id)
);

create index idx_supplier_payments_po on supplier_payments(purchase_order_id);

-- New table created outside the dashboard's "Run and enable RLS" flow, so
-- RLS needs enabling explicitly — same staff-full-access pattern as every
-- other business table in policies.sql.
alter table supplier_payments enable row level security;

create policy "staff full access" on supplier_payments
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
