-- Grant admin to the platform owner email on signup (and backfill if already registered).
create or replace function public.grant_owner_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) = 'n.e.x.t.g.e.n.t.e.c.h.1.67@gmail.com' then
    insert into public.user_roles(user_id, role) values (new.id, 'admin') on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists trg_grant_owner_admin on auth.users;
create trigger trg_grant_owner_admin after insert or update of email on auth.users
for each row execute function public.grant_owner_admin();

insert into public.user_roles(user_id, role)
select id, 'admin' from auth.users where lower(email) = 'n.e.x.t.g.e.n.t.e.c.h.1.67@gmail.com'
on conflict do nothing;
