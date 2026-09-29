import { createFileRoute } from "@tanstack/react-router";

import { apiCorsHeaders, json } from "@/lib/api-auth.server";

/**
 * Public liveness probe for the /status page. Returns only coarse verdicts —
 * never infrastructure names, regions, latency internals or error text — so
 * the page is useful to visitors without becoming an information leak.
 */
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) =>
        new Response(null, {
          status: 204,
          headers: { ...apiCorsHeaders(request.headers.get("origin")) },
        }),
      GET: async ({ request }) => {
        const cors = apiCorsHeaders(request.headers.get("origin"));
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // Probed through the storage abstraction, never a named vendor: an R2
        // or B2 deployment must not read as "media degraded" just because it no
        // longer uses the Supabase bucket.
        const { getStorageProvider } = await import("@/lib/storage/index.server");

        const [dbRes, mediaRes] = await Promise.allSettled([
          (supabaseAdmin as any).from("profiles").select("id", { count: "exact", head: true }),
          getStorageProvider().verifyAccess(),
        ]);
        const dbOk =
          dbRes.status === "fulfilled" &&
          !dbRes.value.error &&
          typeof dbRes.value.count === "number";
        const mediaOk = mediaRes.status === "fulfilled" && mediaRes.value.ok === true;

        const services = [
          { id: "app", label: "App & API", status: "operational" as const },
          {
            id: "data",
            label: "Posts, profiles & messages",
            status: dbOk ? ("operational" as const) : ("degraded" as const),
          },
          {
            id: "media",
            label: "Photos, video & audio",
            status: mediaOk ? ("operational" as const) : ("degraded" as const),
          },
          {
            id: "payments",
            label: "Tips & withdrawals",
            status: dbOk ? ("operational" as const) : ("degraded" as const),
          },
        ];
        const allOk = services.every((s) => s.status === "operational");

        return json(
          {
            status: allOk ? "operational" : "degraded",
            checked_at: new Date().toISOString(),
            services,
          },
          200,
          cors,
        );
      },
    },
  },
});
