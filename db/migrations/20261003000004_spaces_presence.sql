-- ============================================================================
-- Spaces — presence that expires (the listener count and the cap were both
-- counting people who had already gone)
--
-- Found while confirming the answer to "how many listeners can a Space hold?".
-- The plan cap is real (plan_limits.spaces_max_listeners: Free 10, Plus 250,
-- Pro 1,000) and `enforce_space_capacity()` enforces it — but it counted
-- *rows*, and rows never left.
--
-- `leaveSpace()` is called from the room's React cleanup. That does not run
-- when a tab is closed, reloaded, crashed, or dropped off a train: the row
-- stays. Three consequences, all of them user-visible:
--
--   1. A Free room (cap 10) fills up with ghosts and then refuses the eleventh
--      live person forever — "This Space is full", with nobody listening.
--   2. `spaces.listeners`, which the Spaces list shows, grows past the truth.
--   3. The realtime signalling channel is granted from a participant row
--      (`20260925000009_realtime_channel_rls.sql`), so somebody who left a room
--      months ago keeps the right to join its SDP traffic.
--
-- The fix is a heartbeat, which is what a "live" row has always meant:
--
--   * `last_seen` — stamped on join and every ~30s the room is open.
--   * a row that has not been stamped for `p_stale_seconds` is pruned by the
--     next heartbeat, and the existing counter trigger recounts listeners.
--   * capacity and counting both read *fresh* rows, so a room's headcount is
--     the people who are actually there.
--
-- `space_heartbeat()` does all three in one round trip and is deliberately
-- narrow: it stamps only the caller's own row (resolved from `auth.uid()` via
-- `current_profile_id()`), prunes only inside the space named, and never touches
-- the host's row — a host stepping away from the keyboard for a minute must not
-- lose the room.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

alter table public.space_participants
  add column if not exists last_seen timestamptz not null default now();

create index if not exists space_participants_seen_idx
  on public.space_participants (space_id, last_seen);

-- ---------- 1. capacity counts the living ----------
create or replace function public.enforce_space_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_space      public.spaces%rowtype;
  v_host_plan  text;
  v_max        integer;
  v_current    integer;
begin
  select * into v_space from public.spaces where id = new.space_id;
  if not found then
    return new;
  end if;

  -- The host is always allowed into their own room, and only live rooms are capped.
  if new.user_id = v_space.host_id or not v_space.live then
    return new;
  end if;

  select plan into v_host_plan from public.profiles where id = v_space.host_id;
  select spaces_max_listeners into v_max
    from public.plan_limits
   where plan = coalesce(v_host_plan, 'free');
  if v_max is null then
    v_max := 10;
  end if;

  -- Only rows whose member is still announcing themselves. Without the
  -- `last_seen` window a room that had ten tab-closes in it is permanently
  -- full, which is the bug this migration exists to fix.
  select count(*) into v_current
    from public.space_participants
   where space_id = new.space_id
     and user_id <> v_space.host_id
     and last_seen > now() - interval '3 minutes';

  if v_current >= v_max then
    raise exception 'SPACE_AT_CAPACITY' using errcode = 'P0001';
  end if;

  return new;
end $$;

drop trigger if exists spaces_capacity_guard on public.space_participants;
create trigger spaces_capacity_guard
  before insert on public.space_participants
  for each row execute function public.enforce_space_capacity();

revoke all on function public.enforce_space_capacity() from public, anon;
grant execute on function public.enforce_space_capacity() to authenticated, service_role;

-- ---------- 2. the listener column counts the living too ----------
-- Fires on a heartbeat (an update of `last_seen`) as well as on join/leave, so
-- the number on the room card is reconciled every time anybody in the room
-- proves they are there.
create or replace function public.t_space_participants_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
begin
  sid := coalesce(new.space_id, old.space_id);
  update public.spaces s
     set listeners = (
       select count(*)
         from public.space_participants p
        where p.space_id = sid
          and p.user_id <> s.host_id
          and p.last_seen > now() - interval '3 minutes'
     )
   where s.id = sid;
  return null;
end $$;

drop trigger if exists t_space_participants_after on public.space_participants;
create trigger t_space_participants_after
  after insert or delete or update of last_seen on public.space_participants
  for each row execute function public.t_space_participants_after();

revoke all on function public.t_space_participants_after() from public, anon;
grant execute on function public.t_space_participants_after() to authenticated, service_role;

-- ---------- 3. one heartbeat per open room ----------
create or replace function public.space_heartbeat(
  p_space_id uuid,
  p_stale_seconds integer default 90
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid;
  v_count integer;
begin
  v_me := public.current_profile_id();
  if v_me is null then
    raise exception 'SPACE_HEARTBEAT_SIGN_IN' using errcode = 'P0001';
  end if;

  -- Stamp myself. A room I never joined is not mine to stamp: no row, no change.
  update public.space_participants
     set last_seen = now()
   where space_id = p_space_id and user_id = v_me;

  -- Drop people who stopped announcing themselves. The host is exempt (a host
  -- who is typing into chat is still hosting), and the counter trigger above
  -- rewrites `spaces.listeners` for every row this removes.
  delete from public.space_participants p
   where p.space_id = p_space_id
     and p.user_id <> v_me
     and p.last_seen < now() - make_interval(secs => greatest(coalesce(p_stale_seconds, 90), 30))
     and p.user_id <> (select host_id from public.spaces where id = p_space_id);

  select s.listeners into v_count from public.spaces s where s.id = p_space_id;
  return coalesce(v_count, 0);
end $$;

revoke all on function public.space_heartbeat(uuid, integer) from public, anon;
grant execute on function public.space_heartbeat(uuid, integer) to authenticated, service_role;
