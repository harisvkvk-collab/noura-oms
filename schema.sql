-- =========================================================
-- Noura OMS — Postgres schema (Supabase-ready)
-- Retail-only scope: manual order entry, multi-currency,
-- multi-country shipping (UAE domestic + international),
-- COD + courier receivables, in-store vs online fulfillment.
-- Wholesale / export deferred — schema leaves room to add
-- later without breaking these tables.
-- =========================================================

-- ---------- Reference / lookup tables ----------

create table currencies (
  code            text primary key,          -- 'AED', 'SAR', 'GBP', 'USD', 'EUR', 'INR'
  name            text not null,
  symbol          text
);

create table exchange_rates (
  currency_code   text primary key references currencies(code),
  rate_to_aed     numeric(12,6) not null,     -- 1 unit of currency = X AED
  updated_at      timestamptz not null default now()
);

create table countries (
  code            text primary key,           -- ISO 2-letter, e.g. 'AE', 'SA', 'GB', 'US', 'IN'
  name            text not null,
  region          text,                       -- 'GCC', 'UK', 'EU', 'US', 'India', 'Middle East'
  default_currency text references currencies(code)
);

create table staff_users (
  id              uuid primary key references auth.users(id) on delete cascade,
  name            text not null,
  email           text unique,
  phone           text,
  role            text not null default 'staff',   -- 'staff' | 'admin'
  created_at      timestamptz not null default now()
);

create table product_categories (
  id              serial primary key,
  name            text not null unique         -- 'Abaya', 'Mukhawar', 'Accessory'
);

-- Single-row settings table — already existed on the live DB before this
-- comment was written (created out-of-band, seeded with business_name =
-- 'Noura Abaya'; discovered when frontend/CompanySettings.tsx was built —
-- same recurring "live DB ahead of schema.sql" pattern as
-- customers.instagram_handle). No app code ever inserts or deletes a row —
-- CompanySettings.tsx and lib/shippingSlip.ts always operate on whichever
-- single row exists. logo_url is unused by the app today (no upload UI
-- built for it yet).
create table company_settings (
  id            uuid primary key default gen_random_uuid(),
  business_name text not null default 'Noura Abaya',
  address       text,
  city          text,
  country_code  text references countries(code),
  phone         text,
  email         text,
  logo_url      text,
  updated_at    timestamptz not null default now()
);

-- ---------- Couriers ----------

create table couriers (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,                    -- 'Aramex', 'NextDrop', 'Delhivery', 'SMSA Express'...
  integration_status  text not null default 'manual',     -- 'manual' | 'pending_integration' | 'integrated'
  api_provider        text,                              -- adapter key once built, e.g. 'aramex' | null while manual
  fee_type            text not null default 'flat',       -- 'flat' | 'zone'
  default_cod_fee     numeric(10,2),                      -- used when fee_type = 'flat'
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
-- Note: integration_status is the courier's overall state; shipment_legs.is_manual
-- is set per shipment and can still be true even for an 'integrated' courier
-- (API outage, or staff choosing to log it by hand that day).

create table courier_zone_rates (
  id            uuid primary key default gen_random_uuid(),
  courier_id    uuid not null references couriers(id) on delete cascade,
  area          text not null,                -- zone/area name used when fee_type = 'zone'
  fee           numeric(10,2) not null,
  unique (courier_id, area)
);

-- Per-courier API credentials, kept separate from couriers so staging/production
-- tokens don't overwrite each other and secrets aren't mixed into general config.
-- Plaintext api_token is deliberate: this table has no SELECT policy at all
-- (see policies.sql), so it's only ever readable via the service_role key,
-- which only Edge Functions hold. Admin staff can INSERT/UPDATE it (write
-- their own key through the Settings screen) but can never read api_token
-- back — see courier_api_key_status below, the only way the frontend
-- observes anything about this table.
create table courier_api_credentials (
  id                uuid primary key default gen_random_uuid(),
  courier_id        uuid not null references couriers(id) on delete cascade,
  environment       text not null default 'staging',   -- 'staging' | 'production'
  base_url          text,                                -- e.g. staging-express.delhivery.com
  api_token         text,                                -- static bearer token (Delhivery-style) or key
  pickup_location   text,                                -- registered warehouse name, required by some couriers (e.g. Delhivery)
  extra_config      jsonb,                               -- anything courier-specific (wallet threshold, webhook doc status, customer_branch for NextDrop, etc.)
  active            boolean not null default false,       -- flips true once credentials are confirmed working
  created_at        timestamptz not null default now(),
  unique (courier_id, environment)
);

-- Masking view for the admin Settings screen: exposes whether each column
-- worth gating (api_token, pickup_location) is set, per (courier_id,
-- environment) row — never the values themselves. One row per environment
-- that's actually been configured (Delhivery-style couriers can have both
-- a 'staging' and a 'production' row; courier_name/api_provider aren't
-- included here since the frontend already has those from `couriers`).
-- Row-restricted to admins directly in the view (not just at the app-route
-- level) — non-admin authenticated staff querying this get zero rows, not
-- an error.
-- has_customer_branch added later (frontend/scripts/add-customer-branch-status.sql)
-- once Settings.tsx grew a field for it — NextDrop's one mandatory field
-- that has no dedicated column, only extra_config.customer_branch. Column
-- appended at the end, not inserted before `active`: CREATE OR REPLACE VIEW
-- only tolerates pure appends, not reordering.
create view courier_api_key_status as
select
  cred.courier_id,
  cred.environment,
  (cred.api_token is not null and cred.api_token <> '') as has_api_token,
  (cred.pickup_location is not null and cred.pickup_location <> '') as has_pickup_location,
  cred.active,
  (cred.extra_config ->> 'customer_branch' is not null and cred.extra_config ->> 'customer_branch' <> '') as has_customer_branch
