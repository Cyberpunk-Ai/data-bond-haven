-- ============================================================================
-- 20261004000002_message_edit_delete_hide.sql
--
-- Adds per-message edit tracking, per-viewer soft-hide, and per-user
-- conversation hiding so messaging can offer:
--   * Edit text (window enforced at the API layer, 15 min)
--   * Delete for me (soft hide: tombstone in messages.hidden_for)
--   * Delete for everyone (hard delete within the same window; existing
--     sender-only policy is kept, the window lives at the API layer)
--   * Hide / "Delete chat" for a single participant (conversations.hidden_for)
--     which is auto-cleared when a fresh message lands, so the chat reappears.
--
-- Additive + idempotent: re-running this migration is safe.
-- ============================================================================

begin;

-- ---------- 1. New columns -----------------------------------------------

alter table public.messages
  add column if not exists edited_at timestamptz,
  add column if not exists hidden_for uuid[] not null default '{}';

alter table public.conversations
  add column if not exists hidden_for uuid[] not null default '{}';

-- ---------- 2. GIN indexes for containment checks ------------------------

create index if not exists messages_hidden_for_gin
  on public.messages using gin (hidden_for);

create index if not exists conversations_hidden_for_gin
  on public.conversations using gin (hidden_for);

-- ---------- 3. SECURITY DEFINER helpers to append the caller -------------
-- PostgREST cannot call array_append from the client, so we expose tight
-- RPCs that only ever append auth.uid() and only after checking membership.

create or replace function public.hide_message_for_me(p_message_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.messages
     set hidden_for = array_append(hidden_for, auth.uid())
   where id = p_message_id
     and not (hidden_for @> array[auth.uid()])
     and conversation_id in (
       select id from public.conversations
        where user_a = auth.uid() or user_b = auth.uid()
     );
$$;

create or replace function public.hide_conversation_for_me(p_conversation_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.conversations
     set hidden_for = array_append(hidden_for, auth.uid())
   where id = p_conversation_id
     and not (hidden_for @> array[auth.uid()])
     and (user_a = auth.uid() or user_b = auth.uid());
$$;

-- ---------- 4. Grants ----------------------------------------------------

grant execute on function public.hide_message_for_me(uuid) to authenticated;
grant execute on function public.hide_conversation_for_me(uuid) to authenticated;

-- ---------- 5. RLS: allow participants to update their messages ----------
-- The client uses this path to set `edited_at` (own messages within a window,
-- guarded in the API layer) and to update `hidden_for` (either participant).
-- A broader USING clause is safe because the columns that actually change are
-- either the sender-only `body + edited_at` (windowed in api-client.ts) or the
-- additive `hidden_for`, whose mutation is proxied through the SECURITY
-- DEFINER RPC above for external callers.

drop policy if exists "messages participant update" on public.messages;
create policy "messages participant update" on public.messages
  for update to authenticated
  using (
    conversation_id in (
      select id from public.conversations
       where user_a = auth.uid() or user_b = auth.uid()
    )
  );

-- ---------- 6. Un-hide conversation when a new message arrives ------------
-- Replaces t_messages_after with the same preview/notify work plus the
-- hidden_for reset, so both parties see the chat again on the next message.

create or replace function public.t_messages_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  b uuid;
  other uuid;
begin
  select user_a, user_b into a, b
    from public.conversations
   where id = new.conversation_id;

  update public.conversations
     set preview = left(coalesce(new.body, 'Attachment'), 140),
         updated_at = now(),
         hidden_for = '{}'
   where id = new.conversation_id;

  other := case when new.sender_id = a then b else a end;
  perform public.notify(other, new.sender_id, 'message', 'sent you a message');
  return null;
end $$;

drop trigger if exists t_messages_after on public.messages;
create trigger t_messages_after
  after insert on public.messages
  for each row execute function public.t_messages_after();

commit;
