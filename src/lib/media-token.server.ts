import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, path-bound media access tokens.
 *
 * Why: private objects (`recordings/`, `messages/`) are served by a proxy that
 * authorizes the caller from the `Authorization: Bearer` header. Browsers
 * cannot attach that header to an `<audio>`, `<video>` or `<img>` subresource
 * load, so every native media element pointed at a private object 404s - which
 * is exactly how Space replays and DM attachments were failing. The reader
 * therefore also accepts `?mt=<token>`, minted here only after the same ACL the
 * proxy enforces (see `media-authz.server.ts`) has passed.
 *
 * A token grants read access to exactly one object path for one profile for a
 * bounded time; it is an HMAC over (version, path, profile, expiry), so it
 * cannot be replayed against another path or a longer lifetime.
 */

const VERSION = "v1";
/** Long enough for a full replay listen, short enough to bound a leaked URL. */
export const MEDIA_TOKEN_TTL_SECONDS = 30 * 60;

function signingKey(): string | null {
  const configured = process.env["MEDIA_TOKEN_SECRET"]?.trim();
  if (configured) return configured;
  // Derive from a value that is already a server-only secret, so the feature
  // works without a second env var. Rotating either one revokes all tokens.
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"]?.trim();
  return serviceKey || null;
}

function signature(path: string, profileId: string, expiresAt: number, key: string): string {
  return createHmac("sha256", key)
    .update(`${VERSION}|${path}|${profileId}|${expiresAt}`)
    .digest("base64url");
}

/** Mint a token for one (path, profile) pair. Throws if no signing key exists. */
export function issueMediaToken(
  path: string,
  profileId: string,
  ttlSeconds = MEDIA_TOKEN_TTL_SECONDS,
): { token: string; expiresAt: number } {
  const key = signingKey();
  if (!key) {
    throw new Error("Media access tokens are not configured (set MEDIA_TOKEN_SECRET).");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(30, Math.floor(ttlSeconds));
  return {
    token: `${VERSION}.${expiresAt}.${profileId}.${signature(path, profileId, expiresAt, key)}`,
    expiresAt: expiresAt * 1000,
  };
}

/** Return the profile the token was minted for, or null when it is not valid. */
export function verifyMediaToken(path: string, token: string | null): string | null {
  const key = signingKey();
  if (!key || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [_, rawExpiry, profileId, provided] = parts;
  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) {
    return null;
  }
  const expected = signature(path, profileId, expiresAt, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return profileId;
}
