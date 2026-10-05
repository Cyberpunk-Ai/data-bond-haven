-- ============================================================================
-- Fix: read receipts never persisted → Messages unread badge reset on reload
--
-- 20261004000002 rewrote the `messages participant update` row-security policy
-- to gate writes with:
--     conversation_id IN (SELECT id FROM conversations
--                         WHERE user_a = auth.uid() OR user_b = auth.uid())
-- but conversations.user_a / user_b (and messages.sender_id) hold a PROFILE id,
-- while auth.uid() is the AUTH users id (profiles.auth_user_id). Those are two
-- different id spaces, so the predicate is false for every genuine participant:
-- markThreadRead()'s `read_at` / `delivered_at` UPDATE matched ZERO rows and the
-- write was silently dropped. The badge only appeared fixed because an in-memory
-- latch cleared it for the current session; a reload re-counts straight from
-- `messages.read_at is null` and the number came right back — "resets after
-- reload / closing the window".
--
-- `messages participant read` was always correct because it resolves membership
-- through owns_profile(), which maps the auth uid to the profile. This makes the
-- UPDATE policy use the same, correct membership EXISTS. The BEFORE UPDATE
-- trigger t_messages_guard still pins body / media_url / sender_id / created_at
-- for anyone who is not the sender, so widening UPDATE back to "participant"
-- only re-enables the intended read-receipt path; message CONTENT stays writable
-- by its sender (or staff / the service role) alone.
--
-- Verified live with a rollback-only pooler probe: a correctly-impersonated
-- participant previously affected 0 rows; after this policy it flips read_at.
-- ============================================================================

drop policy if exists "messages participant update" on public.messages;

create policy "messages participant update" on public.messages
  for update to authenticated
  using (
    exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and (public.owns_profile(c.user_a) or public.owns_profile(c.user_b))
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and (public.owns_profile(c.user_a) or public.owns_profile(c.user_b))
    )
  );
