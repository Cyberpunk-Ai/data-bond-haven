import { createFileRoute } from "@tanstack/react-router";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Mint a short-lived, path-bound read URL for one media object.
 *
 * Private media is authorized by bearer token, but a browser cannot attach an
 * Authorization header to an `<audio>` / `<video>` / `<img>` subresource load,
 * so Space replays and DM attachments could never play. This endpoint applies
 * exactly the same ACL as the proxy and then hands back a URL the media element
 * can fetch on its own. Public folders need no token and are not minted here.
 *
 * Route files ship to the client bundle, so every server-only module is
 * imported lazily inside the handler.
 */
export const Route = createFileRoute("/api/media/token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { identityFromRequest, checkRateLimit } = await import("@/lib/identity.server");
        const identity = await identityFromRequest(request);
        if (!identity) return json({ error: "Sign in to view this media." }, 401);

        const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
        const raw = typeof body?.url === "string" ? body.url : "";
        if (!raw) return json({ error: "A media url is required." }, 400);

        const { mediaKeyFromUrl } = await import("@/lib/storage/provider.server");
        const path = mediaKeyFromUrl(raw);
        if (!path || path.includes("..") || path.includes("\0")) {
          return json({ error: "That is not a media url." }, 400);
        }

        const { classifyMediaPath, canReadMediaPath } = await import("@/lib/media-authz.server");
        const access = classifyMediaPath(path);
        if (access === "unknown") return json({ error: "Not found." }, 404);
        if (access === "public") {
          // Public objects are served directly; no capability to mint.
          return json({ url: `/api/public/media/${path}`, expiresAt: null });
        }

        // A token is a bearer capability, so cap how many one account can
        // mint per minute (each one is an authorized read of a private object).
        if (!(await checkRateLimit(`media_token:${identity.profileId}`, 120, 60))) {
          return json({ error: "Too many media requests. Please wait a moment." }, 429);
        }

        if (!(await canReadMediaPath(path, identity))) {
          // Same fail-closed 404 as the proxy: don't confirm the object exists.
          return json({ error: "Not found." }, 404);
        }

        const { issueMediaToken } = await import("@/lib/media-token.server");
        try {
          const { token, expiresAt } = issueMediaToken(path, identity.profileId);
          return json({ url: `/api/public/media/${path}?mt=${token}`, expiresAt });
        } catch (err) {
          console.error("media token mint failed:", err);
          return json({ error: "Media access is unavailable right now." }, 500);
        }
      },
    },
  },
});
