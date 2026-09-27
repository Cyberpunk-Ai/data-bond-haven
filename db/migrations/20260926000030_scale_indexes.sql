-- =============================================================================
-- Scale indexes: cover the hot read paths that would otherwise degrade to
-- sequential scans as the userbase grows (surge readiness).
--
-- These are the lookups the "For you" ranker, feed, bookmarks, messaging,
-- Spaces and workspaces hit on almost every request; each previously relied on
-- a non-leading column (or no secondary index at all), so they became full
-- table scans under load. All are created IF NOT EXISTS so the migration is
-- idempotent and safe to re-run.
-- =============================================================================

-- Feed ranking + bookmarks list: both filter engagement tables by the VIEWER's
-- user_id, but their primary keys lead with post_id (only helps by-post lookups).
create index if not exists bookmarks_user_created_idx
  on public.bookmarks (user_id, created_at desc);
create index if not exists post_impressions_user_created_idx
  on public.post_impressions (user_id, created_at desc);
create index if not exists story_likes_user_idx
  on public.story_likes (user_id);

-- Followers / "who follows me": follows PK is (follower_id, target_id), so
-- reverse (target_id) scans — the followers counter and graph expansion.
create index if not exists follows_target_idx
  on public.follows (target_id, follower_id);

-- Messaging: a conversation belongs to two users; PK/unique only indexes
-- user_a, so listing one's DMs from the user_b side scanned the table.
create index if not exists conversations_user_b_updated_idx
  on public.conversations (user_b, updated_at desc);

-- Spaces: participant "am I in a room" checks filter by user_id; the spaces
-- directory orders recent non-recorded rooms; host rooms list by host_id.
create index if not exists space_participants_user_idx
  on public.space_participants (user_id);
create index if not exists spaces_host_idx
  on public.spaces (host_id);
create index if not exists spaces_active_created_idx
  on public.spaces (created_at desc) where recorded = false;

-- Feed / Explore: posts list is always `hidden = false` ordered newest-first;
-- a partial index keeps that scan index-only as soft-deleted rows accumulate.
create index if not exists posts_active_created_idx
  on public.posts (created_at desc) where hidden = false;

-- Workspaces: role-gated posting + the workspace switcher resolve membership
-- by user_id and list a workspace's members by workspace_id (PK is a surrogate
-- id, so neither was indexed).
create index if not exists workspace_members_user_idx
  on public.workspace_members (user_id);
create index if not exists workspace_members_ws_idx
  on public.workspace_members (workspace_id);

-- Notifications: the unread badge polls a recipient's unread rows constantly.
create index if not exists notifications_unread_idx
  on public.notifications (recipient_id, created_at desc) where read = false;
