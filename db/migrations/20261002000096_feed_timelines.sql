-- Feed redesign: precomputed, per-viewer "For you" timelines.
--
-- The ranker used to run INSIDE the request path: every cold epoch transferred
-- the shared candidate pool + the viewer's signals and re-scored up to 2,000
-- rows while the visitor waited, in the same single-threaded node process that
-- also serves HTML. That is why the feed hit "ranker over budget (9000ms)" and
-- why the whole site felt slow under load. This migration gives the new
-- architecture its storage: rank AHEAD of the request (background worker), serve
-- a single indexed read of a materialized timeline.
--
-- timeline_items  — the ranked feed we hand back verbatim (<=300 rows/viewer).
-- feed_rank_jobs  — a coalescing queue the fan-out trigger and feed reads write;
--                   the in-process worker drains and materializes them.
--
-- viewer_id is a PROFILE id (auth.users -> profiles.id), the same key
-- for_you_signals(p_viewer) and follows.follower_id use, so RLS is the schema's
-- established owns_profile(viewer_id), not auth.uid() directly.
--
-- Rollback (drop newest first; additive, no data to restore):
--   drop trigger if exists posts_fanout_feed_rank on public.posts;
--   drop function if exists public.fanout_feed_rank_jobs();
--   drop table if exists public.feed_rank_jobs;
--   drop table if exists public.timeline_items;
--   revoke execute on function public.for_you_candidates(integer) from service_role;
--   revoke execute on function public.for_you_signals(uuid) from service_role;
begin;

-- ---------------------------------------------------------------------------
-- Materialized timeline (serve path)
-- ---------------------------------------------------------------------------
create table if not exists public.timeline_items (
  viewer_id  uuid not null references public.profiles(id) on delete cascade,
  post_id    uuid not null references public.posts(id)     on delete cascade,
  kind       text not null default 'foryou',
  score      double precision not null,
  epoch      bigint not null,
  author_id  uuid not null,
  created_at timestamptz not null,
  ranked_at  timestamptz not null default now(),
  primary key (viewer_id, kind, post_id)
);

-- Ranked paging is (score desc, post_id) — byte-identical to the ranker's own
-- (score, id) cursor order. created_at supports the pull-merge watermark.
create index if not exists timeline_items_ranked_idx
  on public.timeline_items (viewer_id, kind, score desc, post_id);
create index if not exists timeline_items_recent_idx
  on public.timeline_items (viewer_id, kind, created_at desc);
create index if not exists timeline_items_epoch_idx
  on public.timeline_items (viewer_id, kind, epoch);

-- ---------------------------------------------------------------------------
-- Re-rank work queue (coalescing: one row per viewer, due_at schedules it)
-- ---------------------------------------------------------------------------
create table if not exists public.feed_rank_jobs (
  viewer_id  uuid primary key references public.profiles(id) on delete cascade,
  reason     text,
  due_at     timestamptz not null default now(),
  attempts   integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists feed_rank_jobs_due_idx
  on public.feed_rank_jobs (due_at);

-- ---------------------------------------------------------------------------
-- Grants + RLS
--   timeline_items: a viewer can read and refresh ONLY their own feed rows.
--   feed_rank_jobs: a viewer can enqueue ONLY their own re-rank.
--   service_role (the worker) has full access; it bypasses RLS by design.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.timeline_items to authenticated;
grant all on public.timeline_items to service_role;
grant select, insert, update, delete on public.feed_rank_jobs to authenticated;
grant all on public.feed_rank_jobs to service_role;

alter table public.timeline_items enable row level security;
alter table public.feed_rank_jobs enable row level security;

create policy "timeline owner read" on public.timeline_items for select to authenticated
  using (public.owns_profile(viewer_id));
create policy "timeline owner write" on public.timeline_items for insert to authenticated
  with check (public.owns_profile(viewer_id));
create policy "timeline owner update" on public.timeline_items for update to authenticated
  using (public.owns_profile(viewer_id)) with check (public.owns_profile(viewer_id));
create policy "timeline owner delete" on public.timeline_items for delete to authenticated
  using (public.owns_profile(viewer_id));

create policy "jobs owner read" on public.feed_rank_jobs for select to authenticated
  using (public.owns_profile(viewer_id));
create policy "jobs owner write" on public.feed_rank_jobs for insert to authenticated
  with check (public.owns_profile(viewer_id));
create policy "jobs owner update" on public.feed_rank_jobs for update to authenticated
  using (public.owns_profile(viewer_id)) with check (public.owns_profile(viewer_id));

-- ---------------------------------------------------------------------------
-- Fan-out on write: a new post asks the ranker to refresh the author and each
-- of their followers. SECURITY DEFINER so a poster can enqueue on behalf of
-- followers it cannot otherwise write; explicit search_path matches every other
-- trigger function in this schema. A big account (>= 10000 followers, the
-- Twitter-style push/pull threshold) is SKIPPED: writing 10k+ rows per post is
-- the amplification X offloads to a pull-merge at read time instead, which the
-- serve path performs for followed authors.
-- ---------------------------------------------------------------------------
create or replace function public.fanout_feed_rank_jobs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  over_threshold boolean;
begin
  -- Existence probe (not count(*)) so a large account costs a bounded index
  -- scan of 10000 rows at most rather than the full follower set.
  select exists (
    select 1 from public.follows where target_id = new.user_id limit 1 offset 9999
  ) into over_threshold;
  if over_threshold then
    return new;
  end if;

  -- The author themself.
  insert into public.feed_rank_jobs (viewer_id, reason, due_at, updated_at)
  values (new.user_id, 'post', now(), now())
  on conflict (viewer_id) do update
    set reason = excluded.reason, due_at = now(), updated_at = now();

  -- Everyone who follows the author.
  insert into public.feed_rank_jobs (viewer_id, reason, due_at, updated_at)
  select f.follower_id, 'post', now(), now()
  from public.follows f
  where f.target_id = new.user_id
  on conflict (viewer_id) do update
    set reason = excluded.reason, due_at = now(), updated_at = now();

  -- A workspace post also refreshes the workspace owner's feed.
  if new.workspace_id is not null then
    insert into public.feed_rank_jobs (viewer_id, reason, due_at, updated_at)
    select w.owner_id, 'post', now(), now()
    from public.workspaces w
    where w.id = new.workspace_id
    on conflict (viewer_id) do update
      set reason = excluded.reason, due_at = now(), updated_at = now();
  end if;

  return new;
end $$;

drop trigger if exists posts_fanout_feed_rank on public.posts;
create trigger posts_fanout_feed_rank
  after insert on public.posts
  for each row execute function public.fanout_feed_rank_jobs();

-- The background worker runs the two retrieval RPCs off the request path under
-- the service role. They were granted to authenticated only (invoker-scoped for
-- the viewer's own token); this is additive — viewer access is untouched, and
-- anon/public stay revoked.
grant execute on function public.for_you_candidates(integer) to service_role;
grant execute on function public.for_you_signals(uuid) to service_role;

commit;
