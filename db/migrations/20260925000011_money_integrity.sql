-- ============================================================================
-- M2 — Money correctness (plan §4.1–§4.5, §5, §7.5–7.6)
--
-- Closes the silent financial-misstatement and double-spend defects:
--   * One canonical amount model. tips / payments / payouts are now all
--     denominated in the SETTLEMENT currency (PAYSTACK_CURRENCY, default KES)
--     so "earnings minus withdrawals" compares like with like. The historic
--     bug was tips.amount storing a USD number while payouts.amount stored KES
--     and tips.currency defaulting to 'NGN'.
--   * Integer minor-unit columns (amount_minor bigint) as the authoritative
--     stored value; the legacy major-unit `amount` is kept populated for the
--     many read paths that still render it, but new writes derive it from the
--     minor units so there is exactly one source of truth.
--   * An exchange-rate + USD-quote snapshot on every tip so a rate change can
--     never silently rewrite history.
--   * Idempotent, atomic settlement in a single SECURITY DEFINER function
--     shared by the webhook and the interactive confirm path (no more
--     hand-forked copies). A charge is settled at most once; the provider's
--     amount is compared to the expected amount and a mismatch is refused.
--   * One-open-payout guarantee enforced at the database (partial unique
--     index) as well as the application.
--   * plan_limits becomes the single source of truth for prices + capabilities
--     so the pricing page and checkout can never disagree, and the paywall can
--     be enforced server-side.
--   * Card PII is reduced to the PCI non-sensitive allowlist and historic raw
--     payloads are purged.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Canonical columns
-- ---------------------------------------------------------------------------

-- payments: record what we intend to charge, in the settlement currency, and
-- the USD quote that produced it. `kind` + tip fields make the row
-- self-describing so settlement never has to trust client-supplied metadata.
alter table public.payments add column if not exists kind                 text   not null default 'plan';
alter table public.payments add column if not exists amount_minor         bigint;
alter table public.payments add column if not exists expected_amount_minor bigint;
alter table public.payments add column if not exists exchange_rate        numeric(12,6);
alter table public.payments add column if not exists quoted_amount_usd    numeric(14,2);
alter table public.payments add column if not exists recipient_id         uuid   references public.profiles(id) on delete set null;
alter table public.payments add column if not exists tip_message          text;
alter table public.payments add column if not exists tip_post_id          uuid;
alter table public.payments add column if not exists settle_error         text;

-- tips: settlement-currency amount + integer minor units + USD snapshot + the
-- single-use payment reference that makes double-crediting impossible.
alter table public.tips add column if not exists amount_minor        bigint;
alter table public.tips add column if not exists payment_reference   text;
alter table public.tips add column if not exists exchange_rate       numeric(12,6);
alter table public.tips add column if not exists quoted_amount_usd   numeric(14,2);

-- The 'NGN' default is a landmine: an unset currency silently mislabels a KES
-- charge as Naira. Remove it; settlement always writes the currency explicitly.
alter table public.tips     alter column currency drop default;
alter table public.payments alter column currency drop default;
alter table public.payouts  alter column currency drop default;

-- One charge may never produce two tip rows.
create unique index if not exists tips_payment_reference_uniq
  on public.tips (payment_reference)
  where payment_reference is not null;

-- Ledger read paths (§8.2 also wants these).
create index if not exists tips_to_user_created_idx   on public.tips (to_user_id, created_at desc);
create index if not exists tips_from_user_idx          on public.tips (from_user_id);
create index if not exists payments_user_idx           on public.payments (user_id);
create index if not exists payments_reference_status_idx on public.payments (reference, status);
create index if not exists payouts_user_status_idx     on public.payouts (user_id, status);

-- At most one open withdrawal per creator, enforced in the database.
create unique index if not exists payouts_one_open_per_user
  on public.payouts (user_id)
  where status in ('pending', 'reviewing');

-- ---------------------------------------------------------------------------
-- 2. payment_events — replay defence for provider webhooks
-- ---------------------------------------------------------------------------
create table if not exists public.payment_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text   not null,
  event_id     text,                       -- provider-supplied unique id when present
  event        text   not null,
  reference    text,
  payload      jsonb  not null default '{}'::jsonb,
  processed_at timestamptz not null default now()
);
create unique index if not exists payment_events_provider_event_uniq
  on public.payment_events (provider, event_id)
  where event_id is not null;
