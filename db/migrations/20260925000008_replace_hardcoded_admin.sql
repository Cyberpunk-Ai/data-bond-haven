-- ============================================================================
-- S1 — Retire the hardcoded super-admin backdoor.
--
-- 20260924000007_first_admin.sql installed an AFTER INSERT/UPDATE trigger on
-- auth.users that granted the `admin` role to any account whose email matched a
-- single hard-coded personal address. That address is now in published git
-- history, so the mechanism is a standing privilege-escalation path: anyone who
-- can register or change their email to that value becomes a platform admin,
-- and it leaked the operator's personal email into a public repo.
--
-- Admin membership is now DATA, not CODE: an `bootstrap_admins` allowlist table
-- drives the grant, so it can be rotated from the dashboard without a deploy
-- and never appears in source control again.
-- ============================================================================

-- 1. Remove the old mechanism.
drop trigger if exists trg_grant_owner_admin on auth.users;
drop function if exists public.grant_owner_admin();

-- 2. The allowlist. Membership is added/removed with plain SQL/dashboard
--    actions by an existing admin; it holds no secret besides the addresses
--    themselves, which are protected from read by RLS below.
create table if not exists public.bootstrap_admins (
  email      text   not null,
  role       public.app_role not null default 'admin',
  added_by   uuid   references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- One row per (lowercased email, role).
create unique index if not exists bootstrap_admins_email_role_uniq
  on public.bootstrap_admins (lower(email), role);

alter table public.bootstrap_admins enable row level security;

-- Nobody reads/writes this table directly. All access is service_role (the
-- dashboard / a documented one-off run by the operator). The grant trigger
-- below is SECURITY DEFINER and owned by the migration role, so it can read
-- the table regardless of RLS.
revoke all on public.bootstrap_admins from public, anon, authenticated;
grant all on public.bootstrap_admins to service_role;

-- 3. The replacement trigger: grants a role only to emails present in the
--    allowlist. Re-fires on email change, but only ever grants what the table
--    says — no code-level addresses.
create or replace function public.grant_bootstrap_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_roles (user_id, role)
  select b.role
    from public.bootstrap_admins b
   where lower(b.email) = lower(new.email)
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists trg_grant_bootstrap_admin on auth.users;
create trigger trg_grant_bootstrap_admin
  after insert or update of email on auth.users
  for each row execute function public.grant_bootstrap_admin();

-- 4. Clean-up guidance (run deliberately, not automatically): the account the
--    old trigger may have already promoted still holds `admin`. Confirm whether
--    that is your own operator account; if so, add its email to bootstrap_admins
--    to keep it sanctioned, and it becomes an explicit, auditable grant:
--
--      insert into public.bootstrap_admins (email, role)
--      values ('the-operator-address@example.com', 'admin');
--
--    If instead you want to revoke an unsanctioned admin:
--
--      delete from public.user_roles
--       where role in ('admin','moderator')
--         and user_id = (select id from auth.users where lower(email) = '<address>');
