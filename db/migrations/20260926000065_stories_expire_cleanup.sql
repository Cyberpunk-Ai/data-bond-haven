-- ============================================================================
-- Stories expire after 24 hours.
--
-- `expires_at` already defaults to now() + 24h and createStory sets it, but
-- reads were not filtering server-side and expired rows were never removed.
-- This makes expiry authoritative in the database:
--   * backfill any row missing an expiry so it can never live forever
--   * (the read filter lives in api-client.getStories; deletion in cron/stories-gc)
-- ============================================================================

-- Any legacy/test row without an explicit expiry gets created_at + 24h.
update public.stories
   set expires_at = created_at + interval '24 hours'
 where expires_at is null;

-- Guarantee the column always carries a value going forward.
alter table public.stories alter column expires_at set not null;
alter table public.stories alter column expires_at set default (now() + interval '24 hours');

-- Ensure the expiry scan index exists (idempotent).
create index if not exists stories_expires_idx on public.stories (expires_at);
