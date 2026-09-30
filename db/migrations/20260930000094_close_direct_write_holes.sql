-- ============================================================================
-- S8 — close the direct-write holes on money, notification and telemetry tables.
--
-- Found while sweeping dead exports: four client helpers used to write straight
-- through PostgREST under the viewer's own role. They are gone from the bundle
-- now, but the database still granted the door they walked through, and RLS
-- policies are the only thing standing between a signed-in token and these rows.
-- What each hole was:
--
--   * `tips` (`tips sender write`) — any signed-in user could INSERT a tip row
--     for any amount. `earnings_snapshot()` sums *every* tips row for a creator
--     (there is no status column — a row means "settled"), so one POST minted
--     withdrawable balance out of nothing. Real tips are written only by the
--     Paystack settle path (`settle_paystack_transaction`, SECURITY DEFINER,
--     owned by postgres) or the service-role client.
--   * `payouts` (`payouts owner write`) — the same shape: a forged `pending`
--     withdrawal row with an attacker-chosen amount and destination, which an
--     operator could then pay. `requestPayout` writes through the service-role
--     client after checking the snapshot balance server-side.
--   * `notifications` (`notifications insert`) — `with check (owns_profile(actor_id))`
--     still let anyone address a notification to *another* user with arbitrary
--     type/body: a forged "you received a $500 tip" is a phishing message that
--     looks native. Every legitimate notification is written by `notify()`
--     (SECURITY DEFINER) or by staff through the service-role client, so the
--     authenticated INSERT is not needed. Marking-read and deleting stay
--     allowed: those go through `notifications owner update/delete`.
--   * `post_impressions` (`impressions insert`) — `with check (user_id is null
--     or owns_profile(user_id))` plus a *partial* unique index (dedupe only
--     where user_id is not null) meant an authenticated caller could insert
--     unlimited NULL-user impressions: free view_count inflation. The ranker's
--     telemetry now flows only through `recordImpressions`, which writes with
--     the service-role client and resolves the viewer from the verified JWT.
--   * `schema_migrations` — created after the blanket schema-wide grants, so it
--     inherited SELECT/INSERT/UPDATE/DELETE for `anon` **and** had RLS off
--     (tables without row security are fully open to any role that holds
--     grants). An anonymous request could wipe or forge the migration ledger.
--
-- Also: `GRANT ALL ON TABLES IN SCHEMA public` (Supabase's default-privileges
-- setup) handed `anon`/`authenticated` TRUNCATE and REFERENCES on every table.
-- Neither can be reached through PostgREST, but neither is needed by any DML
-- path either — and TRUNCATE is the one privilege RLS does *not* gate, so it
-- would be instant total loss the moment any other SQL surface appears.
--
-- Everything here is drop-if-exists / revoke, so it is idempotent and reversible
-- by re-running the earlier grants. Reads are untouched.
-- ============================================================================

-- ---- 1. money: settled payments only --------------------------------------
drop policy if exists "tips sender write" on public.tips;
revoke insert, update, delete on public.tips from authenticated, anon;

drop policy if exists "payouts owner write" on public.payouts;
revoke insert, update, delete on public.payouts from authenticated, anon;

-- ---- 2. notifications: written by triggers/staff, never by a viewer -------
-- UPDATE and DELETE stay granted so the recipient can mark alerts read and
-- clear them; only the ability to create one is withdrawn.
drop policy if exists "notifications insert" on public.notifications;
revoke insert on public.notifications from authenticated, anon;

-- ---- 3. impressions: service-role telemetry only --------------------------
drop policy if exists "impressions insert" on public.post_impressions;
revoke insert, update, delete on public.post_impressions from authenticated, anon;

-- ---- 4. the migration ledger is not an API surface ------------------------
revoke all on public.schema_migrations from authenticated, anon;
alter table public.schema_migrations enable row level security;

-- ---- 5. privileges no DML path can use ------------------------------------
revoke truncate, references on all tables in schema public from authenticated, anon;
alter default privileges in schema public revoke truncate, references on tables from authenticated, anon;

-- ---- 6. proof the doors are shut (run by the migration runner) ------------
-- After this file, an authenticated INSERT into tips/payouts/notifications/
-- post_impressions must fail with 42501, and SELECT on schema_migrations must
-- return zero rows for `anon`.
