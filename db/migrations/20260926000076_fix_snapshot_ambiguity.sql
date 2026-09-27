-- ============================================================================
-- Fix 42702 "column reference \"net_amount\" is ambiguous" in both earnings
-- snapshots (found in launch QA: the monetization hub and the team Earnings
-- tab could never load for an owner).
--
-- Both functions return a TABLE whose OUT column names (net_amount, currency)
-- collide with the tips columns referenced inside the aggregate query. In
-- plpgsql, OUT parameters are variables, so `sum(net_amount)` and
-- `max(currency)` are ambiguous between the variable and the table column —
-- the statement throws the moment it actually runs (the non-owner zero path
-- returns earlier, which is why early checks looked clean).
--
-- Fix: qualify every colliding reference against an aliased tips table.
-- Logic is otherwise identical to 20260926000073.
-- ============================================================================

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
      coalesce(sum(tp.amount), 0)                                as gross_amount,
      coalesce(sum(tp.fee_amount), 0)                            as fees_amount,
      coalesce(sum(tp.net_amount), 0)                            as sum_net_amount,
      coalesce(sum(tp.amount_minor), 0)::bigint                  as gross_minor,
      coalesce(sum((tp.fee_amount * 100)::bigint), 0)::bigint    as fees_minor,
      coalesce(sum((tp.net_amount * 100)::bigint), 0)::bigint    as sum_net_minor,
      count(*)                                                   as tip_count,
      (max(tp.currency))                                         as tip_currency
    from public.tips tp
    where tp.to_user_id = _profile
      and tp.to_workspace_id is null
  ),
  p as (
    select
      coalesce(sum(pp.amount), 0)                            as withdrawn_amount,
      coalesce(sum((pp.amount * 100)::bigint), 0)::bigint    as withdrawn_minor
    from public.payouts pp
    where pp.user_id = _profile
      and pp.workspace_id is null
      and pp.status not in ('failed', 'reversed', 'declined')
  )
  select
    t.gross_minor,
    t.fees_minor,
    t.sum_net_minor,
    p.withdrawn_minor,
    greatest(0, t.sum_net_minor - p.withdrawn_minor)               as available_minor,
    t.gross_amount,
    t.fees_amount,
    t.sum_net_amount,
    p.withdrawn_amount,
    greatest(0, t.sum_net_amount - p.withdrawn_amount)             as available_amount,
    t.tip_count,
    coalesce(t.tip_currency, current_setting('app.payout_currency', true), 'KES')
  from t, p;
end $$;

revoke all on function public.earnings_snapshot(uuid) from public, anon;
grant execute on function public.earnings_snapshot(uuid) to authenticated, service_role;

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
      coalesce(sum(tp.amount), 0)                                as gross_amount,
      coalesce(sum(tp.fee_amount), 0)                            as fees_amount,
      coalesce(sum(tp.net_amount), 0)                            as sum_net_amount,
      coalesce(sum(tp.amount_minor), 0)::bigint                  as gross_minor,
      coalesce(sum((tp.fee_amount * 100)::bigint), 0)::bigint    as fees_minor,
      coalesce(sum((tp.net_amount * 100)::bigint), 0)::bigint    as sum_net_minor,
      count(*)                                                   as tip_count,
      (max(tp.currency))                                         as tip_currency
    from public.tips tp
    where tp.to_workspace_id = _workspace
  ),
  p as (
    select
      coalesce(sum(pp.amount), 0)                            as withdrawn_amount,
      coalesce(sum((pp.amount * 100)::bigint), 0)::bigint    as withdrawn_minor
    from public.payouts pp
    where pp.workspace_id = _workspace
      and pp.status not in ('failed', 'reversed', 'declined')
  )
  select
    t.gross_minor,
    t.fees_minor,
    t.sum_net_minor,
    p.withdrawn_minor,
    greatest(0, t.sum_net_minor - p.withdrawn_minor)               as available_minor,
    t.gross_amount,
    t.fees_amount,
    t.sum_net_amount,
    p.withdrawn_amount,
    greatest(0, t.sum_net_amount - p.withdrawn_amount)             as available_amount,
    t.tip_count,
    coalesce(t.tip_currency, current_setting('app.payout_currency', true), 'KES')
  from t, p;
end $$;

revoke all on function public.workspace_earnings_snapshot(uuid) from public, anon;
grant execute on function public.workspace_earnings_snapshot(uuid) to authenticated, service_role;
