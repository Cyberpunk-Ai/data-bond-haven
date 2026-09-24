-- Adds edited-post tracking and supporting indexes for the ranker & profile tabs.
begin;

alter table public.posts add column if not exists edited_at timestamptz;

-- Speeds up per-author engagement/velocity lookups used by the recommendation ranker.
create index if not exists posts_user_created_idx on public.posts (user_id, created_at desc);

-- Speeds up "liked by me" / "reposted by me" profile tabs (join posts -> likes/reposts by user).
create index if not exists likes_user_post_idx on public.likes (user_id, post_id);
create index if not exists comments_user_post_idx on public.comments (user_id, post_id);
create index if not exists reposts_user_created_idx on public.reposts (user_id, created_at desc);

grant select, insert, update, delete on public.posts to authenticated;
grant select on public.posts to service_role;

commit;
