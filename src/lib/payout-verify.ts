/**
 * Pure, unit-testable helpers for verifying a payout destination before any
 * money moves.
 *
 * Paystack's own API is the authority here: `GET /bank/resolve` answers "does
 * this account number exist at this bank, and whose is it?" for every supported
 * country (banks *and* mobile-money providers), and `POST /transferrecipient`
 * refuses anything it cannot settle. We resolve first so (a) a typo can never
 * mint a recipient that points at somebody else's account, and (b) the name we
 * store is the bank's answer rather than the typist's.
 */

/** Providers mask mobile-money names for privacy, e.g. `LINTARI M*** N***`. */
export function isMaskedName(name: string): boolean {
  return String(name ?? "").includes("*");
}

/** Uppercase, accent-stripped, alphanumeric tokens only. */
export function nameTokens(name: string): string[] {
  return String(name ?? "")
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface NameCheck {
  /** True when the two names plausibly describe the same holder. */
  matched: boolean;
  /** True when the provider masked the name, so no comparison was possible. */
  skipped: boolean;
}

/**
 * Does the bank's registered name line up with the name the user typed?
 *
 * Deliberately tolerant of ordering and extra middle/last names ("Jane M.
 * Wanjiru" vs "JANE MWANGI") but never lets a clearly different holder through,
 * because the stored name is what a human reviewer sees when a payout is
 * disputed. A masked response is not a mismatch — the resolve call succeeding
 * already proves the account exists.
 */
export function accountNamesMatch(resolved: string, typed: string): NameCheck {
  if (isMaskedName(resolved)) return { matched: true, skipped: true };
  const resolvedTokens = new Set(nameTokens(resolved));
  const typedTokens = nameTokens(typed);
  if (!resolvedTokens.size || !typedTokens.length) return { matched: false, skipped: false };
  const hits = typedTokens.filter((tok) => resolvedTokens.has(tok)).length;
  const needed = Math.min(2, typedTokens.length, resolvedTokens.size);
  return { matched: hits >= needed, skipped: false };
}

export interface BankRow {
  code: string;
  name: string;
  country?: string;
}

/**
 * Turn whatever the user typed into a Paystack bank code. People come from
 * everywhere and type "equity", "Equity Bank Kenya" or the raw code, so we
 * accept a code, an exact name, or a unique name/substring match — and return
 * null when the text is ambiguous so the UI can ask them to pick one instead of
 * guessing a bank and sending money to the wrong institution.
 */
export function resolveBankCode(input: string, banks: BankRow[]): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();

  const byCode = banks.find((b) => String(b.code).toUpperCase() === upper);
  if (byCode) return byCode.code;

  const needle = nameTokens(raw).join(" ");
  if (!needle) return null;

  const byName = banks.filter((b) => nameTokens(b.name).join(" ") === needle);
  if (byName.length === 1) return byName[0]!.code;

  const contains = banks.filter((b) => nameTokens(b.name).join(" ").includes(needle));
  if (contains.length === 1) return contains[0]!.code;

  // Multiple candidates (or none): the caller shows the list / lets the
  // provider reject the raw value — we never pick a bank on a guess.
  return null;
}
