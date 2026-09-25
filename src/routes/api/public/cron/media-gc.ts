import { createFileRoute } from "@tanstack/react-router";

import { json, requireCronSecret } from "@/lib/api-auth.server";

// Nightly media garbage collection (plan §4.5). Invoked out-of-band (pg_cron /
// external scheduler) with `Authorization: Bearer $CRON_SECRET`. Reclaims any
// tracked `media_objects` bytes no live row references — the safety net behind
// the eager deletes on the post/story/message paths and, once it ships, account
// erasure.
export const Route = createFileRoute("/api/public/cron/media-gc")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!requireCronSecret(request)) {
          return json({ error: "unauthorized" }, 401);
        }
        const { runMediaGarbageCollection } = await import("@/lib/media-cleanup.server");
        return json(await runMediaGarbageCollection());
      },
    },
  },
});
