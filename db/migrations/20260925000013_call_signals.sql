-- ============================================================================
-- M4 — Durable call signalling (plan §9)
--
-- 1:1 calls were "broken outright": the caller broadcast its WebRTC offer over
-- a realtime channel before the callee had subscribed, and with
-- `broadcast: { self: false }` and no queue the offer was simply lost — the call
-- never connected. Broadcast is great for latency but is fire-and-forget.
--
-- This adds a small durable mailbox, `call_signals`, that the two participants
-- write their offer/answer (and ICE restarts) into. Each side does an
-- initial-fetch on mount and then subscribes to `postgres_changes`, so a signal
-- that arrives before the peer is listening is replayed rather than dropped.
-- The realtime broadcast path is kept for low-latency delivery — the table is
-- the durability guarantee, not the only transport.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

create table if not exists public.call_signals (
  id           bigint generated always as identity primary key,
  call_id      uuid not null references public.calls(id) on delete cascade,
  -- Stamped by trigger from the writer's own session, never supplied by the
  -- client, so a participant can't forge a signal as the other party.
  from_profile uuid references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('offer', 'answer', 'ice')),
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);

-- Ordered replay: peers read signals in insertion order.
create index if not exists call_signals_call_order_idx
  on public.call_signals (call_id, id);

-- Prune the mailbox when its call row goes away (already cascade; this keeps
-- the table bounded by also aging out signals for finished calls).
create index if not exists call_signals_created_idx
  on public.call_signals (created_at);

alter table public.call_signals enable row level security;

-- Writer stamping trigger.
create or replace function public.stamp_call_signal_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.from_profile := public.current_profile_id();
  return new;
end $$;

drop trigger if exists trg_stamp_call_signal_sender on public.call_signals;
create trigger trg_stamp_call_signal_sender
  before insert on public.call_signals
  for each row execute function public.stamp_call_signal_sender();

-- RLS: only the two participants of the owning call may read or write. Mirrors
-- the `call-signal-%` broadcast policy in 20260925000009.
drop policy if exists "call_signals participant read" on public.call_signals;
create policy "call_signals participant read" on public.call_signals
  for select to authenticated
  using (exists (
    select 1 from public.calls c
    where c.id = call_signals.call_id
      and (c.caller_id = public.current_profile_id() or c.callee_id = public.current_profile_id())
  ));

drop policy if exists "call_signals participant write" on public.call_signals;
create policy "call_signals participant write" on public.call_signals
  for insert to authenticated
  with check (
    from_profile = public.current_profile_id()
    and exists (
      select 1 from public.calls c
      where c.id = call_signals.call_id
        and (c.caller_id = public.current_profile_id() or c.callee_id = public.current_profile_id())
    )
  );

-- No update/delete policies: the mailbox is append-only and cleaned by cascade.
revoke update, delete on public.call_signals from public, anon, authenticated;

-- Expose inserts to the realtime `postgres_changes` stream (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'call_signals'
  ) then
    alter publication supabase_realtime add table public.call_signals;
  end if;
end $$;
