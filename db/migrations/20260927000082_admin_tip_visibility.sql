-- ============================================================================
-- Admin tipping visibility: aggregate stats + recent tips for the console.
--
-- The `tips` rows are participant-gated by RLS ("tips participant read" also
-- allows is_staff, but an admin browsing the overview should not need a join
-- per row). These SECURITY DEFINER functions are guarded internally with
-- is_staff() so the policy still decides who sees the numbers, and they fail
-- closed for everyone else.
-- ============================================================================

create or replace function public.admin_tip_stats()
returns table (count bigint, amount numeric, currency text)
language sql stable security definer set search_path = public as $$
  select count(*)::bigint,
         coalesce(sum(t.amount), 0),
         coalesce(
           (select currency from public.tips
             group by currency order by count(*) desc limit 1),
           'USD')
    from public.tips t
   where public.is_staff();
$$;

create or replace function public.admin_recent_tips(_limit integer default 8)
returns table (
  id uuid,
  tipper text,
  recipient text,
  amount numeric,
  currency text,
  message text,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select t.id,
         coalesce(f.display_name, f.username, 'Member'),
         coalesce(w.name, r.display_name, r.username, 'Member'),
         t.amount,
         t.currency,
         coalesce(t.message, ''),
         t.created_at
    from public.tips t
    left join public.profiles f on f.id = t.from_user_id
    left join public.profiles r on r.id = t.to_user_id
    left join public.workspaces w on w.id = t.to_workspace_id
   where public.is_staff()
   order by t.created_at desc
   limit greatest(1, least(_limit, 25));
$$;

grant execute on function public.admin_tip_stats() to authenticated;
grant execute on function public.admin_recent_tips(integer) to authenticated;
revoke all on function public.admin_tip_stats() from public;
revoke all on function public.admin_recent_tips(integer) from public;
