import { createFileRoute } from "@tanstack/react-router";

/**
 * `GET /favicon.ico` — served by the app, not only by static hosting.
 *
 * The bytes live in `public/favicon.ico`, but whether that static path is wired
 * up for every hostname (apex vs `www`) is a CDN/DNS detail outside the repo. A
 * route handler answers wherever the app itself runs, so the browser's default
 * icon request can never come back empty on a mirror hostname.
 */
export const Route = createFileRoute("/favicon.ico")({
  server: {
    handlers: {
      GET: async () => {
        const { serveIconAsset } = await import("@/lib/app-icons.server");
        return serveIconAsset("favicon.ico");
      },
    },
  },
});
