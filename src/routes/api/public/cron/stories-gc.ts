import { createFileRoute } from "@tanstack/react-router";

import { json, requireCronSecret } from "@/lib/api-auth.server";

// Nightly story garbage collection. Stories expire 24h after posting; the feed
// already hides them via an `expires_at` filter, but the rows (and any uploaded
// media) are reclaimed here. Invoked out-of-band (pg_cron / external scheduler)
// with `Authorization: Bearer $CRON_SECRET`.
export const Route = createFileRoute("/api/public/cron/stories-gc")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!requireCronSecret(request)) {
          return json({ error: "unauthorized" }, 401);
        }

        const { adminDb } = await import("@/integrations/supabase/client.server");
        const { deleteStoredMedia } = await import("@/lib/media-cleanup.server");
        const db = adminDb();

        const now = new Date().toISOString();
        const { data: expired, error } = await db
          .from("stories")
          .select("id, media_url")
          .lt("expires_at", now);
        if (error) {
          console.error("stories-gc: could not read expired stories:", error);
          return json({ error: "gc_failed" }, 500);
        }

        const rows = (expired ?? []) as Array<{ id: string; media_url: string | null }>;
        if (rows.length === 0) return json({ removed: 0, media: 0 });

        // Reclaim uploaded story media first, then drop the rows.
        const media = await deleteStoredMedia(rows.map((r) => r.media_url));
        const { error: delErr } = await db
          .from("stories")
          .delete()
          .in(
            "id",
            rows.map((r) => r.id),
          );
        if (delErr) {
          console.error("stories-gc: delete failed:", delErr);
          return json({ error: "delete_failed", removed: 0, media }, 500);
        }

        return json({ removed: rows.length, media });
      },
    },
  },
});
