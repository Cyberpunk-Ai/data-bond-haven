-- ============================================================================
-- Privacy — "Allow message requests" becomes a real setting
--
-- The Settings > Privacy switch of that name has existed for a while and saved a
-- value that nothing read, which is worse than an absent switch: it promised a
-- boundary that a stranger could walk straight through. This makes the stored
-- preference true at the database, so it holds however the message was written.
--
-- The rule, in the order it is decided:
--
--   1. Nothing changes for anyone who has not turned the switch off. The
--      preference is read as *default allow* — an absent row, absent prefs
--      document, or an absent key all mean "requests are welcome".
--   2. A closed window still accepts somebody the recipient follows. Following
--      someone is an invitation; it would be strange to have to also ask them
--      not to reply.
--   3. A closed window still accepts anybody the recipient has already written
--      to inside this conversation. A thread the recipient started is not a
--      request, and the reply must never be refused.
--   4. Everything else is refused with a stable token (MESSAGE_REQUESTS_CLOSED)
--      that the client turns into a sentence.
--
-- Enforcement lives here rather than in `sendMessage()` for the same reason the
-- Spaces capacity guard does: a direct PostgREST write must not be able to
-- bypass it.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

create or replace function public.enforce_message_requests()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation public.conversations%rowtype;
  v_recipient    uuid;
  v_allow        text;
begin
  select * into v_conversation from public.conversations where id = new.conversation_id;
  if not found then
    return new;
  end if;

  -- Two-party thread: whoever the sender is not.
  v_recipient := case when new.sender_id = v_conversation.user_a then v_conversation.user_b
                      else v_conversation.user_a end;

  -- Writing to yourself, or a thread that has no second person: nothing to gate.
  if v_recipient is null or v_recipient = new.sender_id then
    return new;
  end if;

  -- The recipient's own switch. Missing anywhere in the chain means allow, so
  -- this trigger is a no-op for the overwhelming majority of accounts.
  select (up.prefs -> 'toggles' ->> 'allow_message_requests')
    into v_allow
    from public.user_preferences up
   where up.user_id = v_recipient;

  if v_allow is distinct from 'false' then
    return new;
  end if;

  -- They follow the sender: the sender is already inside their circle.
  if exists (
    select 1 from public.follows
     where follower_id = v_recipient and target_id = new.sender_id
  ) then
    return new;
  end if;

  -- The recipient has already spoken in this thread: it is a conversation, not
  -- a request, and it must keep working after the switch goes off.
  if exists (
    select 1 from public.messages m
     where m.conversation_id = new.conversation_id
       and m.sender_id = v_recipient
  ) then
    return new;
  end if;

  raise exception 'MESSAGE_REQUESTS_CLOSED' using errcode = 'P0001';
end $$;

drop trigger if exists messages_request_guard on public.messages;
create trigger messages_request_guard
  before insert on public.messages
  for each row execute function public.enforce_message_requests();

revoke all on function public.enforce_message_requests() from public, anon;
grant execute on function public.enforce_message_requests() to authenticated, service_role;
