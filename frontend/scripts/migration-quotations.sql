-- Quotations module. Safe to run more than once.
-- Run in Supabase > SQL Editor.

create table if not exists quotation_settings (
  id                    int primary key default 1 check (id = 1),   -- single row
  business_name         text not null default 'Noura Atelier',
  website               text default 'www.nouraabaya.store',
  currency_code         text not null default 'AED',
  validity_days         int  not null default 15,
  next_number           int  not null default 1028,
  default_prepared_by   text,
  footer_text           text default 'THANK YOU FOR YOUR BUSINESS!',
  default_terms         text not null default
'1. Prices are for goods only. Door-to-door DDP shipping (including UK duty and VAT) is charged separately and confirmed at the time of shipment.
2. This quotation is valid for 15 days from the date of issue.
3. 50% advance to confirm the order; the balance is due before shipment.
4. Production takes about 20 working days from the advance payment and design approval.
5. Orders can''t be cancelled once production starts.
6. Bank transfer charges are paid by the buyer.'
);
insert into quotation_settings (id) values (1) on conflict (id) do nothing;

create table if not exists quotations (
  id             uuid primary key default gen_random_uuid(),
  quote_number   int  not null unique,
  quote_date     date not null default current_date,
  valid_until    date,
  status         text not null default 'draft'
                 check (status in ('draft','sent','accepted','expired','cancelled')),
  customer_id    uuid references customers(id),          -- optional link; details below are a snapshot
  company_name   text,
  bill_to_name   text,
  address_lines  text,                                   -- free text, several lines
  city           text,
  country        text,
  phone          text,
  customer_ref   text,                                   -- the "Customer ID" shown on the PDF
  prepared_by    text,
  prepared_by_phone text,
  currency_code  text not null default 'AED',
  terms_text     text,                                   -- copy of the terms at creation, editable per quotation
  notes          text,
  total_qty      int           not null default 0,
  total_amount   numeric(12,2) not null default 0,
  created_by     uuid,
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now()
);

create table if not exists quotation_items (
  id            uuid primary key default gen_random_uuid(),
  quotation_id  uuid not null references quotations(id) on delete cascade,
  sort_order    int  not null default 0,
  product_id    uuid references products(id),            -- null = typed by hand
  description   text not null,
  image_path    text,                                    -- private storage bucket path
  unit_price    numeric(12,2) not null default 0,
  qty           int           not null default 1 check (qty >= 0),
  line_total    numeric(12,2) generated always as (unit_price * qty) stored
);
create index if not exists quotation_items_q_idx on quotation_items(quotation_id, sort_order);

-- Next quotation number, safe against two people saving at once.
create or replace function next_quotation_number() returns int
language plpgsql security definer as $$
declare n int;
begin
  update quotation_settings set next_number = next_number + 1
   where id = 1 returning next_number - 1 into n;
  return n;
end $$;

alter table quotation_settings enable row level security;
alter table quotations         enable row level security;
alter table quotation_items    enable row level security;

drop policy if exists "staff full access" on quotation_settings;
drop policy if exists "staff full access" on quotations;
drop policy if exists "staff full access" on quotation_items;
create policy "staff full access" on quotation_settings for all using (auth.role()='authenticated') with check (auth.role()='authenticated');
create policy "staff full access" on quotations         for all using (auth.role()='authenticated') with check (auth.role()='authenticated');
create policy "staff full access" on quotation_items    for all using (auth.role()='authenticated') with check (auth.role()='authenticated');
