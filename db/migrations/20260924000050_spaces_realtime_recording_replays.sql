-- Phase 5: Spaces — server-side enforcement for role changes, recording state, and real replay counts.
-- Idempotent.

-- 1. Recording + replay tracking columns on spaces
alter table public.spaces
  add column if not exists is_recording boolean not null default false,
  add column if not exists recording_started_at timestamptz,
  add column if not exists recording_bytes bigint not null default 0,
  add column if not exists replay_count integer not null default 0;

-- 2. Per-listener unique replay view tracking (real counts, no fake numbers)
create table if not exists public.space_replay_views (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

alter table public.space_replay_views enable row level security;

grant select, insert on public.space_replay_views to authenticated;
grant select on public.space_replay_views to service_role;
grant insert, update, delete on public.space_replay_views to service_role;

drop policy if exists "space replay views public read" on public.space_replay_views;
create policy "space replay views public read"
  on public.space_replay_views for select
  using (true);

drop policy if exists "space replay views self write" on public.space_replay_views;
create policy "space replay views self write"
  on public.space_replay_views for insert
  to authenticated
  with check (owns_profile(user_id));

-- 3. Keep spaces.replay_count accurate whenever a unique replay view is recorded
create or replace function public.t_space_replay_view_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.spaces
    set replay_count = (select count(*) from public.space_replay_views where space_id = new.space_id)
    where id = new.space_id;
  return new;
end;
$$;

drop trigger if exists t_space_replay_view_after on public.space_replay_views;
create trigger t_space_replay_view_after
  after insert on public.space_replay_views
  for each row execute function public.t_space_replay_view_after();

-- 4. Enforce that only the host (or staff) can change a participant's role or force-mute
--    someone else. Listeners may still update their own hand/mute/speaking state, and may
--    self-demote from speaker to listener, but cannot promote themselves.
create or replace function public.t_space_participants_role_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_host boolean;
begin
  select exists(
    select 1 from public.spaces s
    where s.id = new.space_id and owns_profile(s.host_id)
  ) into is_host;

  if is_host or is_staff() then
    return new;
  end if;

  -- Non-host actors: only allowed to touch their own row.
  if not owns_profile(new.user_id) then
    raise exception 'Only the host can manage other participants';
  end if;

  -- Non-host actors cannot promote themselves or anyone into speaker/host.
  if new.role is distinct from old.role and new.role <> 'listener' then
    raise exception 'Only the host can invite someone to speak';
  end if;

  -- Non-host actors cannot force-unmute a role change they don't own beyond their own mic state.
  return new;
end;
$$;

drop trigger if exists t_space_participants_role_guard on public.space_participants;
create trigger t_space_participants_role_guard
  before update on public.space_participants
  for each row execute function public.t_space_participants_role_guard();
