-- ============================================================================
-- `has_role` is an answer about somebody's privileges — gate it.
--
-- The function has been world-callable since the first schema: `anon` (no
-- sign-in at all) could ask `has_role(<any auth uid>, 'admin')` for every uuid
-- in sight. Two things fall out of that:
--
--   * Role disclosure. A caller who has any user id — from a profile page, a
--     mention, or a uuid walk — can test whether it belongs to an administrator
--     or a moderator. That is a target list for whoever runs the platform, and
--     it is exactly the kind of "who is on the inside" answer the roles table
--     itself is carefully RLS-protected from (`roles self read`) while the
--     helper that reads it was left wide open.
--   * The bypass was pointless. Every legitimate caller asks about *itself*:
--       - `src/routes/admin.tsx` and `staff.server.ts` pass `context.userId` /
--         the session's own `auth.uid()`;
--       - `admin.functions.ts` guards with the caller's own id;
--       - the two RLS policies that use it (`system settings admin write`,
--         `roles admin write`) are written as `has_role(auth.uid(), …)`.
--     Nothing in the product needs to learn a third party's role, and staff who
--     genuinely do (the moderation desk) are covered by the staff branch.
--
-- The gate needs `is_staff()` to stop calling `has_role`, or the two functions
-- would recurse into each other forever, so `is_staff()` is rewritten to read
-- `user_roles` directly first. It answers the same question and reveals nothing
-- about anyone but the caller.
--
-- Idempotent: create-or-replace plus revoke/grant.
-- ============================================================================

-- 1. Break the dependency: staff-ness, computed without asking `has_role`.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_roles r
    where r.user_id = auth.uid()
      and r.role in ('admin', 'moderator')
  )
$$;

-- 2. Answer only what the caller is allowed to know.
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
      -- Server paths (webhooks, migration runner, admin client) hold the
      -- service key. They already read `user_roles` directly — RLS does not
      -- apply to them — so pretending otherwise would only break them.
      auth.role() = 'service_role'
      -- Everybody may ask about themselves: this is what the admin screens and
      -- the two RLS policies actually do.
      or _user_id = auth.uid()
      -- Staff may ask about anyone, which is what the moderation desk needs.
      or public.is_staff()
    )
    and exists (
      select 1
      from public.user_roles r
      where r.user_id = _user_id
        and r.role = _role
    )
$$;

-- 3. Anonymous callers lose the privilege of asking at all. A signed-in user
--    keeps the self-check above; `is_staff()` takes no argument, so it stays
--    callable and tells a caller nothing about anybody else.
revoke execute on function public.has_role(uuid, public.app_role) from public, anon;
grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;

revoke execute on function public.is_staff() from public;
grant execute on function public.is_staff() to anon, authenticated, service_role;

-- ---- proof the door is shut (run by the migration runner) ------------------
-- After this file, as `anon`: `rpc('has_role', {_user_id: <admin uuid>, _role:
-- 'admin'})` must be refused (42501, no privilege) and the same call as a
-- non-staff `authenticated` user about *another* id must return false, while
-- asking about oneself still returns the truth.
