-- Run in Supabase SQL editor. Single-row table holding your business's own
-- identity details — used on printed shipping slips/labels, and anywhere
-- else "From: [your business]" needs to appear.

create table company_settings (
  id              uuid primary key default gen_random_uuid(),
  business_name   text not null default 'Noura Abaya',
  address         text,
  city            text,
  country_code    text references countries(code),
  phone           text,
  email           text,
  logo_url        text,
  updated_at      timestamptz not null default now()
);

alter table company_settings enable row level security;

-- Any authenticated staff can read it (needed to print labels);
-- only admins can change it.
create policy "staff read" on company_settings
  for select using (auth.role() = 'authenticated');

create policy "admin update" on company_settings
  for update using (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

create policy "admin insert" on company_settings
  for insert with check (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

-- Seed one row so the app always has exactly one settings record to read/update
insert into company_settings (business_name) values ('Noura Abaya');
