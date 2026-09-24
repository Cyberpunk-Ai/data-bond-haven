drop policy if exists "stories public read" on public.stories;
create policy "stories graph read" on public.stories
for select
using (
  is_staff()
  or owns_profile(user_id)
  or (
    expires_at > now()
    and (
      exists (select 1 from public.follows f where f.follower_id = current_profile_id() and f.target_id = stories.user_id)
      or exists (select 1 from public.follows f where f.follower_id = stories.user_id and f.target_id = current_profile_id())
    )
  )
);

create or replace function public.platform_fee_bps(_profile_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case coalesce(
      (select s.plan from public.subscriptions s
        where s.user_id = _profile_id and s.status = 'active' limit 1),
      (select p.plan from public.profiles p where p.id = _profile_id),
      'free')
    when 'pro' then 100
    when 'plus' then 300
    else 500
  end
$$;

alter table public.tips add column if not exists fee_bps integer not null default 500;
alter table public.tips add column if not exists fee_amount numeric(12,2) not null default 0;
alter table public.tips add column if not exists net_amount numeric(12,2) not null default 0;

alter table public.payouts add column if not exists fee_bps integer not null default 0;
alter table public.payouts add column if not exists fee_amount numeric(12,2) not null default 0;
alter table public.payouts add column if not exists gross_amount numeric(12,2);

create or replace function public.apply_tip_fee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bps integer;
begin
  bps := public.platform_fee_bps(new.to_user_id);
  new.fee_bps := bps;
  new.fee_amount := round(coalesce(new.amount, 0) * bps / 10000.0, 2);
  new.net_amount := round(coalesce(new.amount, 0) - new.fee_amount, 2);
  return new;
end;
$$;

drop trigger if exists trg_apply_tip_fee on public.tips;
create trigger trg_apply_tip_fee before insert or update of amount, to_user_id
on public.tips for each row execute function public.apply_tip_fee();

update public.tips t
set fee_bps = public.platform_fee_bps(t.to_user_id),
    fee_amount = round(t.amount * public.platform_fee_bps(t.to_user_id) / 10000.0, 2),
    net_amount = round(t.amount - round(t.amount * public.platform_fee_bps(t.to_user_id) / 10000.0, 2), 2)
where net_amount = 0;

grant execute on function public.platform_fee_bps(uuid) to authenticated, anon, service_role;