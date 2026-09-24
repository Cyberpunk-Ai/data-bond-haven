import { createFileRoute } from "@tanstack/react-router";
import {
  ALLOWED_CONTENT_TYPES,
  isAllowedContentType,
  sizeLimitFor,
  getStorageProvider,
} from "@/lib/storage/index.server";

const FOLDERS = new Set(["avatars", "posts", "stories", "media", "messages"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Verifies the bearer token is a real Supabase session and returns the user id. */
async function authenticate(request: Request): Promise<string | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token || token.split(".").length !== 3) return null;

  const url = process.env["SUPABASE_URL"] || process.env["BACKEND_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"] || process.env["BACKEND_PUBLISHABLE_KEY"];
  if (!url || !key) return null;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims?.sub) return null;
    return String(data.claims.sub);
  } catch {
    return null;
  }
}

/**
 * Authenticated media upload endpoint. Every write is namespaced by the
 * caller's own user id, allowlisted by content type, and capped by size —
 * this is the only path allowed to write into the media store.
 */
export const Route = createFileRoute("/api/uploads/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await authenticate(request);
        if (!userId) return json({ error: "Sign in to upload media." }, 401);

        const url = new URL(request.url);
        const folder = (url.searchParams.get("folder") || "media").toLowerCase();
        if (!FOLDERS.has(folder)) {
          return json({ error: "That upload destination isn't allowed." }, 400);
        }

        const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!isAllowedContentType(contentType)) {
          return json({ error: "That file type isn't supported." }, 415);
        }

        const buffer = new Uint8Array(await request.arrayBuffer());
        const limit = sizeLimitFor(contentType);
        if (buffer.byteLength === 0) {
          return json({ error: "The file appears to be empty." }, 400);
        }
        if (buffer.byteLength > limit) {
          return json(
            { error: `That file is too large. Max size is ${Math.round(limit / (1024 * 1024))}MB.` },
            413,
          );
        }

        const ext = (ALLOWED_CONTENT_TYPES as Record<string, string>)[contentType] ? contentType.split("/")[1] : "bin";
        const safeExt = ext.replace(/[^a-z0-9]/g, "") || "bin";
        const key = `${folder}/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;

        try {
          const provider = getStorageProvider();
          await provider.put(key, buffer, contentType);
        } catch (err) {
          console.error("Media upload failed:", err);
          return json({ error: "We couldn't save that file. Please try again." }, 502);
        }

        return json({ url: `/api/public/media/${key}`, path: key });
      },
    },
  },
});
