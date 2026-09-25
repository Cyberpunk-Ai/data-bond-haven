-- ============================================================================
-- M3 — Media, storage and rate limiting (plan §4.5–§4.7, §5.1, §S11)
--
--   * media_objects: storage visibility becomes a *database fact* rather than a
--     guessing game over unguessable filenames. Every uploaded object is
--     recorded with its owner and visibility so deletion, quotas, the media
--     reader's authorization, GDPR erasure and duplicate scanning all have a
--     referent.
--   * rate_limits + check_rate_limit(): a dependency-free, atomic fixed-window
--     counter (no Redis) used to throttle uploads and, later, other hot paths.
--     Replaces the read-then-insert pattern that let a burst of parallel
--     requests all pass.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- media_objects
-- ---------------------------------------------------------------------------
create table if not exists public.media_objects (
  path             text primary key,
  owner_profile_id uuid references public.profiles(id) on delete cascade,
  folder           text not null,
  visibility       text not null default 'authed'
                     check (visibility in ('public', 'authed', 'private')),
  content_type     text not null,
  bytes            bigint not null default 0,
  sha256           text,
  created_at       timestamptz not null default now()
);

create index if not exists media_objects_owner_idx on public.media_objects (owner_profile_id);
create index if not exists media_objects_sha_idx   on public.media_objects (sha256) where sha256 is not null;
create index if not exists media_objects_created_idx on public.media_objects (created_at);

alter table public.media_objects enable row level security;
-- No per-user policies: the table is managed exclusively by server functions on
-- the service role (which bypasses RLS). Reads by owner are added when a
-- user-facing "my media" surface exists.
revoke insert, update, delete on public.media_objects from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- rate_limits — atomic fixed-window counter
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  id           bigint generated always as identity primary key,
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 1,
  created_at   timestamptz not null default now(),
  unique (bucket, window_start)
);
-- Keep the table small: old windows are pruned opportunistically.
create index if not exists rate_limits_bucket_window_idx on public.rate_limits (bucket, window_start);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated;

create or replace function public.check_rate_limit(
  _bucket text,
  _limit integer,
  _window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  window_seconds integer := greatest(1, coalesce(_window_seconds, 60));
  window_start   timestamptz;
  current_count  integer;
begin
  window_start := to_timestamp(
    floor(extract(epoch from now()) / window_seconds) * window_seconds
  );

  insert into public.rate_limits (bucket, window_start, count)
  values (_bucket, window_start, 1)
  on conflict (bucket, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into current_count;

  return current_count <= _limit;
end $$;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon;
grant execute on function public.check_rate_limit(text, integer, integer) to authenticated, service_role;

-- Opportunistic cleanup (safe to call from the same server paths).
create or replace function public.prune_rate_limits()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limits where window_start < now() - interval '1 day'
$$;
revoke all on function public.prune_rate_limits() from public, anon;
grant execute on function public.prune_rate_limits() to authenticated, service_role;
