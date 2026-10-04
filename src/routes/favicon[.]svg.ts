import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/favicon.svg")({
  server: {
    handlers: {
      GET: async () => {
        const { serveIconAsset } = await import("@/lib/app-icons.server");
        return serveIconAsset("favicon.svg");
      },
    },
  },
});
