-- ============================================================================
-- Team workspaces as a standalone public profile.
--
-- A team post should open the *workspace's* own profile (identity + team
-- posts) to anyone who can see the post — not the individual member who
-- authored it. The `workspaces` table is, by design, only readable by the
-- owner and its members ("workspaces member read"), so a plain table SELECT
-- can't serve a public profile without also exposing the member roster,
-- owner_id, seats and plan.
--
-- This adds a SECURITY DEFINER reader that returns ONLY the public identity
-- columns (name, logo, avatar, bio, join date) plus a count of the team's
-- visible posts. It never touches workspace_members, so the roster stays
-- private. Posts themselves are already publicly readable ("posts public
-- read"), so the profile feed needs no new policy.
-- ============================================================================

create or replace function public.get_workspace_profile(_workspace_id uuid)
returns table (
  id         uuid,
  name       text,
  logo_emoji text,
  avatar_url text,
  bio        text,
  created_at timestamptz,
  post_count bigint
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
    ) as post_count
  from public.workspaces w
  where w.id = _workspace_id;
$$;

revoke all on function public.get_workspace_profile(uuid) from public;
grant execute on function public.get_workspace_profile(uuid) to anon, authenticated, service_role;