from courier_api_credentials cred
where exists (
  select 1 from staff_users su where su.id = auth.uid() and su.role = 'admin'
);

-- ---------- Customers ----------

create table customers (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  phone               text,                   -- E.164 format, e.g. +971501234567
  email               text,
  preferred_currency  text references currencies(code) default 'AED',
  usual_channel       text,                   -- 'Instagram' | 'WhatsApp' | 'Facebook' | 'TikTok' | 'In-store'
  customer_type       text not null default 'retail',   -- reserved for future 'wholesale'
  notes               text,
  instagram_handle    text,                   -- no leading '@' assumed either way; stripped at href-build time
  facebook_handle     text,                   -- m.me username
  tiktok_handle       text,
  snapchat_handle     text,
  created_at          timestamptz not null default now()
);

create table customer_addresses (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references customers(id) on delete cascade,
  country_code    text references countries(code),
  city            text,
  area            text,
  zip_code        text,
  full_address    text,
  is_default      boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ---------- Products / Inventory ----------

create table products (
  id              uuid primary key default gen_random_uuid(),
  sku             text unique,
  name            text not null,
  category_id     int references product_categories(id),
  variant         text,                        -- free text: "Black, Size M" etc.
  cost_price      numeric(10,2) not null default 0,   -- always stored in AED (base currency)
  selling_price   numeric(10,2) not null default 0,   -- base price in AED; per-order price snapshot lives on order_items
  stock_qty       int not null default 0,
  reorder_level   int not null default 0,
  image_url       text,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table inventory_ledger (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references products(id),
  change_qty      int not null,                -- positive = stock in, negative = stock out
  reason          text not null,                -- 'sale' | 'purchase' | 'adjustment' | 'return' | 'exchange'
  reference_type  text,                         -- 'order' | 'purchase_order' | 'order_return'
  reference_id    uuid,
  created_by      uuid references staff_users(id),
  created_at      timestamptz not null default now()
);

-- ---------- Orders ----------

create table orders (
  id                    uuid primary key default gen_random_uuid(),
  order_number          text unique not null,          -- auto-generated e.g. '#1045'
  customer_id           uuid references customers(id),

  order_source          text not null,                  -- 'Instagram' | 'WhatsApp' | 'Facebook' | 'TikTok' | 'In-store'
  fulfillment_type      text not null,                   -- 'instore' | 'shipped'  (derived from source, kept explicit)

  currency_code         text not null references currencies(code),
  exchange_rate_snapshot numeric(12,6) not null,          -- rate to AED locked at order time
  subtotal              numeric(12,2) not null default 0,
  discount              numeric(12,2) not null default 0,
  total                 numeric(12,2) not null default 0,       -- in order_currency
  total_in_aed          numeric(12,2) not null default 0,       -- locked AED equivalent, for reporting

  payment_method         text not null,                  -- 'cash' | 'card' | 'bank_transfer' | 'upi' | 'cod'
  payment_status          text not null default 'unpaid', -- 'paid' | 'awaiting_courier_settlement' | 'unpaid'

  status                text not null default 'draft',
  -- in-store: 'draft' -> 'completed'
  -- online:   'draft' -> 'confirmed' -> 'packed' -> 'postage_printed' -> 'dispatched' -> 'delivered'

  delivery_country_code text references countries(code),
  delivery_area          text,                            -- used to look up courier zone fee

  notes                 text,

  created_by            uuid references staff_users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index idx_orders_customer on orders(customer_id);
create index idx_orders_status on orders(status);
create index idx_orders_created_at on orders(created_at);

create table order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  product_id      uuid references products(id),
  item_name       text not null,               -- snapshot, in case product name changes later
  qty             int not null,
  unit_price      numeric(10,2) not null,       -- in order currency
  subtotal        numeric(12,2) not null
);

create table order_photos (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  image_url       text not null,
  uploaded_at     timestamptz not null default now()
);

create table order_timeline (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  step            text not null,                -- 'created' | 'confirmed' | 'packed' | 'postage_printed' | 'dispatched' | 'delivered' | 'completed'
  staff_user_id   uuid references staff_users(id),
  note            text,
  created_at      timestamptz not null default now()
);

create table order_messages (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  type            text not null,                -- 'confirmation' | 'dispatch_update'
  channel         text not null default 'whatsapp',
  content         text,
  status          text not null default 'drafted',   -- 'drafted' | 'sent' | 'skipped'
  sent_at         timestamptz
);

create table payments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  method          text not null,                -- 'cash' | 'card' | 'bank_transfer' | 'cod'
  amount          numeric(12,2) not null,
  currency_code   text references currencies(code),
  paid_at         timestamptz,
  recorded_by     uuid references staff_users(id)
);

-- ---------- Shipments (multi-leg, supports domestic / international / inbound) ----------

create table shipments (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid references orders(id) on delete cascade,
  purchase_order_id     uuid,                          -- set instead of order_id for inbound stock shipments (future use)
  direction             text not null default 'outbound',   -- 'outbound' | 'inbound'
  origin_country_code   text references countries(code),
  destination_country_code text references countries(code),
  duty_paid_by          text default 'sender',          -- 'sender' | 'receiver'
  customs_value         numeric(12,2),
  status                text not null default 'pending', -- rolls up from active leg
  created_at            timestamptz not null default now()
);

create table shipment_legs (
  id                uuid primary key default gen_random_uuid(),
  shipment_id       uuid not null references shipments(id) on delete cascade,
  leg_order         int not null,                       -- 1, 2, ... in sequence
  leg_type          text not null,                       -- 'domestic' | 'international' | 'local_last_mile'
  courier_id        uuid references couriers(id),
  manual_courier_name text,                               -- free-text actual courier name, used when courier_id points to a generic 'Other' entry — e.g. staff selects "Other UAE courier" then types "Fetchr Express" here
  pickup_location_id uuid,                                 -- references pickup_locations(id) below; which of YOUR addresses this leg ships FROM, saved permanently per leg
  tracking_number   text,
  cost              numeric(10,2),
  currency_code     text references currencies(code),
  status            text not null default 'pending',      -- simplified: 'pending' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'failed_rto'
  provider_status_raw text,                                -- courier's own raw status/code, kept for debugging/support calls, never shown to customers
  is_manual         boolean not null default false,        -- true if courier has no API integration
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Your own business locations orders can ship FROM (warehouse, store, home,
-- etc.) — not to be confused with courier_api_credentials.pickup_location,
-- which is a courier's own registered branch name in THEIR system. One of
-- these should be marked default; staff can override per order, and whichever
-- one was actually used is saved permanently on that shipment_legs row above
-- (so historical shipments show what was true at the time, even if the
-- default changes later).
create table pickup_locations (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,               -- e.g. 'Main Warehouse - Dubai', 'Sharjah Store'
  address         text not null,
  city            text,
  contact_person  text,
  contact_phone   text,
  is_default      boolean not null default false,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table shipment_legs
  add constraint shipment_legs_pickup_location_fkey
  foreign key (pickup_location_id) references pickup_locations(id);

create index idx_shipment_legs_shipment on shipment_legs(shipment_id);

-- ---------- Returns / Exchanges ----------
-- Reachable from OrderDetail.tsx for delivered orders only. Initiated as a
-- 'pending' record of what's coming back; the actual return-pickup (and,
-- for exchanges, replacement) shipment/courier isn't chosen until the
-- 'Mark received' step, same manual-first-then-confirm pattern as
-- 'Mark delivered' on the main fulfillment timeline.

create table order_returns (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id),
  type            text not null,                    -- 'return' | 'exchange'
  status          text not null default 'pending',  -- 'pending' | 'received'
  created_by      uuid references staff_users(id),
  created_at      timestamptz not null default now()
);

create table return_items (
  id              uuid primary key default gen_random_uuid(),
  return_id       uuid not null references order_returns(id) on delete cascade,
  order_item_id   uuid references order_items(id),
  product_id      uuid references products(id),
  item_name       text not null,               -- snapshot, same pattern as order_items
  qty             int not null,
  reason          text
);

-- Exchange only: what's actually going out as the replacement, chosen
-- independently from what came back in return_items — a different size,
-- variant, or entirely different product, not necessarily a same-item swap.
create table exchange_replacement_items (
  id              uuid primary key default gen_random_uuid(),
  return_id       uuid not null references order_returns(id) on delete cascade,
  product_id      uuid not null references products(id),
  item_name       text not null,
  qty             int not null
);

-- A return can carry up to two shipments: the return-pickup leg (direction
-- 'inbound') always; for exchanges, also a replacement leg (direction
-- 'outbound') shipping exchange_replacement_items back out. Both still set
-- order_id, so queries scoped to a single order's *primary* fulfillment
-- shipment must filter `return_id is null`.
alter table shipments add column return_id uuid references order_returns(id);

create index idx_return_items_return on return_items(return_id);
create index idx_exchange_replacement_items_return on exchange_replacement_items(return_id);

-- ---------- COD / courier receivables ----------

create table courier_cod_receivables (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id),
  shipment_leg_id     uuid references shipment_legs(id),
  courier_id          uuid not null references couriers(id),
  amount_collected    numeric(12,2) not null,          -- full order total, in AED
  delivery_fee_deducted numeric(10,2) not null default 0,
  net_due             numeric(12,2) not null,           -- amount_collected - delivery_fee_deducted
  status              text not null default 'pending',  -- 'pending' | 'collected' | 'remitted' | 'partially_remitted'
  created_at          timestamptz not null default now()
);

