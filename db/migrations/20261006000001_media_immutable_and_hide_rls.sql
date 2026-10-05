-- ============================================================================
-- Uploaded bytes are immutable; inbox hide is a policy, not a query string.
--
-- Two unrelated 400s / leaks this closes:
--
--   1. `hidden_for=not.cs.<bare-uuid>` -> Bad Request. The browser filtered
--      `hidden_for` server-side with `.not("hidden_for", "cs", [userId])`,
--      but supabase-js stringifies a JS array with `String([...])`, which for
--      a single element yields the bare uuid — no `{...}` wrapper. PostgREST
--      rejected the value as an invalid array literal, so every conversations
--      and messages list read fired a 400 first, then fell through to the
--      schema-cache fallback (unfiltered) and relied on a client-side
--      `.filter(...)` to drop hidden rows. That "works", but the console
--      error is real and the extra round-trip is paid on every inbox open.
--
--      Fix: move the exclusion into the SELECT policy for `conversations` and
--      `messages` — mirroring what `calls participant read` has done since
--      20261004000003. The client's `hidden_for` filter disappears entirely.
--
--   2. Owner-scoped DELETE / UPDATE policies on storage.objects let the
--      client (or a compromised bundle) erase the bytes behind any URL they
--      uploaded. Deleting a post/story/message/recording also fired an
--      opportunistic `deleteMyMedia` reclaim from api-client.ts — which
--      means a URL that a message or embed referenced five years ago can
--      silently 404 today. Uploaded bytes must be immutable once they exist;
--      only the service role (server-side moderation / relocation) touches
--      them, and no user-facing code path is allowed to.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

-- ---------- 1. Inbox hide: RLS, not a query parameter ----------------------

-- `conversations.hidden_for` stores AUTH uids (the SECURITY DEFINER helper in
-- 20261004000002 appends `auth.uid()`). Membership is profile-scoped, so the
-- policy ANDs the two checks: a reader must be a participant AND must not
-- have hidden the thread.
drop policy if exists "conversations participant read" on public.conversations;
create policy "conversations participant read" on public.conversations
  for select to authenticated
  using (
    (public.owns_profile(user_a) or public.owns_profile(user_b))
    and not (hidden_for @> array[auth.uid()])
  );

-- A per-message tombstone (either party chose "delete for me") hides the row
-- from that hider only. And a message inside a thread the viewer hid must be
-- invisible to them too, until a fresh message lands and the `t_messages_after`
-- trigger clears the conversation's `hidden_for` list. Both clauses live in
-- the single USING below — Postgres does not support `alter policy ... and`,
-- so a drop + recreate is the correct idempotent form.
drop policy if exists "messages participant read" on public.messages;
create policy "messages participant read" on public.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and (public.owns_profile(c.user_a) or public.owns_profile(c.user_b))
         and not (c.hidden_for @> array[auth.uid()])
    )
    and not (hidden_for @> array[auth.uid()])
  );

-- ---------- 2. Storage immutability: authenticated loses erase / rewrite ---

-- Legacy single-bucket policies (from 20260924000003_media_bucket_policies.sql).
drop policy if exists "media owner delete" on storage.objects;
drop policy if exists "media owner update" on storage.objects;

-- Split buckets (from 20261001000099_media_public_private_buckets.sql).
drop policy if exists "media_public owner delete" on storage.objects;
drop policy if exists "media_public owner update" on storage.objects;
drop policy if exists "media_private owner delete" on storage.objects;
drop policy if exists "media_private owner update" on storage.objects;

-- Reads (`media_public read`, `media_private read`, `media owner read`) and
-- inserts (`* owner upload`) stay exactly as they were. A user can still
-- read their own bytes and keep uploading new ones; they simply cannot
-- destroy what already exists. The service role (used by the admin-only
-- storage adapter in src/lib/storage/supabase.server.ts) bypasses RLS and
-- can still delete for moderation, and there is no code path in the app
-- that calls it.

-- ---------- 3. No scheduled expiry, no cascade -----------------------------
-- Recorded here so a future migration has to contradict it on purpose:
-- nothing in this schema removes a row from `storage.objects`, and none of
-- `posts`, `messages`, `stories`, `spaces` or their triggers do. Supabase's
-- own bucket lifecycle has no rule set on either bucket. Uploaded bytes
-- survive as long as the project does.
--
-- The `media_objects` ledger table is also left alone: rows describe an
-- object's ownership but are not consulted on read, so a client that
-- deletes one only erases the audit trail — not the bytes.
