import { createFileRoute } from "@tanstack/react-router";

const PUBLIC_FOLDERS = ["avatars", "posts", "stories", "media"];
const AUTHED_FOLDERS = ["messages"];

// Content types we are willing to render inline. Anything else (notably
// image/svg+xml and text/html, which can carry script) is forced to a
// download so it can never execute on this app's own origin.
const INLINE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/mp4",
]);

/**
 * Read proxy for the private `media` bucket. Uploaded files are stored
 * privately; this route streams them back so links never expire and no signed
 * URL has to be refreshed client-side.
 *
 * Hardened: `messages/` (private DM attachments) requires a valid session, and
 * every response is served with `nosniff` plus a content-type allowlist that
 * forces non-media payloads to download instead of rendering inline.
 */
export const Route = createFileRoute("/api/public/media/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const raw = String((params as { _splat?: string })._splat ?? "");
        const path = raw.replace(/^\/+/, "");
        const folder = path.split("/")[0] ?? "";

        if (!path || path.includes("..") || path.includes("\0")) {
          return new Response("Not found", { status: 404 });
        }

        const isPublic = PUBLIC_FOLDERS.includes(folder);
        const isAuthed = AUTHED_FOLDERS.includes(folder);
        if (!isPublic && !isAuthed) {
          return new Response("Not found", { status: 404 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        if (isAuthed) {
          const authorized = await isAuthorizedRequest(request);
          if (!authorized) {
            return new Response("Not found", { status: 404 });
          }
        }

        const { data, error } = await supabaseAdmin.storage.from("media").download(path);
        if (error || !data) {
          return new Response("Not found", { status: 404 });
        }

        const rawType = (data.type || "application/octet-stream")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const inline = INLINE_CONTENT_TYPES.has(rawType);
        const filename = path.split("/").pop() ?? "media";

        return new Response(data, {
          headers: {
            "Content-Type": inline ? rawType : "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": inline
              ? `inline; filename="${filename}"`
              : `attachment; filename="${filename}"`,
            "Cache-Control": inline ? "public, max-age=31536000, immutable" : "no-store",
          },
        });
      },
    },
  },
});

/** Verify the request carries a valid Supabase session (used for private folders). */
async function isAuthorizedRequest(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token || token.split(".").length !== 3) return false;

  const url = (process.env["SUPABASE_URL"] || process.env["BACKEND_URL"]);
  const key = (process.env["SUPABASE_PUBLISHABLE_KEY"] || process.env["BACKEND_PUBLISHABLE_KEY"]);
  if (!url || !key) return false;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.getClaims(token);
    return !error && Boolean(data?.claims?.sub);
  } catch {
    return false;
  }
}
