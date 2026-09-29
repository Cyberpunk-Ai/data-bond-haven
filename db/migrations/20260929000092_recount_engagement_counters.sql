-- =============================================================================
-- Make the engagement tallies trustworthy, because the UI now reads them
-- instead of re-counting the join tables.
--
-- Symptom: on a post whose `like_count` had drifted, tapping the heart filled
-- it in while the number beside it moved the wrong way (the feed renders
-- `posts.like_count`; the like toggle had been returning its own COUNT(*) over
-- `likes`, so the two figures disagreed by exactly the drift).
--
-- Change of source of truth: `toggleLikePost` / `toggleRepostPost` /
-- `toggleLikeStory` now read the counter column back after the write, so the
-- flag and the tally they hand the component come from the same row the feed
-- renders. That only holds if nothing can leave a counter wrong, so this
-- migration
--   1. heals every row that has already drifted, and
--   2. adds BEFORE UPDATE guards that recompute a changed tally from its source
--      table, which also closes the forgery hole (RLS lets an author UPDATE
--      their own post row, `like_count` included).
--
-- Why recompute rather than pin to OLD: the counter triggers (t_likes_after,
-- t_reposts_after, t_story_likes_after) write the honest value as part of the
-- caller's own statement, so a role check cannot tell them apart from a
-- forgery — pinning to OLD would freeze the counters at their old numbers, which
-- is exactly the trap 20260926000060 removed on profiles. Recomputing accepts
-- the true value whatever its source and discards a wrong one.
--
-- The recompute only runs when the column actually moves, so hot writes that
-- never touch a tally (an impression bumping `view_count`, a post edit) pay
-- nothing extra. SECURITY DEFINER so the counts are read past row-level
-- security and can never be narrowed to what one caller may see.
-- =============================================================================

create or replace function public.t_posts_counters_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.like_count is distinct from old.like_count then
    new.like_count := (select count(*)::integer from public.likes l where l.post_id = new.id);
  end if;
  if new.repost_count is distinct from old.repost_count then
    new.repost_count := (select count(*)::integer from public.reposts r where r.post_id = new.id);
  end if;
  return new;
end $$;

drop trigger if exists t_posts_counters_guard on public.posts;
create trigger t_posts_counters_guard before update on public.posts
for each row execute function public.t_posts_counters_guard();

create or replace function public.t_stories_counters_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.likes_count is distinct from old.likes_count then
    new.likes_count := (select count(*)::integer from public.story_likes l where l.story_id = new.id);
  end if;
  return new;
end $$;

-- The tally write on a story reaches this table from t_story_likes_after, which
-- is SECURITY DEFINER and therefore not restricted by the stories owner-only
-- UPDATE policy; this guard runs inside that same statement and must heal the
-- number rather than refuse it.
drop trigger if exists t_stories_counters_guard on public.stories;
create trigger t_stories_counters_guard before update on public.stories
for each row execute function public.t_stories_counters_guard();

comment on function public.t_posts_counters_guard() is
  'Recomputes posts.like_count / posts.repost_count from likes / reposts whenever an UPDATE changes them; honest trigger writes land unchanged, forged values are discarded.';
comment on function public.t_stories_counters_guard() is
  'Recomputes stories.likes_count from story_likes whenever an UPDATE changes it.';

-- ---- heal rows that drifted before the guard existed ------------------------
update public.posts p
   set like_count = (select count(*)::integer from public.likes l where l.post_id = p.id)
 where p.like_count is distinct from
       (select count(*)::integer from public.likes l where l.post_id = p.id);

update public.posts p
   set repost_count = (select count(*)::integer from public.reposts r where r.post_id = p.id)
 where p.repost_count is distinct from
       (select count(*)::integer from public.reposts r where r.post_id = p.id);

update public.stories s
   set likes_count = (select count(*)::integer from public.story_likes l where l.story_id = s.id)
 where s.likes_count is distinct from
       (select count(*)::integer from public.story_likes l where l.story_id = s.id);
