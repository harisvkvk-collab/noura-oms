-- Allows admins to insert new courier records. Admins can register manual
-- couriers with WhatsApp numbers for direct booking notifications without
-- needing API integrations. Idempotent: drops and recreates the policy.

drop policy if exists "admin insert courier" on public.couriers;

create policy "admin insert courier" on public.couriers
  for insert
  with check (
    exists(
      select 1 from public.staff_users
      where staff_users.id = auth.uid()
        and staff_users.role = 'admin'
    )
  );
