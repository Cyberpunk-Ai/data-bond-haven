-- =============================================================================
-- Recorded-Space replays: keep the audio in the provisioned media store.
--
-- A replay must be a proxy path served by /api/public/media/$, which is where
-- the host/participant/staff ACL for `recordings/` lives. Two bad shapes were
-- possible in the data:
--
--   1. `recorded = true` with no `recording_url` - a "Listen Replay" entry that
--      opens an empty room (three seed rooms were in exactly this state).
--   2. `recording_url` holding an inline `data:audio/webm;base64,...` blob -
--      one legacy row was. That bypasses the media proxy entirely (nothing to
--      authorize against), ships megabytes of base64 through every spaces list
--      query, and can never be garbage collected by media_objects.
--
-- The app already prevents both on write: the upload endpoint refuses
-- `data:` bodies, SpaceRoomModal treats an uploadMedia data-URL fallback as a
-- failure, and the Recorded tab requires `recorded && recording_url`. This
-- makes the database enforce it too, so an older bundle, a hand-crafted REST
-- call or a seed can never reintroduce it.
-- =============================================================================

-- 1. Normalise existing rows.
update public.spaces
   set recording_url = null
 where recording_url is not null
   and recording_url not like '/api/public/media/%';

update public.spaces
   set recorded = false
 where recorded
   and recording_url is null;

-- 2. Enforce the shape from here on.
alter table public.spaces drop constraint if exists spaces_recording_url_is_media_path;
alter table public.spaces
  add constraint spaces_recording_url_is_media_path
  check (recording_url is null or recording_url like '/api/public/media/%');

alter table public.spaces drop constraint if exists spaces_recorded_needs_url;
alter table public.spaces
  add constraint spaces_recorded_needs_url
  check (not recorded or recording_url is not null);
