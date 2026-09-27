-- ============================================================================
-- Team profile parity: expose a member COUNT on the public workspace profile.
--
-- The workspace profile page now mirrors the personal profile's stats row
-- (Posts / Members). The roster itself stays private ("workspace members
-- read" RLS), but a plain head-count is public the same way a follower count
-- is on a personal profile. Changing the returns-table signature means the
-- function must be dropped and recreated; grants are re-applied below.
-- ============================================================================

drop function if exists public.get_workspace_profile(uuid);

create or replace function public.get_workspace_profile(_workspace_id uuid)
returns table (
  id           uuid,
  name         text,
  logo_emoji   text,
  avatar_url   text,
  bio          text,
  created_at   timestamptz,
  post_count   bigint,
  member_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    w.id,
    w.name,
    w.logo_emoji,
    w.avatar_url,
    w.bio,
    w.created_at,
    (
      select count(*)
      from public.posts p
      where p.workspace_id = w.id
        and p.hidden = false
    ) as post_count,
    (
      select count(*)
      from public.workspace_members m
      where m.workspace_id = w.id
        and m.status = 'active'
    ) as member_count
  from public.workspaces w
  where w.id = _workspace_id;
$$;

revoke all on function public.get_workspace_profile(uuid) from public;
grant execute on function public.get_workspace_profile(uuid) to anon, authenticated, service_role;
