/**
 * Reading a `plan_limits` number without inventing one when it is missing.
 *
 * `plan_limits` is the row the pricing page, checkout and every server guard
 * read, and an operator can change it from the console. Two enforcement points
 * used to answer "I can't confirm this limit" by quietly making one up — a 5%
 * withdrawal fee and a hard-coded AI quota copied out of `plans.ts` — which
 * means a money decision was being made by a fallback instead of by
 * configuration. Both now refuse, so the caller sees an error rather than a
 * wrong number.
 *
 * Pure and dependency-free: it can be imported from a `*.functions.ts` file (or
 * straight into a unit test) without pulling in any server module.
 */

/**
 * Coerce a stored value to a usable number, or `null` when it is not one.
 *
 * The `null` cases matter more than they look: `Number(null)`, `Number(undefined)`
 * and `Number("")` are all `0`, and a withdrawal fee or AI quota that quietly
 * reads as zero is a wrong number, not a missing one. Booleans and objects are
 * refused for the same reason.
 */
function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * A withdrawal take rate in basis points (0–10000 = 0–100%). Anything outside
 * that range is a broken configuration row, not a licence to charge the default.
 */
export function feeBpsOrThrow(value: unknown, plan: string): number {
  const bps = toFiniteNumber(value);
  if (bps === null || bps < 0 || bps > 10_000) {
    throw new Error(
      `We couldn't confirm the withdrawal fee for the ${plan} plan. Please try again in a moment.`,
    );
  }
  return Math.round(bps);
}

/**
 * AI generations allowed per day. `0` is a real answer — the plan includes none
 * — so it must not be treated as "unknown, allow everything" the way a falsy
 * check would.
 */
export function aiDailyLimitOrThrow(value: unknown): number {
  const limit = toFiniteNumber(value);
  if (limit === null || !Number.isInteger(limit) || limit < 0) {
    throw new Error("We couldn't confirm your AI drafting limit. Please try again in a moment.");
  }
  return limit;
}
