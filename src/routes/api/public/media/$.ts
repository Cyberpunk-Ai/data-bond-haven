import { createFileRoute } from "@tanstack/react-router";
import { getStorageProvider } from "@/lib/storage/index.server";

const PUBLIC_FOLDERS = ["avatars", "posts", "stories", "media"];
const AUTHED_FOLDERS = ["messages", "recordings"];

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

        if (folder === "messages") {
          if (!(await isAuthorizedForMessageMedia(request, path))) {
            return new Response("Not found", { status: 404 });
          }
        } else if (folder === "recordings") {
          if (!(await isAuthorizedForRecording(request, path))) {
            return new Response("Not found", { status: 404 });
          }
        } else if (isAuthed) {
          // Defensive: any future authed folder fails closed until it has a
          // purpose-written authorisation check.
          return new Response("Not found", { status: 404 });
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
  const { identityFromRequest } = await import("@/lib/identity.server");
  const identity = await identityFromRequest(request);
  if (!identity) return false;
  const { profileId, authUserId } = identity;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;

  const mediaUrl = `/api/public/media/${path}`;
  const { data: message } = await db
    .from("messages")
    .select("conversation_id, conversations!inner(user_a, user_b)")
    .eq("media_url", mediaUrl)
    .maybeSingle();
  if (!message) {
    // Legacy attachments uploaded before conversation linkage: fall back to
    // "the caller owns the folder segment". New uploads namespace the segment
    // by profileId; pre-M3 uploads used the auth uid, so both are honoured
    // during the grace period (plan §4.7).
    const segments = path.split("/");
    return segments[1] === profileId || segments[1] === authUserId;
  }

  const convo = (message as any).conversations;
  return convo?.user_a === profileId || convo?.user_b === profileId;
}

/**
 * A Space recording may only be read by the host, an approved participant, or
 * staff. The recording's public URL is stored on `spaces.recording_url`, so we
 * resolve the owning Space from the path and check membership there rather
 * than trusting the (auth-uid-namespaced) folder segment.
 */
async function isAuthorizedForRecording(request: Request, path: string): Promise<boolean> {
  const { identityFromRequest } = await import("@/lib/identity.server");
  const identity = await identityFromRequest(request);
  if (!identity) return false;
  const { profileId, authUserId } = identity;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;

  const mediaUrl = `/api/public/media/${path}`;
  const { data: space } = await db
    .from("spaces")
    .select("id, host_id, space_participants(user_id)")
    .eq("recording_url", mediaUrl)
    .maybeSingle();
  if (!space) {
    // Recording not (yet) attached to a Space row: fail closed except for the
    // uploader owning the folder segment (profileId cannot equal the auth-uid
    // segment, so this is effectively a safe 404 until finalize links the row).
    return false;
  }
  if (space.host_id === profileId) return true;
  const participants: Array<{ user_id: string }> = space.space_participants ?? [];
  if (participants.some((p) => p.user_id === profileId)) return true;

  const { data: staff } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", authUserId)
    .in("role", ["admin", "moderator"])
    .maybeSingle();
  return Boolean(staff);
}
