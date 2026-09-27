-- ============================================================================
-- Manual (staff-disbursed) withdrawals.
--
-- The disbursement model changes from "we push money through the provider" to
-- "the platform staff pays the creator directly and records the outcome":
--   * a creator request now parks in `pending` with a snapshot of the payout
--     account attached, so an operator can see exactly where the money goes;
--   * the raw account number is kept ONLY inside the same AES-GCM envelope the
--     recipient token already uses (never in cleartext), and is revealed to
--     staff through an audited, staff-gated read;
--   * `reviewPayout` (paid / declined) is now the only thing that moves a
--     request off `pending`. A decline is excluded by the ledger's
--     `status not in ('failed','reversed','declined')` filter, so the gross
--     amount is automatically returned to the creator's available balance.
--
-- This is additive: historical payout rows (already disbursed) are untouched.
-- ============================================================================

-- Full, encrypted payout destination captured at request time (the operator's
-- "pay this account" instruction), kept beside the row it belongs to so a later
-- edit of the creator's saved account can never rewrite an in-flight request.
alter table public.payouts add column if not exists destination_enc jsonb;

-- Masked, list-safe mirrors of the destination (no full account number) so the
-- admin queue can label a request without decrypting anything.
alter table public.payouts add column if not exists bank_name text;
alter table public.payouts add column if not exists account_last4 text;
alter table public.payouts add column if not exists account_name text;
alter table public.payouts add column if not exists account_type text;

-- Who reviewed it and when — the human trail behind a manual disbursement.
alter table public.payouts add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;
alter table public.payouts add column if not exists reviewed_at timestamptz;

-- Newest-first queue reads and the open-request guard stay cheap.
create index if not exists payouts_status_created_idx
  on public.payouts (status, created_at desc);

-- Keep the ledger honest for the new lifecycle: a `pending` request already
-- reserves its gross amount (the snapshot functions debit every non-failed /
-- non-declined row), so no ledger change is required here — declines simply
-- fall out of the withdrawn sum and the balance returns. This comment records
-- that the behaviour was verified, not overlooked.