create table courier_settlements (
  id                  uuid primary key default gen_random_uuid(),
  courier_id          uuid not null references couriers(id),
  settlement_reference text,
  settlement_date     date not null,
  total_collected     numeric(12,2) not null,
  total_fees_deducted numeric(12,2) not null,
  net_remitted        numeric(12,2) not null,
  status              text not null default 'pending',  -- 'pending' | 'partial' | 'settled'
  created_at          timestamptz not null default now()
);

create table courier_settlement_items (
  settlement_id       uuid not null references courier_settlements(id) on delete cascade,
  receivable_id       uuid not null references courier_cod_receivables(id),
  amount_applied      numeric(12,2) not null default 0,   -- how much of this settlement's net_remitted went toward this specific receivable — a settlement is a lump sum that can cover several receivables at once, so this is what makes a real per-row remaining balance computable (see frontend/scripts/add-settlement-payment-item-amounts.sql)
  primary key (settlement_id, receivable_id)
);

-- ---------- Courier payables (the reverse direction: delivery fees the
-- business owes the courier on non-COD orders, where there's no cash
-- collection to net the fee out of) ----------

create table courier_payables (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid references orders(id),
  shipment_leg_id     uuid references shipment_legs(id),
  courier_id          uuid not null references couriers(id),
  amount              numeric(12,2) not null,
  reason              text not null default 'delivery',  -- 'delivery' | 'return_pickup' | 'exchange_replacement'
  status              text not null default 'unpaid',    -- 'unpaid' | 'partial' | 'paid'
  created_at          timestamptz not null default now()
);

