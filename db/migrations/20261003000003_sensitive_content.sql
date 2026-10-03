-- ============================================================================
-- Privacy — "Filter sensitive content" gets something real to filter
--
-- The switch in Settings > Privacy had no effect because the platform had no
-- notion of sensitive media: nothing marked it, so nothing could blur it. This
-- adds the missing piece — a community-earned flag on the post, with the staff
-- member who moderates it holding the final word.
--
--   * `posts.is_sensitive` is the reader-facing fact. It defaults to false, so
--     every existing post is unchanged until someone earns the flag.
--   * `posts.sensitive_source` records who decided it: 'community' (three
--     separate people reported the post as "Inappropriate or sensitive media")
--     or 'staff'. A staff decision — in either direction — is not silently
--     re-flagged by the next batch of reports, so moderation actually sticks.
--   * `public.moderate_post_sensitivity()` is the override the admin console
--     will call. It checks `is_staff()` inside the function, so the decision
--     cannot be made by the person whose post is being flagged.
--
-- Three distinct reporters is the threshold: one angry person cannot blur a
-- post, and a genuinely shocking image does not wait for a committee.
--
-- The reading side is a preference (`prefs.toggles.filter_sensitive`, default
-- off) applied in the feed, never a hide: the post stays visible to everybody,
-- which keeps this a reader control rather than a censor's.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

alter table public.posts
  add column if not exists is_sensitive boolean not null default false;

alter table public.posts
  add column if not exists sensitive_source text;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'posts_sensitive_source_check'
       and conrelid = 'public.posts'::regclass
  ) then
    alter table public.posts drop constraint posts_sensitive_source_check;
  end if;
end $$;

alter table public.posts
  add constraint posts_sensitive_source_check
  check (sensitive_source is null or sensitive_source in ('community', 'staff'));

create index if not exists posts_sensitive_idx on public.posts (is_sensitive)
  where is_sensitive;

-- ---------- community flagging, straight from the reports queue ----------
create or replace function public.t_reports_sensitive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post    uuid;
  v_voices  integer;
begin
  if new.target_type is distinct from 'post'
     or new.reason is distinct from 'inappropriate' then
    return null;
  end if;

  -- `reports.target_id` is text: only a well-formed uuid can be a post.
  if new.target_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_post := new.target_id::uuid;

  -- Already flagged, or a staff member has settled it: nothing to add.
  if not exists (
    select 1 from public.posts
     where id = v_post and not is_sensitive and sensitive_source is distinct from 'staff'
  ) then
    return null;
  end if;

  select count(distinct reporter_id) into v_voices
    from public.reports
   where target_type = 'post'
     and target_id = v_post::text
     and reason = 'inappropriate';

  if v_voices >= 3 then
    update public.posts
       set is_sensitive = true, sensitive_source = 'community'
     where id = v_post;
  end if;

  return null;
end $$;

drop trigger if exists reports_sensitive_flag on public.reports;
create trigger reports_sensitive_flag
  after insert on public.reports
  for each row execute function public.t_reports_sensitive();

revoke all on function public.t_reports_sensitive() from public, anon;
grant execute on function public.t_reports_sensitive() to authenticated, service_role;

-- ---------- the staff override ----------
create or replace function public.moderate_post_sensitivity(
  p_post_id uuid,
  p_sensitive boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  if not public.is_staff() then
    raise exception 'NOT_STAFF' using errcode = '42501';
  end if;

  update public.posts
     set is_sensitive = p_sensitive,
         sensitive_source = case when p_sensitive then 'staff' else null end
   where id = p_post_id;
  get diagnostics v_updated = row_count;

  return v_updated > 0;
end $$;

revoke all on function public.moderate_post_sensitivity(uuid, boolean) from public, anon;
grant execute on function public.moderate_post_sensitivity(uuid, boolean)
  to authenticated, service_role;
