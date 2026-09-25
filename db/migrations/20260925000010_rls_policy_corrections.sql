-- ============================================================================
-- S6 — RLS policy corrections (still-open defects).
--
-- Some audit findings were already remediated by
-- 20260924000006_security_hardening.sql (notifications forgery, message edit
-- guard, tips/payouts insert). This migration closes the remaining over-broad
-- read policies that leak private relationships or expose moderation state.
-- Idempotent (drop-if-exists before every create).
--
-- Two further findings are intentionally NOT here because their correct fix
-- requires coordinated read-path changes and are scheduled with the data-layer
-- milestone:
--   * `profiles public read using (true)` — leaks warning_count/status/
--     last_active. Needs a `profiles_public` view + column-grant migration and
--     a regeneration of every profile read (M4).
--   * `poll votes public read using (true)` — reveals individual ballots. Needs
--     an aggregate-results RPC before the per-voter read can be revoked
--     (M4/M6), otherwise poll result bars break.
-- ============================================================================

-- ---- comments: hide comments that belong to a hidden/removed post ----------
drop policy if exists "comments public read" on public.comments;
create policy "comments public read" on public.comments
for select using (
  public.is_staff()
  or public.owns_profile(user_id)
  or exists (
    select 1 from public.posts p
    where p.id = comments.post_id and not p.hidden
  )
);

-- ---- spaces: stop anonymous enumeration of every room ----------------------
-- Public visitors may see rooms that are live, recorded (replayable), or
-- scheduled within the last week; hosts and staff always see their own/all.
drop policy if exists "spaces public read" on public.spaces;
create policy "spaces public read" on public.spaces
for select using (
  live
  or recorded
  or (starts_at is not null and starts_at > now() - interval '7 days')
  or public.owns_profile(host_id)
  or public.is_staff()
);

-- ---- space_messages: transcripts only for people actually in the room ------
drop policy if exists "space messages public read" on public.space_messages;
create policy "space messages public read" on public.space_messages
for select using (
  public.is_staff()
  or public.owns_profile(user_id)
  or exists (
    select 1 from public.spaces s
    where s.id = space_messages.space_id and s.host_id = public.current_profile_id()
  )
  or exists (
    select 1 from public.space_participants sp
    where sp.space_id = space_messages.space_id and sp.user_id = public.current_profile_id()
  )
);

-- ---- space_replay_views: who replayed what is private ----------------------
-- Previously `using (true)` let any user list every listener of every Space —
-- a personal-listening-history leak.
drop policy if exists "space replay views public read" on public.space_replay_views;
create policy "space replay views read" on public.space_replay_views
for select using (
  public.is_staff()
  or public.owns_profile(user_id)
  or exists (
    select 1 from public.spaces s
    where s.id = space_replay_views.space_id and s.host_id = public.current_profile_id()
  )
);

-- ---- platform_fee_bps: don't let anonymous callers probe fee tiers ---------
revoke execute on function public.platform_fee_bps(uuid) from anon;
grant execute on function public.platform_fee_bps(uuid) to authenticated, service_role;

-- ---- webhooks: https-only endpoints + delivery error surface ---------------
-- Defence-in-depth behind the app-layer SSRF guard (src/lib/ssrf-guard.server.ts):
-- a webhook URL is stored as data, so also refuse to persist a non-https target
-- and record the last delivery failure for the owner's UI.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'webhooks_url_https'
  ) then
    alter table public.webhooks
      add constraint webhooks_url_https check (url ~* '^https://');
  end if;
end $$;

alter table public.webhook_deliveries add column if not exists last_error text;
