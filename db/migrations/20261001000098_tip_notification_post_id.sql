-- ============================================================================
-- Tip notifications never carried the post they were sent on, so clicking a
-- "sent you a tip" row could only open the tips hub — even when the tip came
-- from a specific post (tips.post_id is set by the tip flow and by tip
-- settlement). Stamp it on the notification like likes/comments/reposts
-- already do, so the in-app click can open the post itself.
-- ============================================================================

create or replace function public.t_tips_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify(new.to_user_id, new.from_user_id, 'tip',
    'sent you a tip of $' ||
    to_char(coalesce(nullif(new.quoted_amount_usd, 0), new.amount), 'FM999999990.00'),
    new.post_id);
  return null;
end $$;

-- Backfill delivered tip notifications. The tip insert and its notification
-- row share one transaction (same now()) and the recipient/actor pair, so
-- matching on those three plus a non-null post cannot cross-link rows.
update public.notifications n
   set post_id = t.post_id
  from public.tips t
 where n.type = 'tip'
   and n.post_id is null
   and t.post_id is not null
   and n.recipient_id = t.to_user_id
   and n.actor_id = t.from_user_id
   and n.created_at = t.created_at;
