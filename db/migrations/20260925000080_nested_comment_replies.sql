-- Nested replies: allow a comment to reply to another comment. The schema keeps
-- the direct parent so a reply can point at any comment, while the UI presents a
-- single level of threading (replies render flat under their top-level parent).
-- Additive and idempotent, matching the style of the other migrations.

alter table public.comments
  add column if not exists parent_id uuid references public.comments(id) on delete cascade;

create index if not exists comments_parent_idx on public.comments (parent_id);
create index if not exists comments_post_parent_idx on public.comments (post_id, parent_id);

-- Keep comment_count accurate (already recounts every row for the post, so
-- replies are included) and additionally notify the parent comment's author when
-- someone replies to them. notify() already skips self-notifications, so a reply
-- to your own comment or thread won't double-ping the post author.
create or replace function public.t_comments_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; author uuid; parent_author uuid;
begin
  pid := coalesce(new.post_id, old.post_id);
  update public.posts p set comment_count = (select count(*) from public.comments c where c.post_id = pid) where p.id = pid;
  if tg_op = 'INSERT' then
    select user_id into author from public.posts where id = pid;
    if new.parent_id is not null then
      select user_id into parent_author from public.comments where id = new.parent_id;
      perform public.notify(parent_author, new.user_id, 'reply', 'replied to your comment', pid);
    end if;
    perform public.notify(author, new.user_id, 'comment', 'commented on your post', pid);
  end if;
  return null;
end $$;
