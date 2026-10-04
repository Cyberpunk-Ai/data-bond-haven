import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/apple-touch-icon.png")({
  server: {
    handlers: {
      GET: async () => {
        const { serveIconAsset } = await import("@/lib/app-icons.server");
        return serveIconAsset("apple-touch-icon.png");
      },
    },
  },
});
