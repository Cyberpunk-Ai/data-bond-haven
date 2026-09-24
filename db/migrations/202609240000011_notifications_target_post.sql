-- Add a target post reference to notifications so clicking a like/comment/
-- repost/mention notification can open the actual post instead of only the
-- actor's profile. Idempotent and additive.

alter table public.notifications
  add column if not exists post_id uuid references public.posts(id) on delete set null;

create index if not exists notifications_post_idx on public.notifications (post_id);

-- Extend notify() to optionally carry a post id.
create or replace function public.notify(_recipient uuid, _actor uuid, _type text, _body text, _post_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if _recipient is null or _recipient = _actor then return; end if;
  insert into public.notifications (recipient_id, actor_id, type, body, post_id)
  values (_recipient, _actor, _type, _body, _post_id);
end $$;

-- Re-point the like/repost/comment triggers to pass the post id along.
create or replace function public.t_likes_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; author uuid;
begin
  pid := coalesce(new.post_id, old.post_id);
  update public.posts p set like_count = (select count(*) from public.likes l where l.post_id = pid) where p.id = pid;
  if tg_op = 'INSERT' then
    select user_id into author from public.posts where id = pid;
    perform public.notify(author, new.user_id, 'like', 'liked your post', pid);
  end if;
  return null;
end $$;

create or replace function public.t_reposts_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; author uuid;
begin
  pid := coalesce(new.post_id, old.post_id);
  update public.posts p set repost_count = (select count(*) from public.reposts r where r.post_id = pid) where p.id = pid;
  if tg_op = 'INSERT' then
    select user_id into author from public.posts where id = pid;
    perform public.notify(author, new.user_id, 'repost', 'reposted your post', pid);
  end if;
  return null;
end $$;

create or replace function public.t_comments_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; author uuid;
begin
  pid := coalesce(new.post_id, old.post_id);
  update public.posts p set comment_count = (select count(*) from public.comments c where c.post_id = pid) where p.id = pid;
  if tg_op = 'INSERT' then
    select user_id into author from public.posts where id = pid;
    perform public.notify(author, new.user_id, 'comment', 'commented on your post', pid);
  end if;
  return null;
end $$;

-- Also enable realtime + full row identity for the tables that were only
-- broadcast client-side before, so DB-level listeners (and any future
-- consumer) get the true source of truth as well.
alter table public.comments replica identity full;
alter table public.likes replica identity full;
alter table public.reposts replica identity full;

do $$
begin
  begin execute 'alter publication supabase_realtime add table public.comments'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.likes'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.reposts'; exception when duplicate_object then null; end;
end $$;