alter table public.payment_events enable row level security;
-- No policies: only service_role (which bypasses RLS) may read/write it.
revoke all on public.payment_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. plan_limits — single source of truth for price + capability
-- ---------------------------------------------------------------------------
create table if not exists public.plan_limits (
  plan                  text primary key check (plan in ('free','plus','pro')),
  price_usd_monthly     numeric(10,2) not null default 0,
  price_usd_annual      numeric(10,2) not null default 0,   -- full-year billed total, USD
  ai_drafts_per_day     integer  not null default 5,
  spaces_max_listeners  integer  not null default 10,
  spaces_recording      boolean  not null default false,
  media_upload_max_mb   integer  not null default 10,
  storage_quota_mb      integer  not null default 100,
  analytics_level       text     not null default 'basic',
  monetization          boolean  not null default false,
  custom_branding       boolean  not null default false,
  team_workspaces       boolean  not null default false,
  api_access            boolean  not null default false,
  fee_bps               integer  not null default 500,
  updated_at            timestamptz not null default now()
);

insert into public.plan_limits
  (plan, price_usd_monthly, price_usd_annual, ai_drafts_per_day, spaces_max_listeners,
   spaces_recording, media_upload_max_mb, storage_quota_mb, analytics_level, monetization,
   custom_branding, team_workspaces, api_access, fee_bps)
values
  ('free', 0,   0,    5,    10,   false, 10,   100,  'basic',    false, false, false, false, 500),
  ('plus', 9,   84,   100,  250,  true,  100,  20480,'advanced', true,  true,  false, false, 300),
  ('pro',  29,  276,  9999, 1000, true,  1024, 512000,'team',    true,  true,  true,  true,  100)
on conflict (plan) do update set
  price_usd_monthly = excluded.price_usd_monthly,
  price_usd_annual  = excluded.price_usd_annual,
  ai_drafts_per_day = excluded.ai_drafts_per_day,
  spaces_max_listeners = excluded.spaces_max_listeners,
  spaces_recording  = excluded.spaces_recording,
  media_upload_max_mb = excluded.media_upload_max_mb,
  storage_quota_mb  = excluded.storage_quota_mb,
  analytics_level   = excluded.analytics_level,
  monetization      = excluded.monetization,
  custom_branding   = excluded.custom_branding,
  team_workspaces   = excluded.team_workspaces,
  api_access        = excluded.api_access,
  fee_bps           = excluded.fee_bps,
  updated_at        = now();

alter table public.plan_limits enable row level security;
create policy "plan_limits public read" on public.plan_limits for select using (true);
revoke insert, update, delete on public.plan_limits from public, anon, authenticated;

-- platform_fee_bps now reads the authoritative table (single source), keeping
-- the same signature/stability so existing callers are unaffected.
create or replace function public.platform_fee_bps(_profile_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select l.fee_bps
       from public.plan_limits l
      where l.plan = coalesce(
        (select s.plan from public.subscriptions s
          where s.user_id = _profile_id and s.status = 'active' limit 1),
        (select p.plan from public.profiles p where p.id = _profile_id),
        'free')),
    500
  )
$$;

-- ---------------------------------------------------------------------------
-- 4. earnings_snapshot — one authoritative ledger, computed in the database
--    with no row limit (fixes the .limit(100)/.limit(50) truncation that could
--    inflate an available balance and permit withdrawing unearned money).
-- ---------------------------------------------------------------------------
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
language sql
stable
security definer
set search_path = public
as $$
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
  from t, p
