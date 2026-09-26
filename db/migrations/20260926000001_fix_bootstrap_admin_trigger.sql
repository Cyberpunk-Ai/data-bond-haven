-- Fix the bootstrap-admin grant trigger added by
-- 20260925000008_replace_hardcoded_admin.sql.
--
-- That version declared:
--   insert into public.user_roles (user_id, role)
--   select b.role from ...
-- which has 2 target columns but only 1 SELECT expression. PostgreSQL raises
-- 42601 "INSERT has more target columns than expressions" when the statement
-- is ANALYZED — i.e. on every single insert into auth.users, even when the
-- allowlist select returns zero rows. Result: signup is dead with
-- "Database error saving new user" (HTTP 500).
--
-- The corrected body below supplies new.id as the user_id. Behaviour is
-- otherwise identical: only emails present in bootstrap_admins get a role,
-- re-fires on email change, and SECURITY DEFINER keeps reading the revoked
-- allowlist table possible for the trigger.

create or replace function public.grant_bootstrap_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_roles (user_id, role)
  select new.id, b.role
    from public.bootstrap_admins b
   where lower(b.email) = lower(new.email)
  on conflict do nothing;
  return new;
end $$;

-- Trigger itself is unchanged; just assert it exists so an environment that
-- somehow lost it ends up consistent.
drop trigger if exists trg_grant_bootstrap_admin on auth.users;
create trigger trg_grant_bootstrap_admin
  after insert or update of email on auth.users
  for each row execute function public.grant_bootstrap_admin();
