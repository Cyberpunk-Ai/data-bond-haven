-- ============================================================================
-- Two-factor authentication — storage for a second sign-in factor
--
-- The Settings screen used to show a "Two-factor authentication" switch that
-- could not be turned on: nothing behind it existed. The UI is going away until
-- the enrolment flow is built, and this migration lays the part that must be
-- true before that flow can be honest:
--
--   * one durable place for a shared TOTP secret, its status, and the
--     single-use recovery codes that stand in for a lost phone;
--   * a failure budget, so an attacker hammering six-digit codes is stopped by
--     the database rather than by whatever the app remembers;
--   * no client access at all.
--
-- The secret is a credential in the same sense a password hash is, so this
-- table is deliberately *not* readable through PostgREST: RLS is enabled with
-- no policies and every client grant is revoked. Only the service role (the
-- server functions in `src/lib/two-factor.functions.ts`) can touch it. A future
-- sign-in screen will ask the server to verify a code; it will never hold the
-- secret.
--
-- `status` is 'pending' from the moment a secret is issued until the user
-- proves they can actually produce a code from it. An unconfirmed factor is not
-- protection, and treating it as such would let a half-finished setup lock
-- somebody out.
--
-- Re-runnable: every statement is idempotent.
-- ============================================================================

create table if not exists public.second_factors (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  kind text not null default 'totp',
  -- base32 shared secret (RFC 4648); never handed to a browser.
  secret text not null,
  status text not null default 'pending',
  -- sha256 digests of the recovery codes, as a JSON array of hex strings.
  recovery_hashes jsonb not null default '[]'::jsonb,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  last_used_at timestamptz,
  constraint second_factors_kind_check check (kind in ('totp')),
  constraint second_factors_status_check check (status in ('pending', 'active', 'disabled')),
  constraint second_factors_attempts_check check (failed_attempts >= 0)
);

create index if not exists second_factors_status_idx on public.second_factors (status);

alter table public.second_factors enable row level security;

-- No policies above this line on purpose: with RLS enabled and none defined, an
-- authenticated session reads zero rows however it asks.
revoke all on public.second_factors from public, anon, authenticated;
grant all on public.second_factors to service_role;

-- The sign-in gate will need one atomic question — "is this factor satisfied?" —
-- without shipping secrets to the caller that asks. This returns a boolean and
-- nothing else, so even a service-role leak of the function surface cannot read
-- a secret out of it.
create or replace function public.second_factor_is_required(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.second_factors
     where user_id = p_user_id
       and status = 'active'
       and verified_at is not null
  );
$$;

revoke all on function public.second_factor_is_required(uuid) from public, anon;
grant execute on function public.second_factor_is_required(uuid) to authenticated, service_role;
