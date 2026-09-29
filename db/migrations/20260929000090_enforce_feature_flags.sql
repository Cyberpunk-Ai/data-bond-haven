-- =============================================================================
-- Make the four Core Platform Feature Toggles actually enforce themselves.
--
-- Before this, `system_settings` was written by the admin console and read by
-- nothing: switching off "Maintenance Mode", "New User Registration", "AI
-- Drafting" or "Live Audio Spaces" changed a checkbox and a number on screen,
-- while every code path kept serving content. The published promise is
-- "server-side enforcement", so the enforcement lives in the database: it
-- covers the direct PostgREST writes the browser makes (posts, spaces, DMs)
-- that no server function of ours ever sees, and it applies the moment the row
-- is written — no deploy, no restart, no dropped connection.
--
-- Design notes
--   * `platform_flag()` is the single reader. It returns NULL when the setting
--     row or column is absent so every guard picks its own fail-safe default:
--     a missing configuration must never block real traffic.
--   * Guard functions run as INVOKER, not DEFINER, so `current_user` is the
--     role PostgREST/GoTrue actually connected with. That distinction is what
--     keeps service-role writes (our server functions, admin tooling) working
--     during maintenance while visitor writes are refused.
--   * Staff (admin/moderator) are never locked out by Maintenance Mode — the
--     people who fix the incident need the console and the app to keep working.
--   * Shutdown-safe: with Spaces switched off mid-broadcast, a host can still
--     END their room and a listener can still leave (DELETE and live=false
--     updates are exempt), so flipping the toggle never strands a live room.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Flag reader
-- -----------------------------------------------------------------------------
create or replace function public.platform_flag(_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case _name
      when 'maintenance_mode'      then s.maintenance_mode
      when 'registration_enabled'  then s.registration_enabled
      when 'ai_generation_enabled' then s.ai_generation_enabled
      when 'spaces_audio_enabled'  then s.spaces_audio_enabled
      when 'stories_enabled'       then s.stories_enabled
      else null
    end
  from public.system_settings s
  where s.id = 1;
$$;

comment on function public.platform_flag(text) is
  'Reads one Core Platform feature toggle. NULL = not configured; callers choose the safe default.';

-- -----------------------------------------------------------------------------
-- 2. Maintenance Mode — refuse visitor writes on user-generated content
-- -----------------------------------------------------------------------------
create or replace function public.guard_platform_maintenance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Fast path: the flag is off for the whole life of the platform, so this
  -- costs one single-row PK lookup and nothing else ever runs.
  if not coalesce(public.platform_flag('maintenance_mode'), false) then
    return coalesce(new, old);
  end if;

  -- Writes made with the service-role key (our server functions, admin tooling)
  -- and background writes with no JWT at all (security-definer triggers such as
  -- notification fan-out) are not "visitors".
  if current_user = 'service_role' or auth.uid() is null then
    return coalesce(new, old);
  end if;

  if public.is_staff() then
    return coalesce(new, old);
  end if;

  raise exception 'Spaces1 is in maintenance mode — this action is limited to staff accounts right now.'
    using errcode = 'PT503';
end $$;

-- Applies to every user-facing content write: insert (post/send/join), update
-- (edit/react/read-receipt) and delete (take down). Reads are deliberately left
-- open — maintenance restricts what people change, it does not take the site down.
do $$
declare
  t text;
begin
  foreach t in array array[
      'posts','comments','likes','reposts','bookmarks','poll_votes','follows',
      'stories','story_likes','messages','message_reactions',
      'calls','call_signals','space_participants','space_messages','tips'
    ]
  loop
    execute format('drop trigger if exists %I on public.%s', 't_' || t || '_platform_guard', t);
    execute format(
      'create trigger %I before insert or update or delete on public.%s for each row execute function public.guard_platform_maintenance()',
      't_' || t || '_platform_guard', t
    );
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 3. New User Registration — hard stop at the auth table
--
-- Sign-ups reach GoTrue directly (browser → /auth/v1/signup), so no server
-- function of ours is ever involved: the only real gate is the insert into
-- auth.users. GoTrue connects as `supabase_auth_admin`, which is why this guard
-- must not be SECURITY DEFINER (current_user would collapse to the owner) and
-- must not call auth.uid()/auth.role() (that role has no execute on them).
-- -----------------------------------------------------------------------------
create or replace function public.guard_registration_open()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Creating an account with the service-role key is deliberate admin
  -- provisioning (importing a member, first-admin bootstrap), not a public
  -- sign-up, so it stays allowed even when sign-ups are closed.
  if current_user = 'service_role' then
    return new;
  end if;

  if not coalesce(public.platform_flag('registration_enabled'), true) then
    raise exception 'New sign-ups are paused right now. Please check back shortly.'
      using errcode = 'PT403';
  end if;

  -- A brand-new account during a maintenance window would only meet a locked
  -- door, so registration inherits the maintenance switch too.
  if coalesce(public.platform_flag('maintenance_mode'), false) then
    raise exception 'Spaces1 is in maintenance mode, so new sign-ups are paused.'
      using errcode = 'PT503';
  end if;

  return new;
end $$;

-- Must run before the row exists; on_auth_user_created (profile provisioning)
-- stays as-is, and the email of an admin-allowlisted account is still granted.
drop trigger if exists trg_guard_registration_open on auth.users;
create trigger trg_guard_registration_open
  before insert on auth.users
  for each row execute function public.guard_registration_open();

-- -----------------------------------------------------------------------------
-- 4. Live Audio Spaces subsystem
-- -----------------------------------------------------------------------------
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

  -- Graceful shutdown path: ending a room (live -> false) and leaving one
  -- (delete) must keep working, otherwise switching the subsystem off mid-show
  -- would strand every live host in a room they cannot close.
  if TG_OP = 'UPDATE' and TG_TABLE_NAME = 'spaces' and not coalesce(new.live, false) then
    return new;
  end if;

  raise exception 'Live Spaces are paused by the platform team right now.'
    using errcode = 'PT503';
end $$;

drop trigger if exists t_spaces_audio_guard on public.spaces;
create trigger t_spaces_audio_guard
  before insert or update on public.spaces
  for each row execute function public.guard_spaces_enabled();

drop trigger if exists t_space_participants_audio_guard on public.space_participants;
create trigger t_space_participants_audio_guard
  before insert or update on public.space_participants
  for each row execute function public.guard_spaces_enabled();

drop trigger if exists t_space_messages_audio_guard on public.space_messages;
create trigger t_space_messages_audio_guard
  before insert on public.space_messages
  for each row execute function public.guard_spaces_enabled();

-- -----------------------------------------------------------------------------
-- 5. Stories (the fifth toggle in system_settings, kept consistent)
-- -----------------------------------------------------------------------------
create or replace function public.guard_stories_enabled()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(public.platform_flag('stories_enabled'), true) then
    return new;
  end if;
  if current_user = 'service_role' or auth.uid() is null or public.is_staff() then
    return new;
  end if;
  raise exception 'Stories are paused by the platform team right now.'
    using errcode = 'PT503';
end $$;

drop trigger if exists t_stories_enabled_guard on public.stories;
create trigger t_stories_enabled_guard
  before insert on public.stories
  for each row execute function public.guard_stories_enabled();

-- -----------------------------------------------------------------------------
-- 6. Keep the settings row live in every open tab
--
-- The console already broadcasts `settings:updated` over the app's private
-- event bus, but guests never join that channel. Putting system_settings in the
-- realtime publication lets every client (signed in or not) react to a toggle
-- flip on its own, which is what makes enforcement feel instant.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'system_settings'
  ) then
    alter publication supabase_realtime add table public.system_settings;
  end if;
end $$;

-- Row-identity replica identity is already the default (full row on UPDATE is
-- not required here — the client refetches rather than trusting the payload).
