-- ============================================================================
-- Space recordings belong to the host alone.
--
-- The `spaces public read` policy (20260925000010) treated `recorded = true`
-- as a visibility grant: anybody could read replay rows — and the
-- `recording_url` column — for rooms they never hosted. Replays are the
-- host's property now: a recorded room is readable only through the host (or
-- staff) branches of the policy.
--
-- The byte-level ACL in src/lib/media-authz.server.ts (recordings/ folder)
-- is tightened in the same deploy: host or staff, no longer "any participant".
-- Both halves ship together; either one alone would leave the replay either
-- invisible but streamable, or visible but unplayable.
-- ============================================================================

drop policy if exists "spaces public read" on public.spaces;
create policy "spaces public read" on public.spaces
for select using (
  live
  or (starts_at is not null and starts_at > now() - interval '7 days')
  or public.owns_profile(host_id)
  or public.is_staff()
);