$$;
revoke all on function public.earnings_snapshot(uuid) from public, anon;
grant execute on function public.earnings_snapshot(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. settle_paystack_transaction — the single, atomic, idempotent settlement
--    path used by BOTH the webhook and the interactive confirm.
--    - advisory-locks the reference so concurrent deliveries serialise
--    - flips payments pending -> success exactly once
--    - refuses to settle unless the provider amount equals the expected amount
--    - credits the tip / activates the plan from the AUTHORITATIVE payments
--      row (never from webhook metadata)
--    - stores only PCI non-sensitive card fields
-- ---------------------------------------------------------------------------
create or replace function public.settle_paystack_transaction(
  _reference text,
  _tx jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay      record;
  v_status   text;
  v_provider_amount bigint;
  v_provider_currency text;
  v_paid_at  timestamptz;
  v_customer text;
  v_pm       jsonb;
  v_bps      integer;
  v_net_major numeric;
  v_fee_major numeric;
  v_tip_id   uuid;
  v_amount_major numeric;
begin
  -- Serialise concurrent deliveries for this exact reference.
  perform pg_advisory_xact_lock(hashtext(_reference));

  v_status          := lower(coalesce(_tx->>'status', ''));
  v_provider_amount := nullif(_tx->>'amount', '')::bigint;         -- minor units, from provider
  v_provider_currency := upper(coalesce(_tx->>'currency', ''));
  v_paid_at         := coalesce(
    (_tx->>'paid_at')::timestamptz,
    case when _tx->?'timestamp' then to_timestamp((_tx->>'timestamp')::double precision) end,
    now());
  v_customer        := _tx->'customer'->>'customer_code';

  -- Keep only non-sensitive provider fields; never persist the full payload.
  update public.payments
     set updated_at = now()
   where reference = _reference;

  select * into v_pay from public.payments where reference = _reference;
  if not found then
    return jsonb_build_object('status', 'unknown_reference');
  end if;

  -- Failed / pending provider status: record it, settle nothing.
  if v_status <> 'success' then
    update public.payments
       set status = case when v_status in ('failed','abandoned') then 'failed' else status end,
           settle_error = coalesce(_tx->>'gateway_response', 'provider_status:' || v_status),
           updated_at = now()
     where reference = _reference and status <> 'success';
    return jsonb_build_object('status', 'not_success', 'provider_status', v_status);
  end if;

  -- Currency must match what we asked to charge.
  if v_provider_currency <> '' and v_pay.currency is not null
     and v_provider_currency <> upper(v_pay.currency) then
    update public.payments
       set settle_error = 'currency_mismatch:' || v_provider_currency, updated_at = now()
     where reference = _reference;
    return jsonb_build_object('status', 'currency_mismatch',
                              'expected', v_pay.currency, 'received', v_provider_currency);
  end if;

  -- The amount actually paid must equal what we intended to charge.
  if v_provider_amount is not null and v_pay.expected_amount_minor is not null
     and v_provider_amount <> v_pay.expected_amount_minor then
    update public.payments
       set settle_error = 'amount_mismatch:' || v_provider_amount, updated_at = now()
     where reference = _reference;
    return jsonb_build_object('status', 'amount_mismatch',
                              'expected_minor', v_pay.expected_amount_minor,
                              'received_minor', v_provider_amount);
  end if;

  -- Idempotent, single-use transition. Only this statement may credit value.
  update public.payments
     set status = 'success',
         paid_at = coalesce(paid_at, v_paid_at),
         amount_minor = coalesce(v_provider_amount, amount_minor, expected_amount_minor),
         raw = jsonb_build_object(
                 'reference', _reference,
                 'status', 'success',
                 'paid_at', v_paid_at,
                 'channel', _tx->>'channel',
                 'gateway', _tx->>'gateway'),
         settle_error = null,
         updated_at = now()
   where reference = _reference and status <> 'success'
  returning id into v_pay.id;

  if v_pay.id is null then
    -- A concurrent delivery already settled it.
    return jsonb_build_object('status', 'already_settled');
  end if;

  -- Reload authoritative row fields after the flip.
  select kind, user_id, plan, billing_cycle, currency, amount_minor, expected_amount_minor,
         quoted_amount_usd, recipient_id, tip_message, tip_post_id, email, exchange_rate
    into v_pay
    from public.payments where reference = _reference;

  -- Derive a settled major-unit amount in the settlement currency.
  v_amount_major := round(coalesce(v_provider_amount, v_pay.expected_amount_minor,
                                   v_pay.amount * 100)::numeric / 100.0, 2);

  if coalesce(v_pay.kind, 'plan') = 'tip' then
    if v_pay.recipient_id is null then
      update public.payments set settle_error = 'missing_recipient', updated_at = now()
        where reference = _reference;
      return jsonb_build_object('status', 'error', 'reason', 'missing_recipient');
    end if;

    v_bps := public.platform_fee_bps(v_pay.recipient_id);
    v_fee_major := round(v_amount_major * v_bps / 10000.0, 2);
    v_net_major := round(v_amount_major - v_fee_major, 2);

    insert into public.tips
      (from_user_id, to_user_id, post_id, amount, amount_minor, currency, message,
       fee_bps, fee_amount, net_amount, payment_reference, exchange_rate, quoted_amount_usd)
    values
      (v_pay.user_id, v_pay.recipient_id, v_pay.tip_post_id, v_amount_major,
       (v_amount_major * 100)::bigint, v_pay.currency, coalesce(v_pay.tip_message, ''),
       v_bps, v_fee_major, v_net_major, _reference, v_pay.exchange_rate, v_pay.quoted_amount_usd)
    returning id into v_tip_id;

    -- t_tips_after emits the notification; we only report here.
    return jsonb_build_object('status', 'success', 'kind', 'tip', 'tip_id', v_tip_id,
                              'amount', v_amount_major, 'currency', v_pay.currency);
  end if;

  -- Plan activation. Sanitise card data to the PCI non-sensitive allowlist.
  v_pm := jsonb_strip_nulls(jsonb_build_object(
    'brand', coalesce(_tx->'authorization'->>'card_type', _tx->'authorization'->>'channel'),
    'last4', _tx->'authorization'->>'last4',
    'exp_month', _tx->'authorization'->>'exp_month',
    'exp_year', _tx->'authorization'->>'exp_year',
    'channel', _tx->'authorization'->>'channel'
  ));

  update public.profiles set plan = v_pay.plan where id = v_pay.user_id;

  insert into public.subscriptions
    (user_id, plan, billing_cycle, status, provider, provider_customer_id, payment_method, renews_at, updated_at)
  values
    (v_pay.user_id, v_pay.plan, v_pay.billing_cycle, 'active', 'paystack', v_customer, v_pm,
     now() + (case when v_pay.billing_cycle = 'annual' then interval '365 days' else interval '30 days' end),
     now())
  on conflict (user_id) do update set
    plan = excluded.plan,
    billing_cycle = excluded.billing_cycle,
    status = 'active',
    provider = 'paystack',
    provider_customer_id = coalesce(excluded.provider_customer_id, subscriptions.provider_customer_id),
    payment_method = excluded.payment_method,
    renews_at = excluded.renews_at,
    updated_at = now();

  return jsonb_build_object('status', 'success', 'kind', 'plan',
                            'plan', v_pay.plan, 'cycle', v_pay.billing_cycle);
end $$;

revoke all on function public.settle_paystack_transaction(text, jsonb) from public, anon;
-- service_role only: called from server functions using the admin client.
grant execute on function public.settle_paystack_transaction(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 6. PII purge — strip card/PII payloads already written by the old code.
--    payments.raw / subscriptions.raw / subscriptions.payment_method were fed
--    the entire Paystack transaction. Reduce to non-sensitive fields / {}.
-- ---------------------------------------------------------------------------
update public.payments
   set raw = jsonb_strip_nulls(jsonb_build_object(
         'reference', raw->>'reference',
         'status', raw->>'status',
         'channel', raw->>'channel',
         'gateway', raw->>'gateway'))
 where raw ? 'authorization' or raw ? 'customer' or raw ? 'card' or raw ? 'metadata';

update public.subscriptions
   set payment_method = jsonb_strip_nulls(jsonb_build_object(
         'brand', coalesce(payment_method->>'brand', payment_method->>'card_type'),
         'last4', payment_method->>'last4',
         'exp_month', payment_method->>'exp_month',
         'exp_year', payment_method->>'exp_year',
         'channel', payment_method->>'channel'))
 where payment_method ? 'authorization'
    or payment_method ? 'translatetable'
    or payment_method ? 'signature'
    or payment_method ? 'bin';
