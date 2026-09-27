-- Phase: Google OAuth readiness.
-- Simulated a gotrue-style Google signup (raw_user_meta_data from Google's
-- OIDC claims) and found handle_new_user() missing the two keys Google
-- actually sends: it has `name` (no `full_name`) and `picture` (gotrue
-- usually normalizes it to `avatar_url`, but not guaranteed across versions).
-- Result: display_name degraded to the sanitized email local-part and the
-- Google photo could be dropped. Widen the coalesce chains; behavior for
-- email/password signups is unchanged (those keys are absent there).

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare base text; candidate text; n integer := 0;
begin
  base := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1), 'user'), '[^a-z0-9_]', '', 'g'));
  if base = '' then base := 'user'; end if;
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1; candidate := base || n::text;
  end loop;
  insert into public.profiles (auth_user_id, username, display_name, avatar_url)
  values (new.id, candidate,
          coalesce(
            nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
            nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
            nullif(trim(new.raw_user_meta_data->>'name'), ''),          -- Google/OIDC
            candidate),
          coalesce(
            nullif(new.raw_user_meta_data->>'avatar_url', ''),
            nullif(new.raw_user_meta_data->>'picture', '')));           -- Google raw claim
  insert into public.user_roles (user_id, role) values (new.id, 'user') on conflict do nothing;
  return new;
end $$;
