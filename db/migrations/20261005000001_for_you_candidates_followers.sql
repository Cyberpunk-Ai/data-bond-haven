-- Merit reach: expose the author's follower count on the candidate pool so the
-- ranker can boost accounts by organic value (impressions + audience) IN ADDITION
-- to the paid-plan boost. A free account whose content earns views/followers is
-- content with value and must be able to get lifted, not just Pro/Plus/paid
-- workspaces. This is a byte-for-byte re-definition of for_you_candidates with a
-- single added projection (`ap.followers as author_followers`) — the `ap` profile
-- join already exists, so there is no new table scan and no cost change.
--
-- `create or replace function` preserves the existing grants/ACL (execute to
-- authenticated + service_role, revoked from public/anon), so nothing about who
-- can call it changes. The consumer (feed-rank-core.meritFactor) treats a missing
-- author_followers as 0, so ranking keeps working before this migration lands.
--
-- Rollback:
--   -- re-apply 20261002000095_for_you_rank_functions.sql (drops the column again)
begin;

create or replace function public.for_you_candidates(p_limit integer)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
  from (
    with recent as (
      select p.id
      from public.posts p
      where p.hidden = false
      order by p.created_at desc
      limit p_limit
    ),
    trending as (
      select p.id
      from public.posts p
      where p.hidden = false
        and p.created_at >= now() - interval '48 hours'
      order by p.like_count desc
      limit 300
    ),
    pool as (
      select id from recent
      union
      select id from trending
    )
    select
      p.id,
      p.user_id,
      p.workspace_id,
      p.created_at,
      p.tags,
      p.like_count,
      p.comment_count,
      p.repost_count,
      p.view_count,
      ap.plan as author_plan,
      -- A workspace post inherits the workspace plan, falling back to the
      -- workspace OWNER's personal plan on the free tier. Non-member workspaces
      -- read as null under RLS (same as the old JS), so it falls back to the
      -- author's own plan downstream.
      coalesce(nullif(w.plan, 'free'), op.plan) as workspace_plan,
      -- Organic-merit signal: the author's audience. Log-scaled and bounded in
      -- the app (meritFactor), never a raw multiplier, so a huge account can't
      -- dominate purely on follower count.
      ap.followers as author_followers
    from pool
    join public.posts p on p.id = pool.id
    left join public.profiles ap on ap.id = p.user_id
    left join public.workspaces w on w.id = p.workspace_id
    left join public.profiles op on op.id = w.owner_id
  ) x;
$$;

commit;
