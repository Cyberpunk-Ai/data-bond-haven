import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticateApiRequest, json } from "@/lib/api-auth.server";

const createSchema = z.object({ content: z.string().trim().min(1).max(500) });

export const Route = createFileRoute("/api/public/v1/posts")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "GET, POST, OPTIONS",
          },
        }),
      GET: async ({ request }) => {
        const auth = await authenticateApiRequest(request);
        if ("error" in auth) return auth.error;
        const url = new URL(request.url);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data } = await (supabaseAdmin as any)
          .from("posts")
          .select("id,content,media_url,like_count,comment_count,repost_count,created_at")
          .eq("user_id", auth.caller.profileId)
          .eq("hidden", false)
          .order("created_at", { ascending: false })
          .limit(limit);
        return json({ data: data ?? [] });
      },
      POST: async ({ request }) => {
        const auth = await authenticateApiRequest(request);
        if ("error" in auth) return auth.error;
        if (!auth.caller.scopes.includes("write")) return json({ error: "insufficient_scope" }, 403);
        const parsed = createSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "invalid_body", issues: parsed.error.issues }, 400);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await (supabaseAdmin as any)
          .from("posts")
          .insert({ user_id: auth.caller.profileId, content: parsed.data.content })
          .select("id,content,created_at")
          .single();
        if (error) return json({ error: "create_failed" }, 500);
        return json({ data }, 201);
      },
    },
  },
});
