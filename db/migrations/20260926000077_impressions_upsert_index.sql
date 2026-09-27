-- 77: make post_impressions (post_id, user_id) upsertable through PostgREST.
--
-- The launch-QA pass saw repeated 409s on POST /post_impressions: the client
-- inserts a row per viewport impression and leans on the unique index to make
-- a repeat view a no-op. That works, but every scroll-past costs a rejected
-- round-trip. The app now upserts with `ignore-duplicates`, which PostgREST
-- can only resolve against a FULL unique index — the previous index was
-- partial (`where user_id is not null`), so upsert failed with 42P10.
--
-- A plain unique index keeps identical semantics for signed-in users, while
-- anonymous impressions (user_id IS NULL) still stay distinct from each other
-- because NULLs never collide in a Postgres unique index.

create unique index if not exists post_impressions_post_user_uniq
  on public.post_impressions (post_id, user_id);

-- Subsumed by the full unique index above.
drop index if exists public.post_impressions_user_post_uniq;
