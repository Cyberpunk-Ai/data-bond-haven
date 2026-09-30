-- =============================================================================
-- Spaces — live audio stores nothing; only a recording costs storage, and that
-- recording must fit the host's plan.
--
-- Why this is not just a UI rule:
--   * `t_spaces_recording_cap` (20260924000051) policed one flat 1 GiB ceiling
--     for every plan, so a Free room could report a gigabyte of replay bytes
--     while the pricing page promised no recordings at all;
--   * `plan_limits.storage_quota_mb` existed but nothing ever read it, so a
--     host's replays accumulated in the media store without bound.
--
-- Space replay bytes now have their own column, because the two budgets mean
-- different things: `media_upload_max_mb` is the size of ONE file, while
-- `spaces_storage_mb` is everything a host keeps as replays at once. Both are
-- enforced here at the database and at the upload endpoint, so a handcrafted
-- PostgREST write cannot walk around either.
--
-- A live broadcast itself writes no bytes anywhere: a `spaces` row with no
-- `recording_url` is the normal case and is never policed (ending, deleting or
-- clearing a room must always work, whatever the plan).
-- =============================================================================

-- 1. Tier budget for stored Space replays: Free 250 MB · Plus 1 GB · Pro 5 GB.
alter table public.plan_limits
  add column if not exists spaces_storage_mb integer not null default 0;

update public.plan_limits
   set spaces_storage_mb = case plan
         when 'free' then 250
         when 'plus' then 1024
         when 'pro'  then 5120
         else 0
       end,
       updated_at = now()
 where plan in ('free', 'plus', 'pro');

-- 2. Plan-aware recording guard, replacing the flat 1 GiB ceiling.
create or replace function public.t_spaces_recording_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_can_record   boolean;
  v_room_bytes   bigint;
  v_quota_bytes  bigint;
  v_used_bytes   bigint;
begin
  -- Only a room that actually holds a replay is policed. The recording byte
  -- counter is an estimate the host's own browser reports, so bytes without a
  -- stored object cost the platform nothing — and clearing a replay (deleting
  -- it, or ending a room that never recorded) must never be blocked, or a host
  -- on a plan we have since downgraded could never free their own space.
  if new.recording_url is null then
    return new;
  end if;

  -- And only the write that *changes* a replay is policed. This trigger fires on
  -- every UPDATE of a room row, so without this exemption an unrelated edit —
  -- ending the room, a listener count, a bump of replay_count from the view
  -- trigger — would be refused the moment a host's stored replays outgrew their
  -- plan, stranding a live room they could no longer close. (Same class of bug
  -- as 20260929000091, which broke ending a room for a different reason.)
  if TG_OP = 'UPDATE'
     and new.recording_url = old.recording_url
     and new.recording_bytes is not distinct from old.recording_bytes then
    return new;
  end if;

  select l.spaces_recording,
         l.media_upload_max_mb::bigint * 1048576,
         l.spaces_storage_mb::bigint * 1048576
    into v_can_record, v_room_bytes, v_quota_bytes
    from public.plan_limits l
    join public.profiles p on p.id = new.host_id
   where l.plan = coalesce(p.plan, 'free');

  -- A host with no profile row, or a plan we have no matrix for, gets the free
  -- tier rather than a pass.
  if v_can_record is null then
    v_can_record := false;
  end if;
  if v_room_bytes is null then
    v_room_bytes := 10485760; -- 10 MB, the free tier's per-file ceiling
  end if;
  if v_quota_bytes is null then
    v_quota_bytes := 0;
  end if;

  if not v_can_record then
    raise exception 'Space recordings are not part of this plan — upgrade to save a replay.'
      using errcode = 'PT402';
  end if;

  if coalesce(new.recording_bytes, 0) > v_room_bytes then
    raise exception 'This recording is larger than the % MB limit for one Space on this plan',
      round(v_room_bytes / 1048576)
      using errcode = 'PT413';
  end if;

  -- Everything the host keeps as a replay, plus this one, against the plan's
  -- budget. Only rooms with a stored object count; the row being rewritten is
  -- excluded so re-recording one room does not charge it twice.
  select coalesce(sum(recording_bytes), 0)
    into v_used_bytes
    from public.spaces
   where host_id = new.host_id
     and id is distinct from new.id
     and recording_url is not null;

  if v_used_bytes + coalesce(new.recording_bytes, 0) > v_quota_bytes then
    raise exception 'Your Space storage is full (% MB of the % MB budget) — delete an old replay to keep this one.',
      round((v_used_bytes + coalesce(new.recording_bytes, 0)) / 1048576),
      round(v_quota_bytes / 1048576)
      using errcode = 'PT507';
  end if;

  return new;
end;
$$;

drop trigger if exists t_spaces_recording_cap on public.spaces;
create trigger t_spaces_recording_cap
  before insert or update on public.spaces
  for each row execute function public.t_spaces_recording_cap();

comment on column public.plan_limits.spaces_storage_mb is
  'Total bytes (MB) of stored Space replays a plan may keep at once. A live broadcast is free: only a recording with a recording_url counts.';
comment on function public.t_spaces_recording_cap() is
  'Enforces the host plan on spaces.recording_url/recording_bytes: recordings allowed at all, one file under media_upload_max_mb, all replays together under spaces_storage_mb. Rooms without a stored replay are never blocked.';
