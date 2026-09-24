-- ============ security hardening ============
-- Closes privilege-escalation, forgery, tampering and metric-inflation holes
-- found in the audit. All changes are additive / policy replacements and are
-- safe to re-run against the existing schema.

-- ---- helpers -------------------------------------------------------------

-- True when the caller may act: service role always, otherwise the caller's
-- own profile must exist and not be suspended/banned.
create or replace function public.is_active_profile()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.role() = 'service_role'
     or coalesce(
          (select p.status = 'active' from public.profiles p where p.id = public.current_profile_id()),
          false
        )
$$;

-- ---- profiles: protect privileged columns --------------------------------
-- RLS "profiles self update" lets a user update their own row, but nothing
-- stopped them setting plan='pro', verified=true, status='active' (self-unban)
-- or rewriting warning_count. Only staff / service role may change these.
create or replace function public.t_profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'service_role' or public.is_staff() then
    return new;
  end if;
  new.plan           := old.plan;
  new.verified       := old.verified;
  new.status         := old.status;
  new.warning_count  := old.warning_count;
  -- follower/following counters are maintained by their own triggers; a direct
  -- client write must not be able to inflate them.
  new.followers      := old.followers;
  new.following      := old.following;
  return new;
end $$;

drop trigger if exists t_profiles_guard on public.profiles;
create trigger t_profiles_guard before update on public.profiles
for each row execute function public.t_profiles_guard();

-- ---- messages: only the sender may edit body/media ------------------------
-- Recipients legitimately flip read_at on the other party's messages, so we
-- allow the update but pin content columns to their previous values unless the
-- caller is the sender or staff.
create or replace function public.t_messages_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'service_role' or public.is_staff() or public.owns_profile(old.sender_id) then
    return new;
  end if;
  new.body       := old.body;
  new.media_url  := old.media_url;
  new.sender_id  := old.sender_id;
  new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists t_messages_guard on public.messages;
create trigger t_messages_guard before update on public.messages
for each row execute function public.t_messages_guard();

-- ---- notifications: no forged actors -------------------------------------
-- Previously `with check (true)` let any user insert a notification with an
-- arbitrary actor_id/type/body (e.g. a fake "sent you a $500 tip").
drop policy if exists "notifications insert" on public.notifications;
create policy "notifications insert" on public.notifications for insert to authenticated
  with check (public.is_staff() or public.owns_profile(actor_id));

-- ---- posts / comments / messages: block suspended users ------------------
drop policy if exists "posts owner write" on public.posts;
create policy "posts owner write" on public.posts for insert to authenticated
  with check (public.owns_profile(user_id) and public.is_active_profile());

drop policy if exists "comments owner write" on public.comments;
create policy "comments owner write" on public.comments for insert to authenticated
  with check (public.owns_profile(user_id) and public.is_active_profile());

drop policy if exists "messages sender write" on public.messages;
create policy "messages sender write" on public.messages for insert to authenticated
  with check (
    public.owns_profile(sender_id)
    and public.is_active_profile()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (public.owns_profile(c.user_a) or public.owns_profile(c.user_b))
    )
  );

drop policy if exists "space messages self write" on public.space_messages;
create policy "space messages self write" on public.space_messages for insert to authenticated
  with check (public.owns_profile(user_id) and public.is_active_profile());

-- ---- space_participants: no self-promotion to host/speaker ---------------
drop policy if exists "space participants self write" on public.space_participants;
create policy "space participants self write" on public.space_participants for insert to authenticated
  with check (
    public.owns_profile(user_id)
    and (
      role = 'listener'
      or public.is_staff()
      or exists (select 1 from public.spaces s where s.id = space_id and public.owns_profile(s.host_id))
    )
  );

-- ---- tips / payouts: allow the owner to create their own rows ------------
-- requestTipPayout previously failed because payouts had no insert policy, and
-- sendTipApi failed because tips had no authenticated insert policy.
drop policy if exists "tips sender write" on public.tips;
create policy "tips sender write" on public.tips for insert to authenticated
  with check (public.owns_profile(from_user_id));

drop policy if exists "payouts owner write" on public.payouts;
create policy "payouts owner write" on public.payouts for insert to authenticated
  with check (public.owns_profile(user_id));

-- ---- post_impressions: stop unlimited view-count inflation ---------------
-- A per-user unique index makes repeated impressions from the same logged-in
-- user a no-op instead of incrementing view_count forever.
create unique index if not exists post_impressions_user_post_uniq
  on public.post_impressions (post_id, user_id)
  where user_id is not null;
