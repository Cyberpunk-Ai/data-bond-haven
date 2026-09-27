-- ============================================================================
-- USD ledger (global platform).
--
-- Supporters are quoted in USD everywhere (plans, tips, balances, withdrawals),
-- but Paystack clears this integration in the settlement currency
-- (PAYSTACK_CURRENCY, currently KES) — a USD `transaction/initialize` is
-- rejected with 403 "Currency not supported by merchant" until a USD account is
-- added in the Paystack dashboard. So the *charge* stays local while the
-- *ledger* becomes readable in dollars:
--
--   * every tip row already stores the per-row `exchange_rate` and
--     `quoted_amount_usd` (migrations 11 + 74), so USD is exact for anything
--     tipped from now on;
--   * the earnings snapshots gain USD rollups, dividing each row by ITS OWN
--     rate and falling back to the `_usd_rate` parameter (passed from the
--     server env) for legacy rows that predate rate capture;
--   * payouts record the USD amount plus the rate used, so a withdrawal is
--     auditable in both currencies.
--
-- Amounts in the settlement currency are kept untouched — transfers must still
-- be sent in the currency the recipient's bank/mobile-money wallet holds.
-- ============================================================================

-- 1. Payouts: remember the dollar figure and the rate behind it.
alter table public.payouts add column if not exists amount_usd    numeric(14,2);
alter table public.payouts add column if not exists exchange_rate numeric(12,6);

-- Legacy rows: convert with the rate snapshot if we have one, otherwise with
-- the configured default (approximation, clearly flagged by the null rate).
update public.payouts
   set amount_usd = round(amount / coalesce(nullif(exchange_rate, 0), 130), 2)
 where amount_usd is null;

-- ---------------------------------------------------------------------------
-- 2. Personal ledger. Signature changes (adds _usd_rate), so the old 1-arg
--    overload is dropped to keep the rpc call unambiguous.
-- ---------------------------------------------------------------------------
drop function if exists public.earnings_snapshot(uuid);

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
    greatest(0, t.sum_net_minor - p.withdrawn_minor)               as available_minor,
    t.gross_amount,
    t.fees_amount,
    t.sum_net_amount,
    p.withdrawn_amount,
    greatest(0, t.sum_net_amount - p.withdrawn_amount)             as available_amount,
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

-- ---------------------------------------------------------------------------
-- 3. Team ledger — same maths, gated on the workspace Owner (or staff).
-- ---------------------------------------------------------------------------
drop function if exists public.workspace_earnings_snapshot(uuid);

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
    greatest(0, t.sum_net_minor - p.withdrawn_minor)               as available_minor,
    t.gross_amount,
    t.fees_amount,
    t.sum_net_amount,
    p.withdrawn_amount,
    greatest(0, t.sum_net_amount - p.withdrawn_amount)             as available_amount,
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

-- ---------------------------------------------------------------------------
-- 4. Team reposts (the Reposts tab on a team profile). A repost can now carry
--    the team the actor was posting as; `user_id` stays NOT NULL as the
--    "performed by" audit column, and the RLS policy below requires the actor
--    to be an active member of that team.
--
--    Uniqueness: one row per (post, person) for personal reposts, one row per
--    (post, team) for team reposts — so a team reposts a post at most once no
--    matter how many members press the button, while a person may still repost
--    something both as themselves and as their team.
-- ---------------------------------------------------------------------------
alter table public.reposts add column if not exists workspace_id uuid
  references public.workspaces(id) on delete cascade;

-- The old primary key (post_id, user_id) would forbid "same person, two
-- identities", so it becomes two partial unique indexes instead. (Plain
-- insert/delete is used on this table — never an upsert conflict target, which
-- partial indexes cannot serve — see the 42P10 lesson from migration 77.)
alter table public.reposts drop constraint if exists reposts_pkey;

create unique index if not exists reposts_post_user_uniq
  on public.reposts (post_id, user_id)
  where workspace_id is null;

create unique index if not exists reposts_post_workspace_uniq
  on public.reposts (post_id, workspace_id)
  where workspace_id is not null;

create index if not exists reposts_workspace_created_idx
  on public.reposts (workspace_id, created_at desc);
drop policy if exists "reposts owner write" on public.reposts;
create policy "reposts owner write" on public.reposts
  for insert to authenticated
  with check (
    public.owns_profile(user_id) and (
      workspace_id is null
      or public.workspace_role(workspace_id, public.current_profile_id()) in ('Owner', 'Admin', 'Editor')
    )
  );

drop policy if exists "reposts owner delete" on public.reposts;
create policy "reposts owner delete" on public.reposts
  for delete to authenticated
  using (
    public.owns_profile(user_id)
    -- A later member may undo the team's repost (the team, not the person, owns it).
    or (
      workspace_id is not null
      and public.workspace_role(workspace_id, public.current_profile_id()) in ('Owner', 'Admin')
    )
  );
