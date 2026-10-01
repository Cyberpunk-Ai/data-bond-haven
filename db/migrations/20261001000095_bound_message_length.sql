-- ============================================================================
-- Bound a direct message's body in the database.
--
-- `messages.body` is plain `text` and the insert policy ("messages sender
-- write", 20260926000006) only asks whether the caller is the sender and a
-- participant of the conversation. Nothing anywhere bounded the length, so one
-- signed-in token could insert a multi-megabyte body through PostgREST directly:
-- it is stored, pulled by the recipient's inbox query on every page, held in the
-- feed cache and rendered inside a chat bubble. The client now refuses it in the
-- composer and in `sendMessage` (src/lib/message-length.ts), but a client rule is
-- a UX choice — this constraint is the boundary.
--
-- Every other write path in the app already has one: a post is rejected above
-- 5000 characters by post-edit.functions.ts, and in-call chat above 500 by
-- call-media.ts. Direct messages were the only unbounded text a user could write.
--
-- `NOT VALID` is deliberate. A plain `ADD CONSTRAINT … CHECK` re-reads the whole
-- table, so a single legacy over-long message (there is no length rule today, so
-- one may exist) would fail the migration and block every later file behind it.
-- NOT VALID leaves existing rows alone and enforces the limit on new and updated
-- rows, which is the behaviour we are actually claiming. Postgres validates the
-- constraint normally on any later `ALTER TABLE … VALIDATE CONSTRAINT` if an
-- operator ever wants to close the legacy window.
--
-- Idempotent: re-running drops the previous version of the constraint first.
-- ============================================================================

alter table public.messages
  drop constraint if exists "messages_body_length";

alter table public.messages
  add constraint messages_body_length
  check (char_length(body) <= 4000)
  not valid;

-- Space chat had the same hole: `space_messages.body` is unbounded text and the
-- write policy only checks ownership of the author row.
alter table public.space_messages
  drop constraint if exists "space_messages_body_length";

alter table public.space_messages
  add constraint space_messages_body_length
  check (char_length(body) <= 2000)
  not valid;
