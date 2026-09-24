-- ---------- counter + notification maintenance ----------

create or replace function public.notify(_recipient uuid, _actor uuid, _type text, _body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if _recipient is null or _recipient = _actor then return; end if;
  insert into public.notifications (recipient_id, actor_id, type, body)
  values (_recipient, _actor, _type, _body);
end $$;

-- likes
create or replace function public.t_likes_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; author uuid;
begin
  pid := coalesce(new.post_id, old.post_id);
  update public.posts p set like_count = (select count(*) from public.likes l where l.post_id = pid) where p.id = pid;
  if tg_op = 'INSERT' then
    select user_id into author from public.posts where id = pid;
    perform public.notify(author, new.user_id, 'like', 'liked your post');
  end if;
  return null;
end $$;
create trigger t_likes_after after insert or delete on public.likes
for each row execute function public.t_likes_after();

-- reposts
create or replace function public.t_reposts_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; author uuid;
begin
  pid := coalesce(new.post_id, old.post_id);
  update public.posts p set repost_count = (select count(*) from public.reposts r where r.post_id = pid) where p.id = pid;
  if tg_op = 'INSERT' then
    select user_id into author from public.posts where id = pid;
    perform public.notify(author, new.user_id, 'repost', 'reposted your post');
  end if;
  return null;
end $$;
create trigger t_reposts_after after insert or delete on public.reposts
for each row execute function public.t_reposts_after();

-- comments
create or replace function public.t_comments_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; author uuid;
begin
  pid := coalesce(new.post_id, old.post_id);
  update public.posts p set comment_count = (select count(*) from public.comments c where c.post_id = pid) where p.id = pid;
  if tg_op = 'INSERT' then
    select user_id into author from public.posts where id = pid;
    perform public.notify(author, new.user_id, 'comment', 'commented on your post');
  end if;
  return null;
end $$;
create trigger t_comments_after after insert or delete on public.comments
for each row execute function public.t_comments_after();

-- impressions
create or replace function public.t_impressions_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.posts set view_count = view_count + 1 where id = new.post_id;
  return null;
end $$;
create trigger t_impressions_after after insert on public.post_impressions
for each row execute function public.t_impressions_after();

-- follows
create or replace function public.t_follows_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare f uuid; t uuid;
begin
  f := coalesce(new.follower_id, old.follower_id);
  t := coalesce(new.target_id, old.target_id);
  update public.profiles p set following = (select count(*) from public.follows x where x.follower_id = f) where p.id = f;
  update public.profiles p set followers = (select count(*) from public.follows x where x.target_id = t) where p.id = t;
  if tg_op = 'INSERT' then
    perform public.notify(t, f, 'follow', 'started following you');
  end if;
  return null;
end $$;
create trigger t_follows_after after insert or delete on public.follows
for each row execute function public.t_follows_after();

-- story likes
create or replace function public.t_story_likes_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare sid uuid; author uuid;
begin
  sid := coalesce(new.story_id, old.story_id);
  update public.stories s set likes_count = (select count(*) from public.story_likes l where l.story_id = sid) where s.id = sid;
  if tg_op = 'INSERT' then
    select user_id into author from public.stories where id = sid;
    perform public.notify(author, new.user_id, 'story_like', 'liked your story');
  end if;
  return null;
end $$;
create trigger t_story_likes_after after insert or delete on public.story_likes
for each row execute function public.t_story_likes_after();

-- messages
create or replace function public.t_messages_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare a uuid; b uuid; other uuid;
begin
  select user_a, user_b into a, b from public.conversations where id = new.conversation_id;
  update public.conversations
     set preview = left(coalesce(new.body, 'Attachment'), 140), updated_at = now()
   where id = new.conversation_id;
  other := case when new.sender_id = a then b else a end;
  perform public.notify(other, new.sender_id, 'message', 'sent you a message');
  return null;
end $$;
create trigger t_messages_after after insert on public.messages
for each row execute function public.t_messages_after();

-- tips
create or replace function public.t_tips_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify(new.to_user_id, new.from_user_id, 'tip',
    'sent you a tip of ' || new.currency || ' ' || to_char(new.amount, 'FM999999990.00'));
  return null;
end $$;
create trigger t_tips_after after insert on public.tips
for each row execute function public.t_tips_after();

-- space participants keep the listener count honest
create or replace function public.t_space_participants_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  sid := coalesce(new.space_id, old.space_id);
  update public.spaces s set listeners = (select count(*) from public.space_participants p where p.space_id = sid) where s.id = sid;
  return null;
end $$;
create trigger t_space_participants_after after insert or delete on public.space_participants
for each row execute function public.t_space_participants_after();

-- ---------- realtime streaming ----------
alter table public.notifications replica identity full;
alter table public.messages replica identity full;
alter table public.posts replica identity full;
alter table public.conversations replica identity full;
alter table public.space_messages replica identity full;

do $$
begin
  begin execute 'alter publication supabase_realtime add table public.notifications'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.messages'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.posts'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.conversations'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.space_messages'; exception when duplicate_object then null; end;
end $$;