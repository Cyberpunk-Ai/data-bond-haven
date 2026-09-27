-- ============================================================================
-- Team workspaces get their OWN earnings ledger.
--
-- A tip left on a team post (or a team profile) now belongs to the workspace
-- entity, not the individual who posted it or its owner — so a brand/company
-- accumulates a balance a team can withdraw. This is additive: personal tips
-- (to_workspace_id is null) keep flowing into earnings_snapshot exactly as
-- before, and team tips are now EXCLUDED from every personal balance.
--
-- Money leaving the platform is also scoped: payouts gains a workspace_id so a
-- team withdrawal draws against the team balance, never a member's personal one.
-- ============================================================================

-- ---- 1. Scope columns ------------------------------------------------------
alter table public.tips
  add column if not exists to_workspace_id uuid references public.workspaces(id) on delete set null;
create index if not exists tips_workspace_idx on public.tips (to_workspace_id) where to_workspace_id is not null;

alter table public.payouts
  add column if not exists workspace_id uuid references public.workspaces(id) on delete set null;
create index if not exists payouts_workspace_status_idx on public.payouts (workspace_id, status) where workspace_id is not null;

alter table public.payments
  add column if not exists recipient_workspace_id uuid references public.workspaces(id) on delete set null;

-- ---- 2. Personal snapshot must ignore team tips ----------------------------
-- Carried forward verbatim from 20260926000064 (owner-or-staff gate) with one
-- added predicate: `and to_workspace_id is null`, so a team tip never inflates
-- the recipient's personal available balance.
create or replace function public.earnings_snapshot(_profile uuid)
returns table (
  gross_minor       bigint,
  fees_minor        bigint,
  net_minor         bigint,
  withdrawn_minor   bigint,
  available_minor   bigint,
  gross_amount      numeric,
  fees_amount       numeric,
  net_amount        numeric,
  withdrawn_amount  numeric,
  available_amount  numeric,
  tip_count         bigint,
  currency          text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if _profile is null
     or (public.current_profile_id() is distinct from _profile and not public.is_staff()) then
    return query select
      0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::bigint,
      coalesce(current_setting('app.payout_currency', true), 'KES')::text;
    return;
  end if;

  return query
  with t as (
    select
      coalesce(sum(amount), 0)                                   as gross_amount,
      coalesce(sum(fee_amount), 0)                               as fees_amount,
      coalesce(sum(net_amount), 0)                               as net_amount,
      coalesce(sum(amount_minor), 0)::bigint                     as gross_minor,
      coalesce(sum((fee_amount * 100)::bigint), 0)::bigint       as fees_minor,
      coalesce(sum((net_amount * 100)::bigint), 0)::bigint       as net_minor,
      count(*)                                                   as tip_count,
      (max(currency))                                            as currency
    from public.tips
    where to_user_id = _profile
      and to_workspace_id is null
  ),
  p as (
    select
      coalesce(sum(amount), 0)                             as withdrawn_amount,
      coalesce(sum((amount * 100)::bigint), 0)::bigint     as withdrawn_minor
    from public.payouts
    where user_id = _profile
      and workspace_id is null
      and status not in ('failed', 'reversed', 'declined')
  )
  select
    t.gross_minor,
    t.fees_minor,
    t.net_minor,
    p.withdrawn_minor,
    greatest(0, t.net_minor - p.withdrawn_minor)                 as available_minor,
    t.gross_amount,
    t.fees_amount,
    t.net_amount,
    p.withdrawn_amount,
    greatest(0, t.net_amount - p.withdrawn_amount)               as available_amount,
    t.tip_count,
    coalesce(t.currency, current_setting('app.payout_currency', true), 'KES')
  from t, p;
end $$;

revoke all on function public.earnings_snapshot(uuid) from public, anon;
grant execute on function public.earnings_snapshot(uuid) to authenticated, service_role;

-- ---- 3. Workspace snapshot — owner-or-staff only ---------------------------
-- Same shape as earnings_snapshot but aggregated over the team's tips and the
-- team's payouts. Any caller who is not the workspace Owner (or staff) gets an
-- all-zero row, mirroring the personal gate so existence never leaks.
create or replace function public.workspace_earnings_snapshot(_workspace uuid)
returns table (
  gross_minor       bigint,
  fees_minor        bigint,
  net_minor         bigint,
  withdrawn_minor   bigint,
  available_minor   bigint,
  gross_amount      numeric,
  fees_amount       numeric,
  net_amount        numeric,
  withdrawn_amount  numeric,
  available_amount  numeric,
  tip_count         bigint,
  currency          text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if _workspace is null
     or (public.workspace_role(_workspace, public.current_profile_id()) is distinct from 'Owner'
         and not public.is_staff()) then
    return query select
      0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::bigint,
      coalesce(current_setting('app.payout_currency', true), 'KES')::text;
    return;
  end if;

  return query
  with t as (
    select
      coalesce(sum(amount), 0)                                   as gross_amount,
      coalesce(sum(fee_amount), 0)                               as fees_amount,
      coalesce(sum(net_amount), 0)                               as net_amount,
      coalesce(sum(amount_minor), 0)::bigint                     as gross_minor,
      coalesce(sum((fee_amount * 100)::bigint), 0)::bigint       as fees_minor,
      coalesce(sum((net_amount * 100)::bigint), 0)::bigint       as net_minor,
      count(*)                                                   as tip_count,
      (max(currency))                                            as currency
    from public.tips
    where to_workspace_id = _workspace
  ),
  p as (
    select
      coalesce(sum(amount), 0)                             as withdrawn_amount,
      coalesce(sum((amount * 100)::bigint), 0)::bigint     as withdrawn_minor
    from public.payouts
    where workspace_id = _workspace
      and status not in ('failed', 'reversed', 'declined')
  )
  select
    t.gross_minor,
    t.fees_minor,
    t.net_minor,
    p.withdrawn_minor,
    greatest(0, t.net_minor - p.withdrawn_minor)                 as available_minor,
    t.gross_amount,
    t.fees_amount,
    t.net_amount,
    p.withdrawn_amount,
    greatest(0, t.net_amount - p.withdrawn_amount)               as available_amount,
    t.tip_count,
    coalesce(t.currency, current_setting('app.payout_currency', true), 'KES')
  from t, p;
end $$;

revoke all on function public.workspace_earnings_snapshot(uuid) from public, anon;
grant execute on function public.workspace_earnings_snapshot(uuid) to authenticated, service_role;
