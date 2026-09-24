import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function myProfileId(supabase: any, userId: string): Promise<string> {
  const { data } = await supabase.from("profiles").select("id").eq("auth_user_id", userId).maybeSingle();
  if (!data) throw new Error("Profile not found");
  return data.id as string;
}

/** Creates an API key. The plain token is returned once and only its hash is stored. */
export const createApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ name: z.string().trim().min(1).max(60) }).parse(d))
  .handler(async ({ data, context }) => {
    const profileId = await myProfileId(context.supabase, context.userId);
    const { hashApiKey, newApiToken } = await import("./api-auth.server");
    const token = newApiToken();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await (supabaseAdmin as any)
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", profileId);
    if ((count ?? 0) >= 10) throw new Error("You can have at most 10 API keys.");
    const { data: row, error } = await (supabaseAdmin as any)
      .from("api_keys")
      .insert({
        user_id: profileId,
        name: data.name,
        prefix: "sk_live_",
        key_hash: hashApiKey(token),
        last4: token.slice(-4),
        scopes: ["read", "write"],
      })
      .select("id,created_at")
      .single();
    if (error) throw new Error("Could not create key");
    return { id: row.id as string, token, last4: token.slice(-4), createdAt: row.created_at as string };
  });

/** Queues a test event to one of the caller's webhooks and dispatches it immediately. */
export const sendTestWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ webhookId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // RLS: only returns the row if the caller owns it.
    const { data: hook } = await (context.supabase as any)
      .from("webhooks")
      .select("id")
      .eq("id", data.webhookId)
      .maybeSingle();
    if (!hook) throw new Error("Webhook not found");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("webhook_deliveries").insert({
      webhook_id: hook.id,
      event: "ping",
      payload: { event: "ping", created_at: new Date().toISOString(), data: { message: "Hello from your webhook" } },
    });
    const { dispatchDueWebhooks } = await import("./api-auth.server");
    return dispatchDueWebhooks(10);
  });

export const listWebhookDeliveries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase as any)
      .from("webhook_deliveries")
      .select("id,webhook_id,event,status,attempts,response_status,created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    return (data ?? []) as Array<{
      id: string;
      webhook_id: string;
      event: string;
      status: string;
      attempts: number;
      response_status: number | null;
      created_at: string;
    }>;
  });
