-- Comment editing: stamp an edited_at marker and let owners (and staff, to
-- mirror the existing "comments owner delete" policy) UPDATE their comments.
-- A table-level `grant update ... to authenticated` already ships in
-- 20260924000002; only the row policy and the column were missing.

alter table public.comments add column if not exists edited_at timestamptz;

create index if not exists comments_post_created_idx on public.comments (post_id, created_at);

drop policy if exists "comments owner update" on public.comments;
create policy "comments owner update" on public.comments
for update to authenticated
using (public.owns_profile(user_id) or public.is_staff())
with check (public.owns_profile(user_id) or public.is_staff());
