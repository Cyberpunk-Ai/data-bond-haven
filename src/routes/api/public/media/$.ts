import { createFileRoute } from "@tanstack/react-router";
import { getStorageProvider } from "@/lib/storage/index.server";

// `stories` moved from public to authed: the rows are already limited to the
// author's follow network by RLS, and the bytes now enforce the same rule.
const PUBLIC_FOLDERS = ["avatars", "posts", "media"];
const AUTHED_FOLDERS = ["messages", "recordings", "stories"];

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
 * inline. Byte-range (`Range: bytes=…`) is honoured with 206/416 responses,
 * which is what makes seeking work in the audio/video players, and private
 * objects are cached `private,` never `public`.
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
          // Private object. Two ways in: the caller's bearer session, or a
          // short-lived signed path (`?mt=`) minted by /api/media/token after
          // the same ACL below - which is how <audio>/<video>/<img> elements
          // reach private media, since a browser cannot send an Authorization
          // header on a subresource load.
          const [{ verifyMediaToken }, { canReadMediaPath }] = await Promise.all([
            import("@/lib/media-token.server"),
            import("@/lib/media-authz.server"),
          ]);
          const tokenParam = new URL(request.url).searchParams.get("mt");
          const tokenProfile = verifyMediaToken(path, tokenParam);
          if (!tokenProfile) {
            const { identityFromRequest } = await import("@/lib/identity.server");
            const identity = await identityFromRequest(request);
            const allowed = await canReadMediaPath(path, identity);
            if (!allowed) return new Response("Not found", { status: 404 });
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
        const bytes = object.body instanceof Uint8Array ? object.body : new Uint8Array(object.body as ArrayBuffer);

        // A private object must never be stored by a shared cache — and not
        // even by the browser for long: story/DM/recording access can be
        // revoked (unfollow, delete) minutes after it was first viewed.
        const cacheControl = !inline
          ? "no-store"
          : isPublic
            ? "public, max-age=31536000, immutable"
            : "no-store";

        const baseHeaders: Record<string, string> = {
          "Content-Type": inline ? rawType : "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": inline
            ? `inline; filename="${filename}"`
            : `attachment; filename="${filename}"`,
          "Cache-Control": cacheControl,
          "Accept-Ranges": "bytes",
        };

        const range = parseByteRange(request.headers.get("range"), bytes.byteLength);
        if (range === "unsatisfiable") {
          return new Response(null, {
            status: 416,
            headers: { ...baseHeaders, "Content-Range": `bytes */${bytes.byteLength}` },
          });
        }
        if (range) {
          const slice = bytes.subarray(range.start, range.end + 1);
          return new Response(slice as unknown as BodyInit, {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
              "Content-Length": String(slice.byteLength),
            },
          });
        }

        return new Response(bytes as unknown as BodyInit, {
          headers: { ...baseHeaders, "Content-Length": String(bytes.byteLength) },
        });
      },
    },
  },
});

/**
 * Parse a single `Range: bytes=a-b` header against a known object size.
 * Returns null when no range was requested (serve whole), "unsatisfiable"
 * when it cannot be honoured, or the inclusive byte span.
 */
function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const text = header?.trim().toLowerCase();
  if (!text || !text.startsWith("bytes=")) return null;
  // Only a single range is supported; a multi-range request serves the whole
  // object rather than pretending to be a multipart/byteranges server.
  if (text.split("=")[1]?.includes(",")) return null;
  const [rawStart, rawEnd] = text.slice(6).split("-");
  if (rawStart === "" || rawStart === undefined) {
    // Suffix form `bytes=-N` = the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0 || start >= size) return "unsatisfiable";
  const end = rawEnd === undefined || rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

// The per-folder read rules live in src/lib/media-authz.server.ts so that this
// reader and the /api/media/token issuer cannot drift apart.

