import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/favicon-16x16.png")({
  server: {
    handlers: {
      GET: async () => {
        const { serveIconAsset } = await import("@/lib/app-icons.server");
        return serveIconAsset("favicon-16x16.png");
      },
    },
  },
});
