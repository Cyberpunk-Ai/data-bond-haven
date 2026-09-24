-- Phase 7: fix workspace RLS bug, add workspace profile fields, normalize roles,
-- and allow posting as a workspace for members with sufficient permission.

-- Fix a self-join typo that made every workspace visible only to nobody via membership.
drop policy if exists "workspaces member read" on public.workspaces;
create policy "workspaces member read" on public.workspaces for select to authenticated
  using (
    public.is_workspace_member(id, public.current_profile_id())
    or exists (select 1 from public.workspace_members m where m.workspace_id = workspaces.id and m.user_id = public.current_profile_id())
  );

-- Workspace profile: name/avatar/bio, editable by Owner/Admin.
alter table public.workspaces add column if not exists avatar_url text;
alter table public.workspaces add column if not exists bio text not null default '';

drop policy if exists "workspaces owner update" on public.workspaces;
create policy "workspaces owner update" on public.workspaces for update to authenticated
  using (public.workspace_role(id, public.current_profile_id()) in ('Owner','Admin'))
  with check (public.workspace_role(id, public.current_profile_id()) in ('Owner','Admin'));

-- Normalize roles to Owner/Admin/Editor/Viewer everywhere.
update public.workspace_members set role = 'Viewer' where role in ('Analyst','Contributor','member');
alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check
  check (role in ('Owner','Admin','Editor','Viewer'));

-- Post as a workspace: nullable workspace_id, permitted for Owner/Admin/Editor members.
alter table public.posts add column if not exists workspace_id uuid references public.workspaces(id) on delete set null;
create index if not exists posts_workspace_idx on public.posts (workspace_id);

drop policy if exists "posts owner write" on public.posts;
create policy "posts owner write" on public.posts for insert to authenticated
  with check (
    owns_profile(user_id) and is_active_profile()
    and (
      workspace_id is null
      or public.workspace_role(workspace_id, public.current_profile_id()) in ('Owner','Admin','Editor')
    )
  );
