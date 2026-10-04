-- ============================================================================
-- 20261004000003_call_delete_hide.sql
--
-- Lets either participant clear a finished call out of a chat thread, mirroring
-- what the message edit/delete/hide migration did for `messages`:
--   * "Remove for me"  — a per-viewer soft hide (calls.hidden_for array), so a
--     person can tidy their own thread without erasing the other side's record.
--   * "Delete for everyone" — a hard delete of the shared `calls` row, which
--     both participants may perform because the call belongs to the
--     relationship, not to one phone.
--
-- Call cards are derived from this table (never copied into `messages`), so the
-- thread simply stops rendering a row that is deleted or hidden from the reader.
--
-- Additive + idempotent: re-running this migration is safe.
-- ============================================================================

begin;

-- ---------- 1. New column --------------------------------------------------

alter table public.calls
  add column if not exists hidden_for uuid[] not null default '{}';

create index if not exists calls_hidden_for_gin
  on public.calls using gin (hidden_for);

-- ---------- 2. RLS: a participant's read excludes rows they hid ------------
-- Replaces `calls participant read` with the same membership test plus the
-- per-viewer hide, so a hidden row is invisible to the hider only. The peer's
-- history is untouched because `auth.uid()` differs.

drop policy if exists "calls participant read" on public.calls;
create policy "calls participant read" on public.calls for select to authenticated
  using (
    (public.owns_profile(caller_id) or public.owns_profile(callee_id))
    and not (hidden_for @> array[auth.uid()])
  );

-- ---------- 3. RLS: either participant may hard-delete the call ------------
-- A call is a shared event; both sides can remove it for everyone. Scoped to
-- the two people on the call, so nobody else can erase a stranger's history.

drop policy if exists "calls participant delete" on public.calls;
create policy "calls participant delete" on public.calls for delete to authenticated
  using (public.owns_profile(caller_id) or public.owns_profile(callee_id));

-- ---------- 4. SECURITY DEFINER helper to append the caller ----------------
-- PostgREST cannot call array_append from the client, so expose a tight RPC that
-- only ever appends auth.uid() and only for a call the caller actually belongs
-- to. This is the sole write path for hidden_for; the raw column is not trusted
-- from the client.

create or replace function public.hide_call_for_me(p_call_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.calls
     set hidden_for = array_append(hidden_for, auth.uid())
   where id = p_call_id
     and not (hidden_for @> array[auth.uid()])
     and (caller_id = auth.uid() or callee_id = auth.uid());
$$;

-- ---------- 5. Grants ------------------------------------------------------

grant execute on function public.hide_call_for_me(uuid) to authenticated;

commit;
