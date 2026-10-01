import { createFileRoute } from "@tanstack/react-router";
import { getStorageProvider } from "@/lib/storage/index.server";
import { readRangeIntent } from "@/lib/media-range.server";
import { contentDisposition, sanitizeFileName } from "@/lib/media-download";
import { isPrivateMediaPath, isPublicMediaPath } from "@/lib/media-folders.server";

// Which folders are world-readable and which need a reader check lives in
// src/lib/media-folders.server.ts, shared with the upload route, the signed-URL
// issuer and the storage providers (which is what decides the public/private
// bucket each object is written to). `stories` is authed rather than public:
// the rows are limited to the author's follow network by RLS, and the bytes
// enforce the same rule.

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
 * Read proxy for private media (an S3-compatible store such as Cloudflare R2
 * when configured, otherwise the Supabase 'media' bucket). Uploaded files are
 * stored privately; this route streams them back so links never expire and no
 * signed URL has to be refreshed client-side.
 *
 * Hardened: `messages/` (private DM attachments) requires a valid session
 * AND that the caller is a participant in the conversation the attachment
 * belongs to. Every response is served with `nosniff` plus a content-type
 * allowlist that forces non-media payloads to download instead of rendering
 * inline. Byte-range (`Range: bytes=…`) is honoured with 206/416 responses and
 * is passed down to the storage backend, so seeking into a 90-minute replay
 * fetches the few hundred kilobytes the player asked for instead of buffering
 * the whole recording in server memory. Private objects are cached `no-store`.
 */
export const Route = createFileRoute("/api/public/media/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const raw = String((params as { _splat?: string })._splat ?? "");
        const path = raw.replace(/^\/+/, "");
        const query = new URL(request.url).searchParams;
        // `?dl=1` asks for the bytes as a file. `?name=` is the name the sender
        // chose; the storage key is a randomised uuid that means nothing to the
        // person saving it.
        const asAttachment = query.get("dl") === "1";
        const wantedName = query.get("name") ? sanitizeFileName(query.get("name")!, "") : "";

        if (!path || path.includes("..") || path.includes("\0")) {
          return new Response("Not found", { status: 404 });
        }

        const isPublic = isPublicMediaPath(path);
        const isAuthed = isPrivateMediaPath(path);
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
          const tokenParam = query.get("mt");
          const tokenProfile = verifyMediaToken(path, tokenParam);
          if (!tokenProfile) {
            const { identityFromRequest } = await import("@/lib/identity.server");
            const identity = await identityFromRequest(request);
            const allowed = await canReadMediaPath(path, identity);
            if (!allowed) return new Response("Not found", { status: 404 });
          }
        }

        const provider = getStorageProvider();

        // Public, inline-safe objects can be handed straight to the public
        // bucket's own read-only domain when the operator opted into one — the
        // bytes then travel from the CDN instead of through this server. The
        // opt-in (MEDIA_PUBLIC_CDN) is still required, because a bucket domain
        // serves everything that bucket holds: the app only puts declared public
        // folders in it, so this is safe once the split buckets exist.
        // A download must come from here even when a public CDN is configured:
        // the bucket's own domain cannot be told to answer `attachment`, and a
        // redirect to it is how "Download" ended up opening the image in a tab.
        if (isPublic && !asAttachment && publicCdnEnabled() && provider.publicUrl) {
          const head = await provider.stat(path);
          const headType = (head?.contentType ?? "").split(";")[0].trim().toLowerCase();
          if (head && INLINE_CONTENT_TYPES.has(headType)) {
            return new Response(null, {
              status: 302,
              headers: {
                location: provider.publicUrl(path)!,
                "Cache-Control": "public, max-age=31536000, immutable",
              },
            });
          }
        }

        // A byte range is resolved in two steps: read what the player asked for
        // now, then validate it against the object's real size once the backend
        // answers. Suffix ranges (`bytes=-N`) need the size first, so they cost
        // one cheap HEAD instead of a whole-object download.
        const intent = readRangeIntent(request.headers.get("range"));
        let start: number | undefined;
        let end: number | undefined;
        if (intent?.suffix !== undefined) {
          const head = await provider.stat(path);
          if (!head) return new Response("Not found", { status: 404 });
          start = Math.max(0, head.size - intent.suffix);
          end = head.size - 1;
        } else if (intent) {
          start = intent.start;
          end = intent.end;
        }

        const object =
          start !== undefined
            ? await provider.getRange(path, start, end)
            : await provider.get(path);
        if (!object) {
          // A ranged miss is ambiguous: the object may be gone, or the range may
          // simply start past its end (a player that over-read a truncated file).
          // Some gateways answer those both as an error, so re-check with a HEAD:
          // 416 is what tells the player to clamp its seek instead of retrying.
          if (start !== undefined) {
            const head = await provider.stat(path);
            if (head && start >= head.size) {
              return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" },
              });
            }
          }
          return new Response("Not found", { status: 404 });
        }

        const rawType = (object.contentType || "application/octet-stream")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const inline = INLINE_CONTENT_TYPES.has(rawType) && !asAttachment;
        const filename = wantedName || path.split("/").pop() || "media";
        const bytes = object.body;
        const total = object.totalSize || bytes.byteLength;

        // A private object must never be stored by a shared cache — and not
        // even by the browser for long: story/DM/recording access can be
        // revoked (unfollow, delete) minutes after it was first viewed. A
        // download is private by definition, so it is never cached either.
        const cacheControl =
          !inline || asAttachment
            ? "no-store"
            : isPublic
              ? "public, max-age=31536000, immutable"
              : "no-store";

        const baseHeaders: Record<string, string> = {
          "Content-Type": inline ? rawType : "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", filename),
          "Cache-Control": cacheControl,
          "Accept-Ranges": "bytes",
        };

        // The backend served (part of) a range: answer 206 with the span it
        // actually covered. An out-of-bounds start becomes 416, which is what
        // tells a player the file is shorter than it thought.
        if (start !== undefined && object.partial) {
          if (start >= total) {
            return new Response(null, {
              status: 416,
              headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
            });
          }
          const last = Math.min(end ?? total - 1, total - 1);
          return new Response(bytes as unknown as BodyInit, {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes ${start}-${last}/${total}`,
              "Content-Length": String(bytes.byteLength),
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

/** Only ever enabled deliberately — a public bucket domain is readable by anyone. */
function publicCdnEnabled(): boolean {
  const value = process.env["MEDIA_PUBLIC_CDN"];
  return value === "true" || value === "1";
}

// The download name arrives from a chat message and lands in a response header,
// so it is reduced to a basename with nothing quote- or header-breaking left in
// it — see sanitizeFileName in src/lib/media-download.ts, which the browser uses
// for the same value so a name cannot disagree with itself.

// The per-folder read rules live in src/lib/media-authz.server.ts so that this
// reader and the /api/media/token issuer cannot drift apart.
