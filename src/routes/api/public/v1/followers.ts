import { createFileRoute } from "@tanstack/react-router";

import { authenticateApiRequest, apiCorsHeaders, json } from "@/lib/api-auth.server";

/** Lists the profiles following the authenticated developer's account. */
export const Route = createFileRoute("/api/public/v1/followers")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) =>
        new Response(null, {
          status: 204,
          headers: {
            // Same operator allowlist as every other v1 route — never `*`.
            ...apiCorsHeaders(request.headers.get("origin")),
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "GET, OPTIONS",
          },
        }),
      GET: async ({ request }) => {
        const cors = apiCorsHeaders(request.headers.get("origin"));
        const auth = await authenticateApiRequest(request);
        if ("error" in auth) return auth.error;
        if (!auth.caller.scopes.includes("read"))
          return json({ error: "insufficient_scope" }, 403, cors);
        const url = new URL(request.url);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
        const { adminDb } = await import("@/integrations/supabase/client.server");
        const { data, error } = await adminDb()
          .from("follows")
          .select(
            "created_at,follower:profiles!follows_follower_id_fkey(id,username,display_name,avatar_url,verified)",
          )
          .eq("target_id", auth.caller.profileId)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return json({ error: "lookup_failed" }, 500, cors);
        return json(
          { data: (data ?? []).map((r: any) => ({ ...r.follower, followed_at: r.created_at })) },
          200,
          cors,
        );
      },
    },
  },
});
