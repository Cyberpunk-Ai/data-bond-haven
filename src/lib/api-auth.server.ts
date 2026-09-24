import { createHash, createHmac, randomBytes } from "crypto";

export function hashApiKey(token: string): string {
  const pepper = process.env["API_KEY_PEPPER"] || "";
  return createHash("sha256").update(pepper + token).digest("hex");
}

export function newApiToken(): string {
  return `sk_live_${randomBytes(24).toString("hex")}`;
}

export function signPayload(secret: string, body: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

export type ApiCaller = { keyId: string; profileId: string; scopes: string[] };

/** Validates `Authorization: Bearer sk_live_...`, enforces per-key rate limit, logs the call. */
export async function authenticateApiRequest(
  request: Request,
): Promise<{ caller: ApiCaller } | { error: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!/^sk_live_[a-f0-9]{48}$/.test(token)) {
    return { error: json({ error: "invalid_api_key" }, 401) };
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;
  const { data: key } = await db
    .from("api_keys")
    .select("id,user_id,scopes,revoked,rate_limit_per_minute,call_count")
    .eq("key_hash", hashApiKey(token))
    .maybeSingle();
  if (!key || key.revoked) return { error: json({ error: "invalid_api_key" }, 401) };

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db
    .from("api_requests")
    .select("id", { count: "exact", head: true })
    .eq("key_id", key.id)
    .gte("created_at", since);
  const limit = Number(key.rate_limit_per_minute) || 60;
  const path = new URL(request.url).pathname;
  if ((count ?? 0) >= limit) {
    await db.from("api_requests").insert({ key_id: key.id, path, status: 429 });
    return { error: json({ error: "rate_limited", limit_per_minute: limit }, 429, { "retry-after": "60" }) };
  }
  await Promise.all([
    db.from("api_requests").insert({ key_id: key.id, path, status: 200 }),
    db
      .from("api_keys")
      .update({ call_count: Number(key.call_count ?? 0) + 1, last_used_at: new Date().toISOString() })
      .eq("id", key.id),
  ]);
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
  const { data: due } = await db
    .from("webhook_deliveries")
    .select("id,event,payload,attempts,webhook:webhooks(id,url,secret,active)")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at")
    .limit(limit);
  let delivered = 0;
  let failed = 0;
  for (const d of due ?? []) {
    const hook = d.webhook;
    if (!hook?.active) {
      await db.from("webhook_deliveries").update({ status: "failed" }).eq("id", d.id);
      continue;
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    let status = 0;
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-event": d.event,
          "x-webhook-id": d.id,
          "x-webhook-timestamp": ts,
          "x-webhook-signature": `sha256=${signPayload(hook.secret, body, ts)}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
    } catch {
      status = 0;
    }
    const attempts = d.attempts + 1;
    if (status >= 200 && status < 300) {
      delivered++;
      await db
        .from("webhook_deliveries")
        .update({ status: "delivered", attempts, response_status: status, delivered_at: new Date().toISOString() })
        .eq("id", d.id);
    } else {
      failed++;
      const backoff = Math.min(2 ** attempts * 30, 6 * 3600) * 1000;
      await db
        .from("webhook_deliveries")
        .update({
          status: attempts >= maxAttempts ? "failed" : "pending",
          attempts,
          response_status: status || null,
          next_attempt_at: new Date(Date.now() + backoff).toISOString(),
        })
        .eq("id", d.id);
    }
  }
  return { processed: (due ?? []).length, delivered, failed };
}
