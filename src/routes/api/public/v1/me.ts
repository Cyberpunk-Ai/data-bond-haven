import { createFileRoute } from "@tanstack/react-router";

import { authenticateApiRequest, json } from "@/lib/api-auth.server";

export const Route = createFileRoute("/api/public/v1/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await authenticateApiRequest(request);
        if ("error" in auth) return auth.error;
        if (!auth.caller.scopes.includes("read")) return json({ error: "insufficient_scope" }, 403);
        const { adminDb } = await import("@/integrations/supabase/client.server");
        const { data } = await adminDb()
          .from("profiles")
          .select("id,username,display_name,avatar_url,bio,verified,followers,following,created_at")
          .eq("id", auth.caller.profileId)
          .maybeSingle();
        return json({ data });
      },
    },
  },
});
