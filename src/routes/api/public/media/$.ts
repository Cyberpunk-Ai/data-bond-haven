import { createFileRoute } from "@tanstack/react-router";
import { getStorageProvider } from "@/lib/storage/index.server";

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
 * Read proxy for private media (Cloudflare R2 when configured, otherwise the
 * Supabase 'media' bucket). Uploaded files are stored privately; this route
 * streams them back so links never expire and no signed URL has to be
 * refreshed client-side.
 *
 * Hardened: `messages/` (private DM attachments) requires a valid session
 * AND that the caller is a participant in the conversation the attachment
 * belongs to. Every response is served with `nosniff` plus a content-type
 * allowlist that forces non-media payloads to download instead of rendering
 * inline.
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

        if (isAuthed) {
          const authorized = await isAuthorizedForMessageMedia(request, path);
          if (!authorized) {
            return new Response("Not found", { status: 404 });
          }
        }

        const object = await getStorageProvider().get(path);
        if (!object) {
          return new Response("Not found", { status: 404 });
        }

        const rawType = (object.contentType || "application/octet-stream")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const inline = INLINE_CONTENT_TYPES.has(rawType);
        const filename = path.split("/").pop() ?? "media";

        return new Response(object.body as BodyInit, {
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

/**
 * A private DM attachment may only be read by someone signed in AND who is a
 * participant (sender or recipient) of a conversation that actually
 * references this attachment.
 */
async function isAuthorizedForMessageMedia(request: Request, path: string): Promise<boolean> {
  const authUserId = await verifiedAuthUserId(request);
  if (!authUserId) return false;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;

  const { data: profile } = await db
    .from("profiles")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  const profileId = profile?.id;
  if (!profileId) return false;

  const mediaUrl = `/api/public/media/${path}`;
  const { data: message } = await db
    .from("messages")
    .select("conversation_id, conversations!inner(user_a, user_b)")
    .eq("media_url", mediaUrl)
    .maybeSingle();
  if (!message) {
    // Legacy attachments uploaded before conversation linkage: fall back to
    // "the caller owns the folder segment" (path is namespaced by uploader id).
    const segments = path.split("/");
    return segments[1] === profileId;
  }

  const convo = (message as any).conversations;
  return convo?.user_a === profileId || convo?.user_b === profileId;
}

/** Verify the request carries a valid Supabase session and return the auth user id. */
async function verifiedAuthUserId(request: Request): Promise<string | null> {
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
