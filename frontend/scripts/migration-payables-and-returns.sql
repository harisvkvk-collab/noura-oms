-- Consolidated, idempotent migration for courier payables/payments and
-- returns/exchanges. Supersedes add-courier-payables.sql,
-- fix-courier-payment-columns.sql, and add-order-returns.sql — safe to run
-- on a fresh DB (creates everything from scratch, correctly) or on top of
-- a DB that already has some of these tables/columns (every statement is
-- guarded, so anything that already exists is left alone).
--
-- Exception: return_items.item_name is added here as nullable, matching
-- fresh-create behavior. If return_items already exists on your DB without
-- item_name, run migration-return-items-name-fix.sql instead — it backfills
-- from order_items and sets the column NOT NULL, which this script doesn't
-- attempt (can't safely force NOT NULL here without knowing whether existing
-- rows already have a value).

-- ---------- Courier payables (delivery fees owed TO a courier on non-COD
-- orders) ----------

create table if not exists courier_payables (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid references orders(id),
  shipment_leg_id   uuid references shipment_legs(id),
  courier_id        uuid not null references couriers(id),
  amount            numeric(12,2) not null,
  reason            text not null default 'delivery',  -- 'delivery' | 'return_pickup' | 'exchange_replacement'
  status            text not null default 'unpaid',    -- 'unpaid' | 'paid'
  created_at        timestamptz not null default now()
);
alter table courier_payables add column if not exists order_id uuid references orders(id);

create table if not exists courier_payments (
  id                uuid primary key default gen_random_uuid(),
  courier_id        uuid not null references couriers(id),
  payment_reference text,
  paid_at           timestamptz not null default now(),  -- the actual payment date, staff-set
  amount            numeric(12,2) not null,
  created_at        timestamptz not null default now()   -- record-entry audit timestamp, distinct from paid_at
);
alter table courier_payments add column if not exists created_at timestamptz not null default now();

create table if not exists courier_payment_items (
  payment_id        uuid not null references courier_payments(id) on delete cascade,
  payable_id        uuid not null references courier_payables(id),
  primary key (payment_id, payable_id)
);

alter table supplier_payments add column if not exists created_at timestamptz not null default now();

-- ---------- Returns / Exchanges ----------

create table if not exists order_returns (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id),
  type            text not null,                    -- 'return' | 'exchange'
  status          text not null default 'pending',  -- 'pending' | 'received'
  created_by      uuid references staff_users(id),
  created_at      timestamptz not null default now()
);

create table if not exists return_items (
  id              uuid primary key default gen_random_uuid(),
  return_id       uuid not null references order_returns(id) on delete cascade,
  order_item_id   uuid references order_items(id),
  product_id      uuid references products(id),
  item_name       text,                         -- snapshot; see note above re: NOT NULL
  qty             int not null,
  reason          text
);
alter table return_items add column if not exists item_name text;

-- Exchange only: what's actually going out as the replacement, chosen
-- independently from what came back in return_items (a different size,
-- variant, or entirely different product, not necessarily a same-item swap).
create table if not exists exchange_replacement_items (
  id              uuid primary key default gen_random_uuid(),
  return_id       uuid not null references order_returns(id) on delete cascade,
  product_id      uuid not null references products(id),
  item_name       text not null,
  qty             int not null
);

alter table shipments add column if not exists return_id uuid references order_returns(id);

create index if not exists idx_return_items_return on return_items(return_id);
create index if not exists idx_exchange_replacement_items_return on exchange_replacement_items(return_id);

-- ---------- Policies (drop + recreate so this stays idempotent) ----------

drop policy if exists "staff full access" on courier_payables;
create policy "staff full access" on courier_payables
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "staff full access" on courier_payments;
create policy "staff full access" on courier_payments
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "staff full access" on courier_payment_items;
create policy "staff full access" on courier_payment_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "staff full access" on order_returns;
create policy "staff full access" on order_returns
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "staff full access" on return_items;
create policy "staff full access" on return_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "staff full access" on exchange_replacement_items;
create policy "staff full access" on exchange_replacement_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
