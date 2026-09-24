-- Team invitations with accept/decline via notifications; roles enforced in RLS.
alter table public.notifications add column if not exists link text;
alter table public.notifications add column if not exists action jsonb;

-- Only active members count as members (invited/declined do not).
create or replace function public.is_workspace_member(_workspace_id uuid, _profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspaces w where w.id = _workspace_id and w.owner_id = _profile_id)
      or exists (select 1 from public.workspace_members m
                 where m.workspace_id = _workspace_id and m.user_id = _profile_id and m.status = 'active')
$$;

create or replace function public.workspace_role(_workspace_id uuid, _profile_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.workspaces w where w.id = _workspace_id and w.owner_id = _profile_id) then 'Owner'
    else (select m.role from public.workspace_members m
          where m.workspace_id = _workspace_id and m.user_id = _profile_id and m.status = 'active' limit 1)
  end
$$;

-- Owners and Admins manage members; invitees can see their own invite row.
drop policy if exists "workspace members owner write" on public.workspace_members;
drop policy if exists "workspace members read" on public.workspace_members;
create policy "workspace members read" on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id, public.current_profile_id()) or user_id = public.current_profile_id());
create policy "workspace members manage insert" on public.workspace_members for insert to authenticated
  with check (public.workspace_role(workspace_id, public.current_profile_id()) in ('Owner','Admin')
              and (role <> 'Owner' or public.workspace_role(workspace_id, public.current_profile_id()) = 'Owner'));
create policy "workspace members manage update" on public.workspace_members for update to authenticated
  using (public.workspace_role(workspace_id, public.current_profile_id()) in ('Owner','Admin'))
  with check (public.workspace_role(workspace_id, public.current_profile_id()) in ('Owner','Admin') and role <> 'Owner'
              or public.workspace_role(workspace_id, public.current_profile_id()) = 'Owner');
create policy "workspace members manage delete" on public.workspace_members for delete to authenticated
  using (public.workspace_role(workspace_id, public.current_profile_id()) in ('Owner','Admin')
         or user_id = public.current_profile_id()); -- members may leave

drop policy if exists "workspaces member read" on public.workspaces;
create policy "workspaces member read" on public.workspaces for select to authenticated
  using (public.is_workspace_member(id, public.current_profile_id())
         or exists (select 1 from public.workspace_members m where m.workspace_id = id and m.user_id = public.current_profile_id()));

-- On invite: resolve invitee by email or @username, enforce seats, notify them.
create or replace function public.trg_workspace_invite() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws record; invitee uuid; used int; handle text;
begin
  if new.status <> 'invited' then return new; end if;
  select * into ws from public.workspaces where id = new.workspace_id;
  select count(*) into used from public.workspace_members where workspace_id = new.workspace_id and status in ('active','invited');
  if used >= ws.seats_total then raise exception 'All % seats are in use. Upgrade to add more teammates.', ws.seats_total; end if;
  if new.user_id is null then
    handle := lower(regexp_replace(trim(new.email), '^@', ''));
    select p.id into invitee from public.profiles p
      left join auth.users u on u.id = p.auth_user_id
      where lower(u.email) = handle or lower(p.username) = handle limit 1;
    new.user_id := invitee;
  end if;
  if exists (select 1 from public.workspace_members m where m.workspace_id = new.workspace_id
             and (m.user_id = new.user_id or lower(m.email) = lower(new.email)) and m.status in ('active','invited')) then
    raise exception 'That person is already on this team or has a pending invite.';
  end if;
  return new;
end $$;
drop trigger if exists t_workspace_invite on public.workspace_members;
create trigger t_workspace_invite before insert on public.workspace_members
  for each row execute function public.trg_workspace_invite();

create or replace function public.trg_workspace_invite_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws record;
begin
  if new.status = 'invited' and new.user_id is not null then
    select * into ws from public.workspaces where id = new.workspace_id;
    insert into public.notifications (recipient_id, actor_id, type, body, link, action)
    values (new.user_id, ws.owner_id, 'workspace_invite',
            format('invited you to join the team “%s” as %s', ws.name, new.role),
            '/settings?tab=workspace',
            jsonb_build_object('kind','workspace_invite','member_id', new.id, 'workspace_id', ws.id, 'state','pending'));
  end if;
  return new;
end $$;
drop trigger if exists t_workspace_invite_notify on public.workspace_members;
create trigger t_workspace_invite_notify after insert on public.workspace_members
  for each row execute function public.trg_workspace_invite_notify();

-- Invitee accepts or declines.
create or replace function public.respond_workspace_invite(_member_id uuid, _accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare m record; ws record; me uuid := public.current_profile_id();
begin
  select * into m from public.workspace_members where id = _member_id for update;
  if m is null or m.user_id is distinct from me then raise exception 'Invite not found'; end if;
  if m.status <> 'invited' then return m.status; end if;
  update public.workspace_members set status = case when _accept then 'active' else 'declined' end where id = _member_id;
  select * into ws from public.workspaces where id = m.workspace_id;
  update public.notifications set action = action || jsonb_build_object('state', case when _accept then 'accepted' else 'declined' end), read = true
    where recipient_id = me and action->>'member_id' = _member_id::text;
  insert into public.notifications (recipient_id, actor_id, type, body, link)
  values (ws.owner_id, me, 'workspace',
          format('%s your invite to “%s”', case when _accept then 'accepted' else 'declined' end, ws.name),
          '/settings?tab=workspace');
  return case when _accept then 'active' else 'declined' end;
end $$;
revoke execute on function public.respond_workspace_invite(uuid, boolean) from public, anon;
grant execute on function public.respond_workspace_invite(uuid, boolean) to authenticated;
