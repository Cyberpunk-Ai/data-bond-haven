-- =============================================================================
-- Enforce the admin-configurable `rate_limit_requests_per_min` on content
-- writes. Until now the setting existed in system_settings and the admin UI
-- but nothing read it — a configured throttle that throttled nothing.
--
-- Uses the existing atomic fixed-window counter (check_rate_limit) with a
-- per-user bucket, on the two unbounded user-facing write paths: posts and
-- comments. The default (120/min) is far above any genuine human cadence, so
-- this only bites runaway clients and spam bots during a surge.
-- =============================================================================

create or replace function public.enforce_content_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lim integer;
begin
  select rate_limit_requests_per_min into lim from public.system_settings where id = 1;
  -- No settings row configured yet: never block writes on a missing limiter.
  if lim is null or lim <= 0 then
    return new;
  end if;
  if not public.check_rate_limit('content_write:' || new.user_id, lim, 60) then
    raise exception 'rate limit exceeded: too many requests, slow down'
      using errcode = 'PT429';
  end if;
  return new;
end $$;

revoke all on function public.enforce_content_rate_limit() from public, anon;

drop trigger if exists t_posts_rate_limit on public.posts;
create trigger t_posts_rate_limit
  before insert on public.posts
  for each row execute function public.enforce_content_rate_limit();

drop trigger if exists t_comments_rate_limit on public.comments;
create trigger t_comments_rate_limit
  before insert on public.comments
  for each row execute function public.enforce_content_rate_limit();
