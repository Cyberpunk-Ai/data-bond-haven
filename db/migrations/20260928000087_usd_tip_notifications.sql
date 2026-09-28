-- ============================================================================
-- Everything the platform shows is USD. Tip notifications were the last local
-- -currency leak: t_tips_after wrote "sent you a tip of KES 13.00" from the
-- settlement-currency columns. Quote the USD figure the tip was created from
-- (tips.quoted_amount_usd), falling back to the raw amount only for rows that
-- somehow lack it (e.g. a USD-settled merchant where amount IS dollars).
-- ============================================================================

create or replace function public.t_tips_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify(new.to_user_id, new.from_user_id, 'tip',
    'sent you a tip of $' ||
    to_char(coalesce(nullif(new.quoted_amount_usd, 0), new.amount), 'FM999999990.00'));
  return null;
end $$;

-- Restate the notifications already delivered with a local-currency body so
-- in-app history matches the new USD standard. Tip inserts and their
-- notification rows share one transaction, so created_at lines up.
update public.notifications n
   set body = 'sent you a tip of $' ||
              to_char(coalesce(nullif(t.quoted_amount_usd, 0), t.amount), 'FM999999990.00')
  from public.tips t
 where n.type = 'tip'
   and n.actor_id = t.from_user_id
   and n.recipient_id = t.to_user_id
   and abs(extract(epoch from (n.created_at - t.created_at))) < 2
   and n.body not like '%$%';
