-- ============================================================================
-- Security: close a financial data leak in earnings_snapshot().
--
-- earnings_snapshot(_profile) is SECURITY DEFINER (so it can read tips/payouts
-- past their owner-only RLS) and was granted to `authenticated` with an
-- arbitrary `_profile` argument and NO ownership check. Any signed-in user could
-- therefore call the RPC with another user's profile id and read that person's
-- gross / net / withdrawn / available earnings.
--
-- The only legitimate caller is the `getEarnings` server function, which runs
-- the RPC under the *requesting user's own* JWT (context.supabase), so gating on
-- current_profile_id() preserves that path while blocking enumeration. Staff
-- keep access via is_staff(); service_role (which has no profile) is unaffected
-- because it bypasses the grant list and is not `authenticated`.
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
  -- Owner-or-staff only. Anyone else gets an all-zero row (never an error, so
  -- the UI degrades gracefully rather than leaking existence).
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
  ),
  p as (
    select
      coalesce(sum(amount), 0)                             as withdrawn_amount,
      coalesce(sum((amount * 100)::bigint), 0)::bigint     as withdrawn_minor
    from public.payouts
    where user_id = _profile
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
