-- =========================================================
-- auth_setup.sql — run this once, after schema.sql and policies.sql.
--
-- Links staff_users to real Supabase Auth accounts (auth.users), so that
-- "logged in" and "is a staff member" are the same identity, and RLS
-- policies checking auth.role() = 'authenticated' actually mean something.
--
-- How staff get added: you (the owner/admin) invite them via the Supabase
-- Dashboard (Authentication > Users > Invite user) or the Admin API — see
-- the note at the bottom. The moment their auth.users row is created, this
-- trigger automatically creates the matching staff_users profile row.
-- Nobody can self-signup; there's no public signup form in this app.
-- =========================================================

-- Table already exists from schema.sql with id uuid primary key.
-- This adds the real link to auth.users (safe to run since the table
-- should still be empty at this point — no staff invited yet).
alter table staff_users
  add constraint staff_users_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- Auto-create a staff_users profile whenever a new auth account appears.
-- security definer so it can insert into public.staff_users even though
-- it's triggered from the auth schema, which the calling role may not
-- otherwise have write access to.
create or replace function public.handle_new_staff_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.staff_users (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'role', 'staff')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_staff_user();

-- =========================================================
-- How to invite a staff member (do this in Supabase, not in app code):
--
-- Option A — Dashboard (simplest, no code):
--   Authentication > Users > Invite user > enter their email.
--   They receive an email to set their password, then can log in.
--
-- Option B — Admin API (for a future "Add staff" screen in the app):
--   Must run server-side with the service_role key — never in the
--   frontend. Example (Deno/Edge Function):
--
--   const { data, error } = await supabase.auth.admin.inviteUserByEmail(
--     'newstaff@nouraatelier.com',
--     { data: { name: 'Aisha', role: 'staff' } }  // becomes raw_user_meta_data
--   );
--
--   The 'role' passed here flows into staff_users.role via the trigger
--   above. Set it to 'admin' for accounts that should manage other staff
--   or view financial reports, 'staff' for regular order-entry accounts.
-- =========================================================
