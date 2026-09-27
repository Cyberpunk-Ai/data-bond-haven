-- =============================================================================
-- Fix: follower / following counters could never be updated (they read 0 for
-- every account, on every surface: profile pages, "who to follow", analytics).
--
-- Cause: trigger ordering, not a missing trigger.
--   t_follows_after (AFTER INSERT/DELETE on follows) recomputes
--   profiles.following / profiles.followers.
--   t_profiles_guard (BEFORE UPDATE on profiles), added in
--   20260924000006_security_hardening to stop clients inflating their own
--   follower counts, pins those two columns back to OLD on every update.
--   The guard's `auth.role() = 'service_role' or is_staff()` bypass is decided
--   from the JWT claims of the *caller*, and the counter trigger runs inside
--   that same caller's statement — so the honest rewrite is always produced by
--   a non-service role and gets reverted. Net effect: the counters are write-
--   protected against both forgeries AND maintenance.
--
-- Fix: instead of pinning counters to OLD, recompute them from the source of
-- truth (the follows table). A client can still forge nothing - the value it
-- sends is discarded and replaced by the real count - but trigger maintenance
-- now lands, and any row that has already drifted self-heals the next time it
-- is touched. Both counts are index-only scans: follows' PK covers
-- (follower_id, target_id) and follows_target_idx covers (target_id,
-- follower_id). Counter maintenance is deliberately unconditional (service
-- role included): there is no legitimate writer of these columns other than
-- the follows triggers.
--
-- The trailing statement backfills rows that never get an UPDATE afterwards.
-- =============================================================================

create or replace function public.t_profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Follower/following are derived facts: always recompute from `follows`,
  -- regardless of caller. See header note for why pinning to OLD broke the
  -- counter triggers.
  new.followers := (select count(*)::integer from public.follows f where f.target_id = old.id);
  new.following := (select count(*)::integer from public.follows f where f.follower_id = old.id);

  if auth.role() = 'service_role' or public.is_staff() then
    return new;
  end if;
  new.plan           := old.plan;
  new.verified       := old.verified;
  new.status         := old.status;
  new.warning_count  := old.warning_count;
  return new;
end $$;

-- Backfill every row once (this UPDATE also runs through the rewritten guard,
-- which recomputes the same values, so the two are consistent by construction).
update public.profiles p
   set followers = (select count(*)::integer from public.follows f where f.target_id = p.id),
       following = (select count(*)::integer from public.follows f where f.follower_id = p.id)
 where p.followers <> (select count(*)::integer from public.follows f where f.target_id = p.id)
    or p.following <> (select count(*)::integer from public.follows f where f.follower_id = p.id);
