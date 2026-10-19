/**
 * A cheap, synchronous "this device has a session" routing hint.
 *
 * Supabase keeps the real session in localStorage, which the server can never
 * see — so on a fresh page load `/` could only ever stream the marketing page
 * and bounce a signed-in visitor to `/feed` after hydration (the flash we're
 * killing). This cookie is the one signal both sides can read *before* the
 * first paint: the `/` route's server loader redirects on it, and the landing
 * component seeds its first render from it.
 *
 * It is a HINT, not an authorisation decision. It carries no token and grants
 * nothing; `/feed` still verifies the real Supabase session on its own. If it
 * ever disagrees with the truth (e.g. a session ended outside the app), the
 * landing page reconciles it the moment the real auth state resolves, and a
 * signed-out visitor with a stale hint simply lands on `/feed` and is bounced
 * to `/auth`. `SameSite=Lax` is deliberate: the hint must ride top-level
 * navigations so the server sees it on an ordinary page open.
 */

const SIGNED_IN_COOKIE = "spaces.signed_in";
// Refreshed on every authenticated load, so an active user never lets it lapse.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function writeCookie(value: string, maxAgeSeconds: number) {
  if (typeof document === "undefined") return;
  document.cookie = `${SIGNED_IN_COOKIE}=${value}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

/** Remember that this device signed in. Safe to call repeatedly. */
export function setSignedInHint(): void {
  writeCookie("1", MAX_AGE_SECONDS);
}

/** Forget the hint — on sign-out, or when a provisional hint proves stale. */
export function clearSignedInHint(): void {
  writeCookie("", 0);
}

/** Synchronous client-side read of the hint, before React paints anything. */
export function peekSignedInHint(): boolean {
  if (typeof document === "undefined") return false;
  return hasSignedInHintCookie(document.cookie);
}

/** Server-side read from a raw `Cookie:` header, for the `/` route loader. */
export function signedInFromCookieHeader(header: string | null | undefined): boolean {
  return hasSignedInHintCookie(header ?? "");
}

function hasSignedInHintCookie(cookieHeader: string): boolean {
  return new RegExp(`(?:^|;\\s*)${SIGNED_IN_COOKIE}=1(?:;|$)`).test(cookieHeader.trim());
}
