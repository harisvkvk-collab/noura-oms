-- pickup_locations currently has a blanket "staff full access" policy
-- (created outside this migration history, alongside the table itself) —
-- any authenticated staff member can insert/update/delete. Since this is
-- now managed through an admin-only "Manage pickup locations" screen,
-- tighten writes to admin, same pattern as courier_api_credentials.
-- Reads stay open to all staff — everyone creating an order needs the
-- pickup-location picker in NewOrder.tsx, not just admins.

drop policy if exists "staff full access" on pickup_locations;

create policy "staff read" on pickup_locations
  for select using (auth.role() = 'authenticated');

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
