-- ============================================================================
-- S5 — Lock down Realtime broadcast channels.
--
-- The WebRTC signalling channels (`space-audio:<id>`, `call-signal-<id>`) and
-- the app-wide bus (`spaces-app-events`) were plain *public* broadcast
-- channels. Any client could join them, read the SDP offers (which carry ICE
-- candidate IP addresses), and inject competing signals — a location leak and a
-- call/space hijack.
--
-- Supabase only enforces RLS on broadcast for channels marked `private: true`
-- on the client (see src/hooks/useSpaceAudio.ts, useCallSession.ts,
-- src/lib/realtime.ts). This migration enables RLS on realtime.messages and
-- writes per-channel-pattern policies. Both halves must ship together.
--
-- NOTE FOR DEPLOY: private-channel RLS is sensitive to the project's Realtime
-- version (the `topic` column and policy evaluation). Validate call + Space
-- join in staging before promoting to production.
-- ============================================================================

-- Enable RLS only when it is actually off: on hosted Supabase the table is
-- owned by supabase_realtime_admin (already-RLS-on via the Messages
-- Authorization toggle), and the migration role may not own it — a bare ALTER
-- would abort the whole file with "must be owner of table messages".
do $$
begin
  if not (
    select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass
  ) then
    alter table realtime.messages enable row level security;
  end if;
exception when insufficient_privilege then
  raise notice 'realtime.messages RLS is managed by Supabase; skipping enable';
end $$;

-- ---- space-audio:<spaceId> : host, participants and staff only -------------

drop policy if exists "space audio broadcast insert" on realtime.messages;
create policy "space audio broadcast insert" on realtime.messages
for insert to authenticated
with check (
  topic like 'space-audio:%'
  and (
    public.is_staff()
    or exists (
      select 1 from public.spaces s
      where s.id::text = split_part(topic, ':', 2)
        and (
          s.host_id = public.current_profile_id()
          or exists (
            select 1 from public.space_participants sp
            where sp.space_id = s.id and sp.user_id = public.current_profile_id()
          )
        )
    )
  )
);

drop policy if exists "space audio read" on realtime.messages;
create policy "space audio read" on realtime.messages
for select to authenticated
using (
  topic like 'space-audio:%'
  and (
    public.is_staff()
    or exists (
      select 1 from public.spaces s
      where s.id::text = split_part(topic, ':', 2)
        and (
          s.host_id = public.current_profile_id()
          or exists (
            select 1 from public.space_participants sp
            where sp.space_id = s.id and sp.user_id = public.current_profile_id()
          )
        )
    )
  )
);

-- ---- call-signal-<callId> : the two participants (or staff) only -----------
-- The channel name embeds a uuid that itself contains '-', so strip the stable
-- prefix rather than splitting on '-'.

drop policy if exists "call signal broadcast insert" on realtime.messages;
create policy "call signal broadcast insert" on realtime.messages
for insert to authenticated
with check (
  topic like 'call-signal-%'
  and (
    public.is_staff()
    or exists (
      select 1 from public.calls c
      where c.id::text = replace(topic, 'call-signal-', '')
        and (
          c.caller_id = public.current_profile_id()
          or c.callee_id = public.current_profile_id()
        )
    )
  )
);

drop policy if exists "call signal read" on realtime.messages;
create policy "call signal read" on realtime.messages
for select to authenticated
using (
  topic like 'call-signal-%'
  and (
    public.is_staff()
    or exists (
      select 1 from public.calls c
      where c.id::text = replace(topic, 'call-signal-', '')
        and (
          c.caller_id = public.current_profile_id()
          or c.callee_id = public.current_profile_id()
        )
    )
  )
);

-- ---- spaces-app-events : signed-in users only (no anonymous world-join) ----
-- This bus carries like/repost/follow/counter updates. It is not membership-
-- scoped, so it is opened to any authenticated user (and closed to anon).
-- Sensitive, per-user events (tips, DMs) ride the postgres_changes feed, which
-- already respects the table RLS policies.

drop policy if exists "app events broadcast insert" on realtime.messages;
create policy "app events broadcast insert" on realtime.messages
for insert to authenticated
with check (topic = 'spaces-app-events');

drop policy if exists "app events read" on realtime.messages;
create policy "app events read" on realtime.messages
for select to authenticated
using (topic = 'spaces-app-events');
