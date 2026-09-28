-- ============================================================================
-- Fix: settle_paystack_transaction always threw 42883
-- ("operator does not exist: jsonb ->? unknown").
--
-- The paid_at coalesce used `_tx->?'timestamp'`, but Postgres lexes `->?` as
-- ONE operator name (all of -, >, ? are legal operator characters), so every
-- call — interactive confirm AND webhook — failed before settling anything.
-- Real charges completed at the provider but never flipped to success, never
-- created the tip row, and never notified the recipient.
--
-- Byte-for-byte migration 79's definition with ONLY the v_paid_at expression
-- rewritten to nullif-cast form (no `?` operator involved).
-- ============================================================================

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
  -- FIX: was `case when _tx->?'timestamp' ...`, which Postgres parses as the
  -- nonexistent `->?` operator and aborts the whole function. to_timestamp of
  -- NULL is NULL, so a plain coalesce chain is equivalent (and safer: the
  -- paid_at cast no longer chokes on an empty string).
  v_paid_at         := coalesce(
    nullif(_tx->>'paid_at', '')::timestamptz,
    to_timestamp(nullif(_tx->>'timestamp', '')::double precision),
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
         quoted_amount_usd, recipient_id, recipient_workspace_id, tip_message, tip_post_id,
         email, exchange_rate
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

    -- Withdrawal-time fees: the tip is credited in full and the platform's
    -- take (5/3/1% by plan) is deducted when the creator cashes out.
    v_bps := 0;
    v_fee_major := 0;
    v_net_major := v_amount_major;

    insert into public.tips
      (from_user_id, to_user_id, to_workspace_id, post_id, amount, amount_minor, currency, message,
       fee_bps, fee_amount, net_amount, legacy_fee, payment_reference, exchange_rate, quoted_amount_usd)
    values
      (v_pay.user_id, v_pay.recipient_id, v_pay.recipient_workspace_id, v_pay.tip_post_id, v_amount_major,
       (v_amount_major * 100)::bigint, v_pay.currency, coalesce(v_pay.tip_message, ''),
       v_bps, v_fee_major, v_net_major, false, _reference, v_pay.exchange_rate, v_pay.quoted_amount_usd)
    returning id into v_tip_id;

    -- t_tips_after emits the notification; we only report here.
    return jsonb_build_object('status', 'success', 'kind', 'tip', 'tip_id', v_tip_id,
                              'amount', v_amount_major, 'currency', v_pay.currency,
                              'workspace', v_pay.recipient_workspace_id);
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
