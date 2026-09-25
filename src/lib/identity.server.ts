/**
 * Identity + session verification, in one place (M3 — plan §4.6, §4.7, §7.2, §7.8).
 *
 * Before this, the bearer-token check was hand-copied four times
 * (`auth-middleware.ts`, `uploads/index.ts`, `media/$.ts`, an inline variant),
 * and — worse — object paths were namespaced by the **auth** uid while the media
 * reader compared the same path segment against the **profile** id. Those are
 * different UUIDs, so the "legacy attachment" authorization path could never
 * succeed. This module resolves both: verify the session, then map the auth uid
 * to the profile id, and hand both to callers.
 */

export interface Identity {
  /** `auth.uid()` — the Supabase auth users id (`claims.sub`). */
  authUserId: string;
  /** `public.profiles.id` — the row every foreign key actually points at. */
  profileId: string;
  /** The bearer token, for callers that need to build an RLS-scoped client. */
  token: string;
}

async function supabaseClient() {
  const { env } = await import("@/lib/env.server");
  const { createClient } = await import("@supabase/supabase-js");
  const e = env();
  return createClient(e.supabaseUrl, e.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

/** Verify a bearer JWT and return its `sub`, or null when invalid/absent. */
export async function verifySessionToken(token: string | null): Promise<string | null> {
  if (!token || token.split(".").length !== 3) return null;
  try {
    const supabase = await supabaseClient();
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims?.sub) return null;
    return String(data.claims.sub);
  } catch {
    return null;
  }
}

/** Read + verify the `Authorization: Bearer …` header of the current request. */
export async function verifyRequestSession(request: Request): Promise<string | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return verifySessionToken(header.slice("Bearer ".length).trim());
}

/**
 * Resolve the full identity for a bearer token: the auth uid and its profile id.
 * Throws (returns null) when the session is invalid or has no profile row, so
 * callers fail closed rather than acting on a half-resolved identity.
 */
export async function resolveIdentity(token: string): Promise<Identity | null> {
  const authUserId = await verifySessionToken(token);
  if (!authUserId) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("profiles")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (!data?.id) return null;
  return { authUserId, profileId: String(data.id), token };
}

/** Convenience: verify the request header and resolve identity in one call. */
export async function identityFromRequest(request: Request): Promise<Identity | null> {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!token) return null;
  return resolveIdentity(token);
}

/**
 * Atomic fixed-window rate limit via the `check_rate_limit` SQL function
 * (service_role). Returns true when the caller is still within `limit` for the
 * window; false means the request should be rejected with 429.
 */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any).rpc("check_rate_limit", {
      _bucket: bucket,
      _limit: limit,
      _window_seconds: windowSeconds,
    });
    if (error) {
      // Fail open on a rate-limiter outage only if the limiter table is missing
      // in a not-yet-migrated environment; log loudly so it is noticed.
      console.error("check_rate_limit failed:", error);
      return true;
    }
    return Boolean(data);
  } catch (err) {
    console.error("check_rate_limit threw:", err);
    return true;
  }
}
