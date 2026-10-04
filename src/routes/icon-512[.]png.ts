import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/icon-512.png")({
  server: {
    handlers: {
      GET: async () => {
        const { serveIconAsset } = await import("@/lib/app-icons.server");
        return serveIconAsset("icon-512.png");
      },
    },
  },
});
