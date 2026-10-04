import { createFileRoute } from "@tanstack/react-router";

/** Sized app icons, served through the app so the tab mark shows on every
 *  hostname the app runs on, not just where static asset hosting is wired. */
export const Route = createFileRoute("/icon-192.png")({
  server: {
    handlers: {
      GET: async () => {
        const { serveIconAsset } = await import("@/lib/app-icons.server");
        return serveIconAsset("icon-192.png");
      },
    },
  },
});
