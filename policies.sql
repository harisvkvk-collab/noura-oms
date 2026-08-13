-- =========================================================
-- RLS policies — run this AFTER schema.sql, once tables exist.
--
-- Model: this is an internal staff tool, not multi-tenant, so the rule is
-- simple — any authenticated staff member can read/write the business
-- tables. There's no anon (public) access to anything.
--
-- courier_api_credentials is deliberately given NO policies at all. With
-- RLS enabled and zero policies, that table becomes accessible only via
-- the service_role key — which only your backend/edge functions hold,
-- never the frontend. Staff logged into the app, even authenticated ones,
-- cannot read API keys through this.
-- =========================================================

-- Helper: is the current request from a logged-in staff member?
-- (Supabase sets auth.role() = 'authenticated' once someone is logged in
-- via Supabase Auth; 'anon' otherwise.)

-- ---------- Enable RLS is already done by the "Run and enable RLS" choice.
-- If you ever create a table by hand later, remember:
--   alter table <name> enable row level security;

-- ---------- Standard staff-access policy, applied per table ----------

create policy "staff full access" on customers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on customer_addresses
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on products
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on inventory_ledger
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on orders
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on order_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on order_photos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on order_timeline
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on order_messages
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on payments
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on shipments
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on shipment_legs
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on order_returns
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on return_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on exchange_replacement_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on courier_cod_receivables
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on courier_settlements
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on courier_settlement_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on courier_payables
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on courier_payments
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on courier_payment_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on suppliers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on purchase_orders
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on purchase_order_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "staff full access" on staff_users
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ---------- Reference/lookup tables: readable by staff, not writable via API ----------
-- (You'll maintain these through the SQL editor or an admin screen, not the
-- day-to-day app, so no insert/update/delete policy is added.)

create policy "staff read" on currencies       for select using (auth.role() = 'authenticated');
create policy "staff read" on exchange_rates   for select using (auth.role() = 'authenticated');
create policy "staff read" on countries        for select using (auth.role() = 'authenticated');
create policy "staff read" on product_categories for select using (auth.role() = 'authenticated');
create policy "staff read" on couriers         for select using (auth.role() = 'authenticated');
create policy "admin update couriers" on couriers
  for update
  using (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );
create policy "staff read" on courier_zone_rates for select using (auth.role() = 'authenticated');
create policy "staff read" on country_payment_methods for select using (auth.role() = 'authenticated');

-- ---------- pickup_locations: readable by all staff, writable by admins
-- only ----------
-- Every staff member creating an order needs these for the pickup-location
-- picker in NewOrder.tsx, so SELECT stays open. Writes go through the
-- 'Manage pickup locations' admin screen (Settings.tsx / PickupLocations.tsx)
-- instead — same admin-gating pattern as courier_api_credentials, just
-- without the SELECT lockdown since none of this data (an address, a
-- contact name/phone) is actually sensitive.

create policy "staff read" on pickup_locations for select using (auth.role() = 'authenticated');

create policy "admin insert pickup locations" on pickup_locations
  for insert
  with check (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

create policy "admin update pickup locations" on pickup_locations
  for update
  using (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

create policy "admin delete pickup locations" on pickup_locations
  for delete
  using (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

-- ---------- company_settings: readable by all staff, writable by admins
-- only ----------
-- Already applied on the live DB (found alongside the table itself — see
-- schema.sql comment). Documented here for reference; same split as
-- pickup_locations. Has an admin insert policy too even though the app
-- never uses it (CompanySettings.tsx only ever updates the existing row).

create policy "staff read" on company_settings for select using (auth.role() = 'authenticated');

create policy "admin insert" on company_settings
  for insert
  with check (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

create policy "admin update" on company_settings
  for update
  using (
    exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
  );

-- ---------- courier_api_credentials: zero client policies, service_role
-- only ----------
-- Back to the original design at the top of this file: no SELECT, INSERT,
-- or UPDATE policy at all, so PostgREST denies every operation to anon AND
-- authenticated alike — this table is only ever touched via the
-- service_role key, from the save-courier-credential edge function
-- (writes) and getCourierCredentials.ts (reads for booking/testing).
-- courier_api_key_status (schema.sql) is the only way the frontend ever
-- observes anything about this table.
--
-- An earlier version of this file added admin-gated INSERT/UPDATE
-- policies here so the Settings screen could write directly, on the
-- (wrong) assumption that a same-admin-check UPDATE policy would work with
-- no SELECT policy alongside it. It doesn't: Postgres RLS requires a row
-- to be visible under a SELECT-capable policy before an UPDATE's WHERE
-- clause can match it, even when the UPDATE policy's own USING clause is
-- wide open (verified directly — with USING(true) and zero SELECT policy,
-- the UPDATE still touched 0 rows; adding a SELECT policy fixed it
-- immediately). Since a SELECT policy here would defeat the whole point
-- (api_token readable by any admin session), the direct-write policies got
-- removed and replaced by the edge function instead. INSERT was never
-- affected by this — a fresh row has no prior state to "see" — which is
-- why saving a brand-new courier's key worked in testing while rotating an
-- existing one silently no-opped.

revoke select (api_token) on courier_api_credentials from authenticated;

grant select on courier_api_key_status to authenticated;
