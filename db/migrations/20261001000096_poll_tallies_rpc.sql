-- ============================================================================
-- Poll results without the ballots.
--
-- `hydratePolls` used to download every row of `poll_votes` for the posts on a
-- page and count them in the browser. That worked, and it was wrong twice over:
--
--   * Privacy. `poll votes public read ... using (true)` (20260924000002) makes
--     every ballot world-readable: post id, option id **and voter profile id**.
--     A "which platform should we use?" poll is a public list of who answered
--     what. Migration 20260925000010 named this exact policy as still-open and
--     deferred it until an aggregate path existed — this file is that path, so
--     the per-voter read can finally be withdrawn.
--   * Scale. A feed page asks for up to 100 posts, so one anonymous visitor
--     could pull the entire ballot history of every poll on it, and the work of
--     counting was repeated per viewer instead of once per query.
--
-- `poll_tallies` answers the question the UI actually asks — how many votes per
-- option, and did *I* pick this one — and never returns a `user_id`. The viewer
-- is resolved inside the function from `auth.uid()` (through `current_profile_id`,
-- itself SECURITY DEFINER), so a caller cannot ask for somebody else's ballot
-- state or spoof one.
--
-- Idempotent: create-or-replace, revoke, grant, drop-if-exists policy swap.
-- ============================================================================

create or replace function public.poll_tallies(_post_ids uuid[])
returns table (
  post_id uuid,
  option_id text,
  votes bigint,
  voted_by_me boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid;
begin
  -- A feed page is at most 100 posts; the cap keeps one call from turning into
  -- an unbounded aggregate over the whole table.
  if coalesce(array_length(_post_ids, 1), 0) > 200 then
    raise exception 'poll_tallies accepts at most 200 posts per call';
  end if;

  -- Null for a signed-out visitor, who then sees counts and no choice of theirs.
  viewer := public.current_profile_id();

  return query
    select
      v.post_id,
      v.option_id,
      count(*)::bigint,
      -- coalesce: with no viewer, every comparison is null and bool_or of
      -- all-null is null — the column means "not mine", so say so plainly.
      coalesce(bool_or(v.user_id = viewer), false)
    from public.poll_votes v
    where v.post_id = any (_post_ids)
    group by v.post_id, v.option_id;
end;
$$;

-- Anonymous readers need it too: posts (and their polls) are public.
revoke all on function public.poll_tallies(uuid[]) from public;
grant execute on function public.poll_tallies(uuid[]) to anon, authenticated, service_role;

-- ---- withdraw the per-voter read ------------------------------------------
-- An owner can still see their *own* ballots, which is all `votePoll` needs (the
-- "already voted" check and the insert). Nothing in the app reads another
-- person's row any more, and the database no longer lets anyone try.
drop policy if exists "poll votes public read" on public.poll_votes;

create policy "poll votes owner read" on public.poll_votes
  for select to authenticated using (public.owns_profile(user_id));

-- ---- proof the door is shut (run by the migration runner) ------------------
-- After this file: a `select user_id from poll_votes` as `anon` or as another
-- signed-in user returns zero rows, while `rpc('poll_tallies', {_post_ids: […]})`
-- returns the same per-option counts the browser used to compute — and no
-- `user_id` column at all.
