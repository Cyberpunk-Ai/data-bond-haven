-- Phase: team-workspace hardening.
-- 1. Team Workspaces are a Pro capability, but the gate so far was only a
--    client-side render decision: any authenticated user could insert a
--    `workspaces` row straight through PostgREST. Enforce it in RLS.
-- 2. The manager/preview copy sells "up to 10 team members" while the table
--    defaulted to 3 seats, so every new team silently got 3. Align to 10.
-- 3. Invite notifications deep-linked to `/settings?tab=workspace`, but the
--    settings route only parses `?section=` and the section id is
--    `workspaces` (plural) — the invite CTA landed on the Profile tab.

-- ---- 1. Pro-only workspace creation (server-side) ---------------------------
create or replace function public.is_pro_profile(_profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  -- Mirrors plan-guard.server.ts: an active pro subscription or a pro profile.
  select exists (
    select 1 from public.profiles p
    where p.id = _profile_id and p.plan = 'pro'
  ) or exists (
    select 1 from public.subscriptions s
    where s.user_id = _profile_id and s.plan = 'pro' and s.status = 'active'
  );
$$;

revoke execute on function public.is_pro_profile(uuid) from public, anon;
grant execute on function public.is_pro_profile(uuid) to authenticated, service_role;

drop policy if exists "workspaces owner write" on public.workspaces;
create policy "workspaces owner write" on public.workspaces for insert to authenticated
  with check (
    public.owns_profile(owner_id)
    and public.is_pro_profile(owner_id)
  );

-- ---- 2. Seats: Pro teams get the advertised 10 ------------------------------
alter table public.workspaces alter column seats_total set default 10;
update public.workspaces set seats_total = 10 where seats_total < 10;

-- ---- 2b. Owner-readable without self-recursion ------------------------------
-- The old SELECT policy called is_workspace_member(), which re-selects from
-- workspaces itself. Plain SELECTs survived it, but `insert(...).select()`
-- (what createWorkspace does) evaluates the SELECT policy against the
-- in-flight row via RETURNING — the self-scan then misses the brand-new row
-- and the insert fails with 42501 even though WITH CHECK passed. Express the
-- same visibility directly: owner sees their workspace, and anyone with a
-- membership row (including pending invitees) sees theirs.
drop policy if exists "workspaces member read" on public.workspaces;
create policy "workspaces member read" on public.workspaces for select to authenticated
  using (
    owner_id = public.current_profile_id()
    or exists (select 1 from public.workspace_members m where m.workspace_id = workspaces.id and m.user_id = public.current_profile_id())
  );

-- ---- 3. Repair the invite deep links ----------------------------------------
-- Rewrite the stored notification rows...
update public.notifications
  set link = '/settings?section=workspaces'
  where link = '/settings?tab=workspace';

-- ...and the two functions that mint them.
create or replace function public.trg_workspace_invite_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws record;
begin
  if new.status = 'invited' and new.user_id is not null then
    select * into ws from public.workspaces where id = new.workspace_id;
    insert into public.notifications (recipient_id, actor_id, type, body, link, action)
    values (new.user_id, ws.owner_id, 'workspace_invite',
            format('invited you to join the team “%s” as %s', ws.name, new.role),
            '/settings?section=workspaces',
            jsonb_build_object('kind','workspace_invite','member_id', new.id, 'workspace_id', ws.id, 'state','pending'));
  end if;
  return new;
end $$;

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
          '/settings?section=workspaces');
  return case when _accept then 'active' else 'declined' end;
end $$;
