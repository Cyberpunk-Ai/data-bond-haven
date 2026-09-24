import { timingSafeEqual } from "crypto";
import { createFileRoute } from "@tanstack/react-router";

import { dispatchDueWebhooks, json } from "@/lib/api-auth.server";

// Called on a schedule (pg_cron / external cron) with `Authorization: Bearer $CRON_SECRET`.
export const Route = createFileRoute("/api/public/webhooks/dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["CRON_SECRET"] || process.env["LOVABLE_CRON_SECRET"] || "";
        const given = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const a = Buffer.from(given);
        const b = Buffer.from(secret);
        if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) {
          return json({ error: "unauthorized" }, 401);
        }
        return json(await dispatchDueWebhooks(100));
      },
    },
  },
});
