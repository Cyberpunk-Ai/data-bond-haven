import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { safeExternalFetch, UnsafeUrlError } from "@/lib/ssrf-guard.server";
import { bearerToken, checkRateLimit } from "@/lib/identity.server";

/**
 * The pepper turns an API-key hash from a plain unsalted SHA-256 (which is
 * trivially reversed on a DB dump) into a keyed digest. It is mandatory: we
 * fail loudly the first time keying is attempted rather than silently hashing
 * without it. Keys already stored under an empty pepper must be re-issued
 * after the pepper is set — the Developer Portal makes rotation a one-click
 * action.
 */
function requireApiKeyPepper(): string {
  const pepper = process.env["API_KEY_PEPPER"] ?? "";
  if (pepper.length < 32) {
    throw new Error(
      "API_KEY_PEPPER is missing or shorter than 32 characters. Generate one with `openssl rand -hex 32` and set it before issuing or verifying API keys.",
    );
  }
  return pepper;
}

export function hashApiKey(token: string): string {
  return createHmac("sha256", requireApiKeyPepper()).update(token).digest("hex");
}

export function newApiToken(): string {
  return `sp1_live_${randomBytes(24).toString("hex")}`;
}

export function signPayload(secret: string, body: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Cross-origin policy for the public Developer API.
 *
 * The token-based Developer API is intentionally callable from third-party
 * browser apps, but the set of origins that may do so is an explicit operator
 * allowlist (`ALLOWED_API_ORIGINS`, comma-separated) — never `*`. A request
 * from an origin that is not on the list simply receives no CORS headers, so
 * the browser blocks the response. Same-origin and non-browser (server-to-
 * server) callers never send an `Origin` header and are unaffected.
 */
function allowedApiOrigins(): Set<string> {
  const raw = process.env["ALLOWED_API_ORIGINS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

/** Returns CORS headers echoing `origin` only when it is on the allowlist. */
export function apiCorsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  if (!allowedApiOrigins().has(origin.replace(/\/+$/, ""))) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-max-age": "600",
  };
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/**
 * Constant-time verification of the scheduled-task shared secret.
 *
 * Cron/webhook dispatch routes are all invoked out-of-band (pg_cron / an
 * external scheduler) with `Authorization: Bearer $CRON_SECRET`. This was
 * hand-copied per route before; centralising it guarantees the fail-closed rule
 * — an unset secret must never compare equal to an empty header — holds
 * everywhere a scheduler endpoint is added.
 */
export function requireCronSecret(request: Request): boolean {
  const secret = process.env["CRON_SECRET"] ?? "";
  const given = bearerToken(request) ?? "";
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ApiCaller = { keyId: string; profileId: string; scopes: string[] };

/** Validates `Authorization: Bearer sp1_live_...`, enforces per-key rate limit, logs the call. */
export async function authenticateApiRequest(
  request: Request,
): Promise<{ caller: ApiCaller } | { error: Response }> {
  const cors = apiCorsHeaders(request.headers.get("origin"));
  const token = bearerToken(request) ?? "";
  if (!/^sp1_live_[a-f0-9]{48}$/.test(token)) {
    return { error: json({ error: "invalid_api_key" }, 401, cors) };
  }
  let key: any;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as any;
    const { data } = await db
      .from("api_keys")
      .select("id,user_id,scopes,revoked,rate_limit_per_minute,call_count")
      .eq("key_hash", hashApiKey(token))
      .maybeSingle();
    key = data;
  } catch {
    // hashApiKey throws when the pepper is unset — surface it as a service
    // misconfiguration (503) rather than a generic 401 that hides the cause.
    return { error: json({ error: "api_not_configured" }, 503, cors) };
  }
  if (!key || key.revoked) return { error: json({ error: "invalid_api_key" }, 401, cors) };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;
  const limit = Number(key.rate_limit_per_minute) || 60;
  const path = new URL(request.url).pathname;

  // The decision comes from the same atomic fixed-window counter every other
  // surface uses. Counting `api_requests` rows here first and inserting after
  // let a concurrent burst all read "under the limit", and — because supabase-js
  // resolves instead of throwing — a rejected ledger insert quietly removed the
  // only thing the limit was measured against.
  const withinLimit = await checkRateLimit(`api-key:${key.id}`, limit, 60);
  if (!withinLimit) {
    const { error } = await db.from("api_requests").insert({ key_id: key.id, path, status: 429 });
    if (error) console.error("api usage log (429) failed:", error.message);
    return {
      error: json({ error: "rate_limited", limit_per_minute: limit }, 429, {
        "retry-after": "60",
        ...cors,
      }),
    };
  }
  const [ledger, usage] = await Promise.all([
    db.from("api_requests").insert({ key_id: key.id, path, status: 200 }),
    db
      .from("api_keys")
      .update({
        call_count: Number(key.call_count ?? 0) + 1,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", key.id),
  ]);
  // Telemetry only — never fail a request over it — but a broken ledger has to be
  // visible or the developer portal quietly reports zero usage for a busy key.
  if (ledger.error) console.error("api usage log failed:", ledger.error.message);
  if (usage.error) console.error("api key usage counter failed:", usage.error.message);
  return {
    caller: {
      keyId: key.id,
      profileId: key.user_id,
      scopes: Array.isArray(key.scopes) ? key.scopes : [],
    },
  };
}

/** Sends due webhook deliveries with HMAC signatures and exponential backoff. */
export async function dispatchDueWebhooks(limit = 50) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;
  const maxAttempts = Number(process.env["WEBHOOK_MAX_ATTEMPTS"] ?? 6);
  const { data: due, error: dueError } = await db
    .from("webhook_deliveries")
    .select("id,event,payload,attempts,webhook:webhooks(id,url,secret,active)")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at")
    .limit(limit);
  if (dueError) {
    // Say so: a silent outage here looks exactly like "nothing to deliver".
    console.error("webhook queue read failed:", dueError.message);
    return { processed: 0, delivered: 0, failed: 0 };
  }
  let delivered = 0;
  let failed = 0;

  /** Persist a delivery state transition. A lost write here means the row stays
   * `pending`, so the next run posts the same event to the customer again — worth
   * a log line even though the queue must keep draining. */
  const mark = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await db.from("webhook_deliveries").update(patch).eq("id", id);
    if (error) console.error(`webhook delivery ${id} state write failed:`, error.message);
    return !error;
  };

  for (const d of due ?? []) {
    const hook = d.webhook;
    if (!hook?.active) {
      await mark(d.id, { status: "failed" });
      continue;
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    let status = 0;
    try {
      // Guard and request in one call: the host is resolved and screened before
      // anything is dialled, and a `3xx` answer fails instead of walking the
      // customer's signature and payload to an address that was never checked.
      const res = await safeExternalFetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-event": d.event,
          "x-webhook-id": d.id,
          "x-webhook-timestamp": ts,
          "x-webhook-signature": `sha256=${signPayload(hook.secret, body, ts)}`,
        },
        body,
      });
      status = res.status;
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        // An endpoint we will never be allowed to reach: failing it retries
        // nothing, it just keeps the queue moving.
        await mark(d.id, {
          status: "failed",
          attempts: d.attempts + 1,
          response_status: null,
          last_error: err.message,
        });
        failed++;
        continue;
      }
      status = 0; // timeout or connection failure — back off and try again
    }
    const attempts = d.attempts + 1;
    if (status >= 200 && status < 300) {
      const settled = await mark(d.id, {
        status: "delivered",
        attempts,
        response_status: status,
        delivered_at: new Date().toISOString(),
      });
      // Only claim a delivery the database agreed to remember.
      if (settled) delivered++;
    } else {
      failed++;
      const backoff = Math.min(2 ** attempts * 30, 6 * 3600) * 1000;
      await mark(d.id, {
        status: attempts >= maxAttempts ? "failed" : "pending",
        attempts,
        response_status: status || null,
        next_attempt_at: new Date(Date.now() + backoff).toISOString(),
      });
    }
  }
  return { processed: (due ?? []).length, delivered, failed };
}
