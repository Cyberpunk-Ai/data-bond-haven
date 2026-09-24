-- Signed-in users may upload/manage only their own files. Files are read back
-- through the server-side /api/public/media proxy (service role), so no anon
-- SELECT policy is needed on storage.objects.
create policy "media owner upload" on storage.objects for insert to authenticated
with check (
  bucket_id = 'media'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

create policy "media owner read" on storage.objects for select to authenticated
using (
  bucket_id = 'media'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

create policy "media owner update" on storage.objects for update to authenticated
using (
  bucket_id = 'media'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);

create policy "media owner delete" on storage.objects for delete to authenticated
using (
  bucket_id = 'media'
  and (storage.foldername(name))[2] = public.current_profile_id()::text
);