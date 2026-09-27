-- ============================================================================
-- Ledger maths for withdrawal-time fees (migration 79).
--
-- A withdrawal now debits the GROSS request (amount_usd in USD; the net
-- transfer plus the platform fee in settlement units), because `amount` only
-- stores what actually left the account to the bank. Without this, the fee
-- portion of every withdrawal would silently stay withdrawable.
--
-- Both snapshot functions are redeployed verbatim from migration 78's final
-- text with the payouts CTE switched to the gross debit. Legacy payout rows
-- have fee_usd 0 (backfilled in 79), so nothing moves for historical data.
-- ============================================================================

create or replace function public.earnings_snapshot(_profile uuid, _usd_rate numeric default 130)
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
  gross_usd         numeric,
  fees_usd          numeric,
  net_usd           numeric,
  withdrawn_usd     numeric,
  available_usd     numeric,
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
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::bigint,
      coalesce(current_setting('app.payout_currency', true), 'KES')::text;
    return;
  end if;

  return query
  with r as (
    -- Guard against a misconfigured (null / zero / negative) rate parameter.
    select case when coalesce(_usd_rate, 0) > 0 then _usd_rate else 130 end as usd_rate
  ),
  t as (
    select
      coalesce(sum(tp.amount), 0)                                as gross_amount,
      coalesce(sum(tp.fee_amount), 0)                            as fees_amount,
      coalesce(sum(tp.net_amount), 0)                            as sum_net_amount,
      coalesce(sum(tp.amount_minor), 0)::bigint                  as gross_minor,
      coalesce(sum((tp.fee_amount * 100)::bigint), 0)::bigint    as fees_minor,
      coalesce(sum((tp.net_amount * 100)::bigint), 0)::bigint    as sum_net_minor,
      count(*)                                                   as tip_count,
      (max(tp.currency))                                         as tip_currency,
      -- Per-row rate keeps historical FX correct; rows without one use today's.
      round(coalesce(sum(tp.amount     / coalesce(nullif(tp.exchange_rate, 0), r.usd_rate)), 0), 2) as sum_gross_usd,
      round(coalesce(sum(tp.fee_amount / coalesce(nullif(tp.exchange_rate, 0), r.usd_rate)), 0), 2) as sum_fees_usd,
      round(coalesce(sum(tp.net_amount / coalesce(nullif(tp.exchange_rate, 0), r.usd_rate)), 0), 2) as sum_net_usd
    from public.tips tp, r
    where tp.to_user_id = _profile
      and tp.to_workspace_id is null
  ),
  p as (
    select
      coalesce(sum(pp.amount), 0)                            as withdrawn_amount,
      coalesce(sum((pp.amount * 100)::bigint), 0)::bigint    as withdrawn_minor,
      -- Debit the GROSS request: net transfer + platform fee (fee_usd x the
      -- row's own rate converts it back into settlement units).
      coalesce(sum(pp.amount + coalesce(pp.fee_usd, 0) * coalesce(nullif(pp.exchange_rate, 0), 130)), 0) as withdrawn_gross_amount,
      (coalesce(sum((pp.amount + coalesce(pp.fee_usd, 0) * coalesce(nullif(pp.exchange_rate, 0), 130)) * 100), 0))::bigint as withdrawn_gross_minor,
      round(coalesce(sum(coalesce(
        pp.amount_usd,
        pp.amount / coalesce(nullif(pp.exchange_rate, 0), r.usd_rate)
      )), 0), 2)                                             as sum_withdrawn_usd
    from public.payouts pp, r
    where pp.user_id = _profile
      and pp.workspace_id is null
      and pp.status not in ('failed', 'reversed', 'declined')
  )
  select
    t.gross_minor,
    t.fees_minor,
    t.sum_net_minor,
    p.withdrawn_minor,
    greatest(0, t.sum_net_minor - p.withdrawn_gross_minor)    as available_minor,
    t.gross_amount,
    t.fees_amount,
    t.sum_net_amount,
    p.withdrawn_amount,
    greatest(0, t.sum_net_amount - p.withdrawn_gross_amount)  as available_amount,
    t.sum_gross_usd,
    t.sum_fees_usd,
    t.sum_net_usd,
    p.sum_withdrawn_usd,
    greatest(0, t.sum_net_usd - p.sum_withdrawn_usd)               as available_usd,
    t.tip_count,
    coalesce(t.tip_currency, current_setting('app.payout_currency', true), 'KES')
  from t, p;
end $$;

revoke all on function public.earnings_snapshot(uuid, numeric) from public, anon;
grant execute on function public.earnings_snapshot(uuid, numeric) to authenticated, service_role;

create or replace function public.workspace_earnings_snapshot(_workspace uuid, _usd_rate numeric default 130)
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
  gross_usd         numeric,
  fees_usd          numeric,
  net_usd           numeric,
  withdrawn_usd     numeric,
  available_usd     numeric,
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
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::bigint,
      coalesce(current_setting('app.payout_currency', true), 'KES')::text;
    return;
  end if;

  return query
  with r as (
    select case when coalesce(_usd_rate, 0) > 0 then _usd_rate else 130 end as usd_rate
  ),
  t as (
    select
      coalesce(sum(tp.amount), 0)                                as gross_amount,
      coalesce(sum(tp.fee_amount), 0)                            as fees_amount,
      coalesce(sum(tp.net_amount), 0)                            as sum_net_amount,
      coalesce(sum(tp.amount_minor), 0)::bigint                  as gross_minor,
      coalesce(sum((tp.fee_amount * 100)::bigint), 0)::bigint    as fees_minor,
      coalesce(sum((tp.net_amount * 100)::bigint), 0)::bigint    as sum_net_minor,
      count(*)                                                   as tip_count,
      (max(tp.currency))                                         as tip_currency,
      round(coalesce(sum(tp.amount     / coalesce(nullif(tp.exchange_rate, 0), r.usd_rate)), 0), 2) as sum_gross_usd,
      round(coalesce(sum(tp.fee_amount / coalesce(nullif(tp.exchange_rate, 0), r.usd_rate)), 0), 2) as sum_fees_usd,
      round(coalesce(sum(tp.net_amount / coalesce(nullif(tp.exchange_rate, 0), r.usd_rate)), 0), 2) as sum_net_usd
    from public.tips tp, r
    where tp.to_workspace_id = _workspace
  ),
  p as (
    select
      coalesce(sum(pp.amount), 0)                            as withdrawn_amount,
      coalesce(sum((pp.amount * 100)::bigint), 0)::bigint    as withdrawn_minor,
      coalesce(sum(pp.amount + coalesce(pp.fee_usd, 0) * coalesce(nullif(pp.exchange_rate, 0), 130)), 0) as withdrawn_gross_amount,
      (coalesce(sum((pp.amount + coalesce(pp.fee_usd, 0) * coalesce(nullif(pp.exchange_rate, 0), 130)) * 100), 0))::bigint as withdrawn_gross_minor,
      round(coalesce(sum(coalesce(
        pp.amount_usd,
        pp.amount / coalesce(nullif(pp.exchange_rate, 0), r.usd_rate)
      )), 0), 2)                                             as sum_withdrawn_usd
    from public.payouts pp, r
    where pp.workspace_id = _workspace
      and pp.status not in ('failed', 'reversed', 'declined')
  )
  select
    t.gross_minor,
    t.fees_minor,
    t.sum_net_minor,
    p.withdrawn_minor,
    greatest(0, t.sum_net_minor - p.withdrawn_gross_minor)    as available_minor,
    t.gross_amount,
    t.fees_amount,
    t.sum_net_amount,
    p.withdrawn_amount,
    greatest(0, t.sum_net_amount - p.withdrawn_gross_amount)  as available_amount,
    t.sum_gross_usd,
    t.sum_fees_usd,
    t.sum_net_usd,
    p.sum_withdrawn_usd,
    greatest(0, t.sum_net_usd - p.sum_withdrawn_usd)               as available_usd,
    t.tip_count,
    coalesce(t.tip_currency, current_setting('app.payout_currency', true), 'KES')
  from t, p;
end $$;

revoke all on function public.workspace_earnings_snapshot(uuid, numeric) from public, anon;
grant execute on function public.workspace_earnings_snapshot(uuid, numeric) to authenticated, service_role;
