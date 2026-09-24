import { createFileRoute } from "@tanstack/react-router";

import { authenticateApiRequest, json } from "@/lib/api-auth.server";

/** Lists the profiles following the authenticated developer's account. */
export const Route = createFileRoute("/api/public/v1/followers")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "GET, OPTIONS",
          },
        }),
      GET: async ({ request }) => {
        const auth = await authenticateApiRequest(request);
        if ("error" in auth) return auth.error;
        const url = new URL(request.url);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await (supabaseAdmin as any)
          .from("follows")
          .select("created_at,follower:profiles!follows_follower_id_fkey(id,username,display_name,avatar_url,verified)")
          .eq("target_id", auth.caller.profileId)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return json({ error: "lookup_failed" }, 500);
        return json({ data: (data ?? []).map((r: any) => ({ ...r.follower, followed_at: r.created_at })) });
      },
    },
  },
});
