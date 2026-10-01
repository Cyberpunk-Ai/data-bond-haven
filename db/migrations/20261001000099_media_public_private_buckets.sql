-- ============================================================================
-- Two media buckets instead of one: `media-public` and `media-private`.
--
-- The platform had a single private `media` bucket and let the read proxy
-- (`/api/public/media/$`) decide visibility per folder. That works, but it
-- means world-readable bytes (avatars, post images) are streamed through the
-- app on every view, and it means there is no bucket a CDN or a link-preview
-- crawler can be given safely — a public bucket domain serves the WHOLE bucket,
-- so with one bucket there was no such thing.
--
-- The split mirrors the folder map in src/lib/media-folders.server.ts:
--   media-public  ← avatars/, posts/, media/      (anybody may read)
--   media-private ← stories/, messages/, recordings/ (a reader rule must pass)
--
-- The legacy `media` bucket and its policies are left exactly as they are:
-- objects uploaded before this migration keep resolving through the proxy's
-- fallback lookup until the relocation tool (src/lib/storage/relocate.server.ts)
-- copies them into the bucket their folder belongs in. Nothing is deleted here.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

-- 100 MB per object: the app's own plan-based caps are what gate a real upload
-- (MEDIA_MAX_VIDEO_MB defaults to 100), and the legacy bucket's 50 MB ceiling
-- was smaller than the plan it was serving.
insert into storage.buckets (id, name, public, file_size_limit)
values ('media-public', 'media-public', true, 104857600)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit;

insert into storage.buckets (id, name, public, file_size_limit)
values ('media-private', 'media-private', false, 104857600)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- The storage API answers a public object URL as anon, so the read policy has to
-- exist at all. (Supabase grants this by default; stating it keeps a fresh
-- project correct without depending on platform defaults.)
grant select on storage.objects to anon, authenticated;

-- ---------------------------------------------------------------------------
-- media-public: anybody reads, only the owner (or the service role, which is
-- what the upload route uses) writes and removes.
-- ---------------------------------------------------------------------------
drop policy if exists "media_public read" on storage.objects;
create policy "media_public read" on storage.objects
for select to public using (bucket_id = 'media-public');

drop policy if exists "media_public owner upload" on storage.objects;
create policy "media_public owner upload" on storage.objects
for insert to authenticated with check (
  bucket_id = 'media-public'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

drop policy if exists "media_public owner update" on storage.objects;
create policy "media_public owner update" on storage.objects
for update to authenticated using (
  bucket_id = 'media-public'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

drop policy if exists "media_public owner delete" on storage.objects;
create policy "media_public owner delete" on storage.objects
for delete to authenticated using (
  bucket_id = 'media-public'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

-- ---------------------------------------------------------------------------
-- media-private: no anonymous read of any kind. Every verb is owner-scoped, and
-- the app's reader adds the per-folder rule on top (a DM attachment is only
-- served to a participant, a replay only to its host or staff) — the bucket
-- policy is the backstop that keeps the bytes unreadable even if a URL leaks.
-- ---------------------------------------------------------------------------
drop policy if exists "media_private read" on storage.objects;
create policy "media_private read" on storage.objects
for select to authenticated using (
  bucket_id = 'media-private'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

drop policy if exists "media_private owner upload" on storage.objects;
create policy "media_private owner upload" on storage.objects
for insert to authenticated with check (
  bucket_id = 'media-private'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

drop policy if exists "media_private owner update" on storage.objects;
create policy "media_private owner update" on storage.objects
for update to authenticated using (
  bucket_id = 'media-private'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

drop policy if exists "media_private owner delete" on storage.objects;
create policy "media_private owner delete" on storage.objects
for delete to authenticated using (
  bucket_id = 'media-private'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

-- ---------------------------------------------------------------------------
-- Posts never expire. Recorded here as a database fact, not just an absence:
-- `posts` has no expiry column, no trigger and no scheduled job removes rows,
-- and the delete policy below is the only way a row goes away — the author or a
-- moderator. (Stories keep their 24h `expires_at`; that ephemerality is the
-- product.) This re-asserts the policy so a future migration that widens it by
-- accident has to say so deliberately.
-- ---------------------------------------------------------------------------
drop policy if exists "posts owner delete" on public.posts;
create policy "posts owner delete" on public.posts
for delete to authenticated using (public.owns_profile(user_id) or public.is_staff());
