-- ============================================================================
-- Spaces — plan-based max-listener capacity enforcement
--
-- The pricing matrix advertises a hard audience cap per tier (Free 10,
-- Plus 250, Pro 1,000 listeners) and plan_limits.spaces_max_listeners is the
-- single source of truth for it, but nothing actually refused an 11th person
-- joining a free host's room. This closes that gap at the database so the cap
-- cannot be bypassed by hitting PostgREST directly:
--
--   * A BEFORE INSERT guard on space_participants rejects a join once the room
--     already holds `spaces_max_listeners` non-host participants. The host and
--     anyone already in the room are never locked out, and non-live rooms
--     (scheduled / replays) are not capped here.
--   * Raises a stable SQLERRM token (SPACE_AT_CAPACITY) the client maps to a
--     friendly "This Space is full" toast.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

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

  select count(*) into v_current
    from public.space_participants
   where space_id = new.space_id
     and user_id <> v_space.host_id;

  if v_current >= v_max then
    raise exception 'SPACE_AT_CAPACITY' using errcode = 'P0001';
  end if;

  return new;
end $$;

drop trigger if exists spaces_capacity_guard on public.space_participants;
create trigger spaces_capacity_guard
  before insert on public.space_participants
  for each row execute function public.enforce_space_capacity();

-- Keep the grant model consistent with the other participant triggers.
revoke all on function public.enforce_space_capacity() from public, anon;
grant execute on function public.enforce_space_capacity() to authenticated, service_role;
