/**
 * Checkout attempts are rate limited.
 *
 * Every `start*Checkout` call costs us a Paystack `/transaction/initialize` and
 * a `pending` row in `payments` that only leaves when the supporter pays, the
 * reference dies, or staff clean it up. Nothing bounded how many a single
 * account could mint, so a script (or an impatient person hammering "Tip")
 * could fill the table with unpaid intentions — and `listPaymentActivity` shows
 * those rows to staff as if they were money in motion.
 *
 * Ten a minute is far more than a real checkout needs: one click opens the
 * hosted page, and returning to the app starts a fresh reference anyway.
 */
import { checkRateLimit } from "@/lib/identity.server";

export const CHECKOUT_RATE_LIMIT = 10;
export const CHECKOUT_RATE_WINDOW_SECONDS = 60;

/**
 * Throw unless this account may open another checkout of `scope`.
 *
 * `scope` separates plan upgrades from tips so a supporter buying Plus and then
 * tipping cannot exhaust one another's budget; both are per profile so the two
 * UUIDs that identify a user (auth uid vs profile id) stay consistent with the
 * rest of the money path.
 */
export async function assertCheckoutAllowed(scope: "plan" | "tip", profileId: string) {
  const allowed = await checkRateLimit(
    `checkout:${scope}:${profileId}`,
    CHECKOUT_RATE_LIMIT,
    CHECKOUT_RATE_WINDOW_SECONDS,
  );
  if (!allowed) {
    throw new Error("You've started too many checkouts. Please wait a minute and try again.");
  }
}
