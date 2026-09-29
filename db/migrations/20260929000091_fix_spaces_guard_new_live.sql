-- =============================================================================
-- Fix the Live Spaces guard: PL/pgSQL does NOT guarantee that an AND chain is
-- evaluated left to right, so the "ending a room is always allowed" exemption
-- (`... and not coalesce(new.live, false)`) was compiled for every table the
-- trigger is attached to. On space_messages (and any other table whose NEW row
-- has no `live` column) it raised
--     42703  record "new" has no field "live"
-- instead of the intended "Live Spaces are paused by the platform team" notice,
-- and would have aborted legitimate UPDATEs on those tables too.
--
-- Verified with a probe harness against the live database: with the toggle off,
-- a room-chat insert now fails with the right message, while ending a live room
-- and leaving a room still succeed.
-- =============================================================================

create or replace function public.guard_spaces_enabled()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(public.platform_flag('spaces_audio_enabled'), true) then
    return coalesce(new, old);
  end if;

  if current_user = 'service_role' or auth.uid() is null then
    return coalesce(new, old);
  end if;

  if public.is_staff() then
    return coalesce(new, old);
  end if;

  -- Graceful shutdown path: ending a room (live -> false) must keep working,
  -- otherwise switching the subsystem off mid-show would strand every live
  -- host in a room they cannot close. Nested on purpose: only the `spaces`
  -- table has a `live` column, and the expression must not be evaluated for
  -- the other tables this trigger fires on.
  if TG_OP = 'UPDATE' and TG_TABLE_NAME = 'spaces' then
    if not coalesce(new.live, false) then
      return new;
    end if;
  end if;

  raise exception 'Live Spaces are paused by the platform team right now.'
    using errcode = 'PT503';
end $$;

comment on function public.guard_spaces_enabled() is
  'Enforces the spaces_audio_enabled toggle on spaces / space_participants / space_messages; hosts may always end a room and listeners may always leave.';
