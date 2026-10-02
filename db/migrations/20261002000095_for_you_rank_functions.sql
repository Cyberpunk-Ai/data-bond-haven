-- Recommendation engine: push candidate retrieval + per-viewer signal fan-in
-- into Postgres so the "For you" ranker no longer ships ~2,300 full post rows
-- (content/media/poll) across the wire per viewer per epoch. Both functions are
-- STABLE and SECURITY INVOKER (the default) on purpose: the server ranker runs
-- on the VIEWER's own bearer token, so invoker semantics make the RPCs see
-- exactly the rows the previous per-query reads saw (public non-hidden posts,
-- the viewer's own engagement/impressions/prefs, the public follow graph).
-- A SECURITY DEFINER here would bypass that viewer-scoped RLS and widen access.
--
-- Rollback:
--   drop function if exists public.for_you_candidates(integer);
--   drop function if exists public.for_you_signals(uuid);
begin;

-- Stage 1 — viewer-INDEPENDENT candidate pool. recent(p_limit) UNION 48h
-- trending, deduped by id, with the effective author/workspace plan pre-joined
-- so the ranker never needs its own plan lookups. Returns SLIM rows only (no
-- content/media/poll); the full page is hydrated separately in the app.
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
      coalesce(nullif(w.plan, 'free'), op.plan) as workspace_plan
    from pool
    join public.posts p on p.id = pool.id
    left join public.profiles ap on ap.id = p.user_id
    left join public.workspaces w on w.id = p.workspace_id
    left join public.profiles op on op.id = w.owner_id
  ) x;
$$;

-- Stage 2 — the viewer's behaviour, follow graph, impressions and feed tuning
-- in one jsonb, replacing ~8 concurrent reads. engagedPosts is the small set of
-- (id, user_id, tags) rows the affinity maps are keyed from; friendFollows is
-- the raw second-degree edge list the app narrows to "not me, not already
-- first-degree" exactly as before.
create or replace function public.for_you_signals(p_viewer uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  with liked as (
    select post_id from public.likes where user_id = p_viewer limit 300
  ),
  reposted as (
    select post_id from public.reposts where user_id = p_viewer limit 300
  ),
  marked as (
    select post_id from public.bookmarks where user_id = p_viewer limit 300
  ),
  commented as (
    select post_id from public.comments where user_id = p_viewer limit 300
  ),
  impressed as (
    select post_id from public.post_impressions where user_id = p_viewer limit 1000
  ),
  following as (
    select target_id from public.follows where follower_id = p_viewer
  ),
  friendfollows as (
    select f.target_id
    from public.follows f
    where f.follower_id in (select target_id from following)
    limit 5000
  ),
  engaged as (
    select post_id from liked
    union select post_id from reposted
    union select post_id from marked
    union select post_id from commented
  ),
  engagedposts as (
    select p.id, p.user_id, p.tags
    from public.posts p
    where p.id in (select post_id from engaged limit 400)
  )
  select jsonb_build_object(
    'likes',         coalesce((select jsonb_agg(post_id) from liked), '[]'::jsonb),
    'reposts',       coalesce((select jsonb_agg(post_id) from reposted), '[]'::jsonb),
    'bookmarks',     coalesce((select jsonb_agg(post_id) from marked), '[]'::jsonb),
    'comments',      coalesce((select jsonb_agg(post_id) from commented), '[]'::jsonb),
    'impressions',   coalesce((select jsonb_agg(post_id) from impressed), '[]'::jsonb),
    'following',     coalesce((select jsonb_agg(target_id) from following), '[]'::jsonb),
    'friendFollows', coalesce((select jsonb_agg(target_id) from friendfollows), '[]'::jsonb),
    'engagedPosts',  coalesce((select jsonb_agg(to_jsonb(ep)) from engagedposts ep), '[]'::jsonb),
    'prefs',         (select fp.prefs from public.feed_preferences fp where fp.user_id = p_viewer limit 1)
  );
$$;

-- Execute only for signed-in viewers (mirrors the per-viewer RLS the reads
-- already relied on); never for anon/public.
revoke execute on function public.for_you_candidates(integer) from public, anon;
revoke execute on function public.for_you_signals(uuid) from public, anon;
grant execute on function public.for_you_candidates(integer) to authenticated;
grant execute on function public.for_you_signals(uuid) to authenticated;

commit;
