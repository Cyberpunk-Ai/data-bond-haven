/**
 * Canonical money math (M2 — plan §4.1).
 *
 * The historic defect was that a tip was *charged* in the settlement currency
 * (KES) but *recorded* as a USD number with the currency left at its `'NGN'`
 * column default, so a "$5 tip" was stored as `amount=5, currency='NGN'`,
 * displayed as "KES 5" and withdrawn against a KES threshold. Everything here
 * exists so that computation happens in exactly one place.
 *
 * Storage model:
 *   * `minor` = integer number of the smallest unit of the settlement currency
 *     (e.g. KES cents). This is the authoritative value (`*_minor bigint`).
 *   * `major` = the same amount expressed in whole currency units, kept for the
 *     many read paths that still render `amount` directly. Always derived from
 *     `minor`, never the other way round, so there is one source of truth.
 *
 * All functions are pure and side-effect free so they can be unit-tested and
 * shared between the checkout, the webhook and the interactive confirm.
 */

/** A positive integer amount of minor units. */
export type MinorUnits = number;

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

/** Round half-up to whole minor units from a fractional (major) computation. */
export function toMinor(majorOrMinor: number): MinorUnits {
  if (!Number.isFinite(majorOrMinor)) {
    throw new Error("Money amount must be a finite number.");
  }
  const minor = Math.round(majorOrMinor);
  if (!Number.isSafeInteger(minor) || Math.abs(minor) > SAFE_MAX) {
    throw new Error("Money amount is out of the safe integer range.");
  }
  return minor;
}

/** Convert integer minor units to a 2-dp major-unit number for display/legacy. */
export function minorToMajor(minor: number): number {
  if (!Number.isFinite(minor)) throw new Error("Minor amount must be finite.");
  // Scale and round to avoid binary float drift on values like 0.1 + 0.2.
  return Math.round(minor) / 100;
}

/** A validated ISO-4217 code (we only ever use 3-letter uppercase codes). */
export function normalizeCurrency(value: string | undefined | null, fallback: string): string {
  const c = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : fallback;
}

export interface TipQuote {
  /** The USD amount the supporter chose to spend (advertising currency). */
  usd: number;
  /** USD -> settlement-currency rate (whole shillings per dollar). */
  rate: number;
}

export interface ChargedTip {
  /** Whole settlement-currency units actually charged (e.g. KES 650). */
  majorSettlement: number;
  /** Authoritative integer minor units of the settlement currency. */
  minorSettlement: MinorUnits;
  /** The USD amount, rounded to cents, as a snapshot for audit. */
  usdMinor: MinorUnits;
  rate: number;
}

/**
 * Compute the single authoritative amount for a tip, given a USD choice and a
 * settlement-currency rate. The charge is always `round(usd) whole settlement
 * units` (matching the historic UX where tips round to whole shillings), and
 * every derived figure comes from that one number.
 */
export function quoteTip({ usd, rate }: TipQuote): ChargedTip {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error("Tip amount must be a positive number.");
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Exchange rate must be a positive number.");
  }
  const majorSettlement = Math.round(usd * rate);
  return {
    majorSettlement,
    minorSettlement: toMinor(majorSettlement * 100),
    usdMinor: toMinor(Math.round(usd * 100)),
    rate,
  };
}

/** Platform fee, in bps (integer basis points), applied to a minor amount. */
export function feeFromBps(minor: MinorUnits, bps: number): MinorUnits {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error("Fee basis points must be an integer between 0 and 10000.");
  }
  return Math.round((minor * bps) / 10000);
}

export interface LedgerInput {
  /** Net minor amounts actually earned by the creator. */
  netMinor: number[];
  /** Settled (non-failed/reversed/declined) payout minor amounts already taken. */
  withdrawnMinor: number[];
}

export interface LedgerSnapshot {
  grossMinor: MinorUnits;
  withdrawnMinor: MinorUnits;
  availableMinor: MinorUnits;
}

/**
 * Reduce ledger rows to a balance. Never trust a truncated scan: callers must
 * pass complete aggregates (today that is `earnings_snapshot`, which sums in
 * SQL with no row limit). `available` is floored at zero and cannot go negative.
 */
export function reduceLedger({ netMinor, withdrawnMinor }: LedgerInput): LedgerSnapshot {
  const grossMinor = netMinor.reduce((a, b) => a + toMinor(b), 0);
  const withdrawn = withdrawnMinor.reduce((a, b) => a + toMinor(b), 0);
  return {
    grossMinor,
    withdrawnMinor: withdrawn,
    availableMinor: Math.max(0, grossMinor - withdrawn),
  };
}