create table courier_payments (
  id                  uuid primary key default gen_random_uuid(),
  courier_id          uuid not null references couriers(id),
  payment_reference   text,
  paid_at             timestamptz not null default now(),  -- the actual payment date, staff-set
  amount              numeric(12,2) not null,
  created_at          timestamptz not null default now()   -- record-entry audit timestamp, distinct from paid_at
);

create table courier_payment_items (
  payment_id          uuid not null references courier_payments(id) on delete cascade,
  payable_id          uuid not null references courier_payables(id),
  amount_applied      numeric(12,2) not null default 0,   -- same reasoning as courier_settlement_items.amount_applied
  primary key (payment_id, payable_id)
);

-- ---------- Suppliers / Purchases ----------

create table suppliers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  contact_phone   text,
  contact_email   text,
  country_code    text references countries(code),
  lead_time_days  int,
  notes           text,
  created_at      timestamptz not null default now()
);

create table purchase_orders (
  id                  uuid primary key default gen_random_uuid(),
  po_number           text unique not null,
  supplier_id         uuid references suppliers(id),
  expected_delivery_date date,
  payment_terms       text default 'Due on receipt',
  status              text not null default 'draft',    -- 'draft' | 'ordered' | 'receiving' | 'received'
  payment_status      text not null default 'unpaid',    -- 'unpaid' | 'partial' | 'paid' — kept in sync by app logic when supplier_payments rows are added
  currency_code       text references currencies(code) default 'AED',
  subtotal            numeric(12,2) not null default 0,
  total                numeric(12,2) not null default 0,
  created_by           uuid references staff_users(id),
  created_at            timestamptz not null default now()
);

