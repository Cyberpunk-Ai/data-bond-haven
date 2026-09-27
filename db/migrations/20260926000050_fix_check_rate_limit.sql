-- =============================================================================
-- Fix check_rate_limit(): the original body declares plpgsql variables named
-- `window_start` (and uses `count` in RETURNING), which collide with the
-- rate_limits columns of the same name. Postgres raises
--   42702  column reference "window_start" is ambiguous
-- on every real call. The upload path hides this behind a fail-open catch, so
-- uploads have been silently UNTHROTTLED, and the content-write triggers added
-- in 20260926000040 made the failure user-visible (every post insert 400s).
--
-- Rewrite uses v_* variables and a table alias so nothing is ambiguous.
-- Signature is unchanged, so existing grants/policies keep working.
-- =============================================================================

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
  v_window_seconds integer := greatest(1, coalesce(_window_seconds, 60));
  v_window_start   timestamptz;
  v_count          integer;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / v_window_seconds) * v_window_seconds
  );

  insert into public.rate_limits as rl (bucket, window_start, count)
  values (_bucket, v_window_start, 1)
  on conflict (bucket, window_start)
    do update set count = rl.count + 1
  returning rl.count into v_count;

  return v_count <= _limit;
end $$;
