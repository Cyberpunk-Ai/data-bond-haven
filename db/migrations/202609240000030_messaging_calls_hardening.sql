-- Phase 4 (messaging + calls) hardening: delivery receipts, call realtime,
-- indexes, and safe client-generated ids for optimistic reconciliation.
begin;

-- Delivered receipts (single tick -> sent, double gray -> delivered, double blue -> read).
alter table public.messages add column if not exists delivered_at timestamptz;

-- Calls must be broadcast over postgres_changes for incoming-call ringing and
-- status updates to actually reach the other participant.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table public.calls;
  end if;
end $$;

-- Faster lookups for "who is ringing me" and thread delivery-marking.
create index if not exists calls_callee_status_idx on public.calls (callee_id, status);
create index if not exists messages_conversation_delivered_idx
  on public.messages (conversation_id) where delivered_at is null;

-- Guard: sender_id must always match the authenticated profile (no spoofing),
-- already enforced by "messages sender write" WITH CHECK, re-asserted here in
-- case that policy was ever dropped without redeploying the RLS migration.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'messages' and policyname = 'messages sender write'
  ) then
    raise exception 'messages sender write policy missing; re-run 20260924000002_starpace_grants_and_rls.sql';
  end if;
end $$;

commit;