-- Tracks actual money paid out to a supplier against a PO — advance payments,
-- balance payments, or a single full payment. Same purpose as the `payments`
-- table on the sales side, just flowing the other direction. A PO's total
-- paid = sum of these rows; payment_status above is a cached summary kept in
-- sync by the app whenever a row is added here, so the Purchases list can
-- show status without summing on every render.
create table supplier_payments (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references purchase_orders(id) on delete cascade,
  amount              numeric(12,2) not null,
  method              text,                              -- 'cash' | 'card' | 'bank_transfer'
  payment_type        text not null default 'partial',    -- 'advance' | 'balance' | 'full' | 'partial'
  paid_at             timestamptz not null default now(),  -- the actual payment date, staff-set
  recorded_by         uuid references staff_users(id),
  note                text,
  created_at          timestamptz not null default now()   -- record-entry audit timestamp, distinct from paid_at
);

create table purchase_order_items (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references purchase_orders(id) on delete cascade,
  product_id          uuid references products(id),
  item_name           text not null,
  qty                 int not null,
  unit_cost           numeric(10,2) not null,
  subtotal            numeric(12,2) not null,
  qty_received        int not null default 0
);

-- =========================================================
-- Seed data — currencies, a starter country list, categories
-- =========================================================

insert into currencies (code, name, symbol) values
  ('AED','UAE Dirham','د.إ'),
  ('SAR','Saudi Riyal','﷼'),
  ('GBP','British Pound','£'),
  ('USD','US Dollar','$'),
  ('EUR','Euro','€'),
  ('INR','Indian Rupee','₹');

insert into countries (code, name, region, default_currency) values
  ('AE','United Arab Emirates','GCC','AED'),
  ('SA','Saudi Arabia','GCC','SAR'),
  ('BH','Bahrain','GCC','AED'),
  ('OM','Oman','GCC','AED'),
  ('GB','United Kingdom','UK','GBP'),
  ('US','United States','US','USD'),
  ('IN','India','India','INR');
  -- add EU country rows as needed (DE, FR, etc.) once markets are confirmed

insert into product_categories (name) values
  ('Abaya'), ('Mukhawar'), ('Accessory');

-- Which payment methods are valid per destination country. The order form
-- should only show options present here for the order's delivery_country_code,
-- rather than hardcoding "COD is unavailable in India" as app logic.
create table country_payment_methods (
  id              uuid primary key default gen_random_uuid(),
  country_code    text not null references countries(code),
  payment_method  text not null,      -- 'cash' | 'card' | 'bank_transfer' | 'upi' | 'cod'
  is_default      boolean not null default false,
  unique (country_code, payment_method)
);

insert into country_payment_methods (country_code, payment_method, is_default) values
  ('AE','cash', true), ('AE','card', false), ('AE','bank_transfer', false), ('AE','cod', false),
  ('SA','cash', true), ('SA','card', false), ('SA','bank_transfer', false), ('SA','cod', false),
  ('IN','upi', true),  ('IN','card', false), ('IN','bank_transfer', false);  -- no COD in India
  -- GB/US/EU rows to be added once payment rails for those markets are confirmed

-- Couriers actually in use. api_provider is the adapter key the app code will
-- switch on once wired up. All start as 'manual' since no API keys exist yet —
-- flip individual rows to 'pending_integration' once credentials are requested,
-- and to 'integrated' once the adapter is built and tested.
insert into couriers (name, integration_status, api_provider, fee_type, default_cod_fee) values
  ('Aramex',            'manual', 'aramex',    'flat', 35.00),  -- UAE outbound international leg (future integration)
  ('NextDrop',          'manual', 'nextdrop',  'flat', 15.00),  -- UAE domestic / local-leg deliveries (future integration)
  ('Delhivery',         'manual', 'delhivery', 'flat', 25.00),  -- India local last-mile leg (future integration)
  ('Other UAE courier', 'manual', null,        'flat', 15.00),  -- any additional local UAE provider, entered by name per order
  ('Other local courier','manual', null,       'flat', 0.00);   -- generic fallback for any country's local courier without a dedicated row
