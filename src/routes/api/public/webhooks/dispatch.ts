import { createFileRoute } from "@tanstack/react-router";

import { dispatchDueWebhooks, json, requireCronSecret } from "@/lib/api-auth.server";

// Called on a schedule (pg_cron / external cron) with `Authorization: Bearer $CRON_SECRET`.
export const Route = createFileRoute("/api/public/webhooks/dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!requireCronSecret(request)) {
          return json({ error: "unauthorized" }, 401);
        }
        return json(await dispatchDueWebhooks(100));
      },
    },
  },
});
