import { createFileRoute } from "@tanstack/react-router";
import { createHash, randomBytes } from "crypto";
import { isAllowedContentType, sizeLimitFor, getStorageProvider } from "@/lib/storage/index.server";
import { signatureMatches } from "@/lib/media-signature";

const FOLDERS = new Set(["avatars", "posts", "stories", "media", "messages", "recordings"]);

// Storage visibility per folder, recorded as a database fact in `media_objects`
// (plan §4.5/§S11). avatars/posts/stories/media are world-readable through the
// media proxy; messages/recordings are participant-gated.
const VISIBILITY_BY_FOLDER: Record<string, "public" | "authed" | "private"> = {
  avatars: "public",
  posts: "public",
  stories: "public",
  media: "public",
  messages: "private",
  recordings: "private",
};

// New uploads per authenticated user per minute. Cheap DoS/burst defence now
// that the bytes are being tracked; adjustable without a redeploy of logic.
const UPLOAD_RATE_LIMIT = 30;
const UPLOAD_RATE_WINDOW_SECONDS = 60;

// Explicit extension per accepted content type. Deriving an extension by
// string-splitting the MIME type (the previous behaviour) silently produced
// odd suffixes and read like a truthiness test on a kind string.
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/webm": "weba",
  "audio/mp4": "m4a",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Authenticated media upload endpoint. Every write is namespaced by the
 * caller's own **profile** id (not the auth uid — the media reader authorizes
 * against the profile id, so the old auth-uid namespacing made the legacy
 * ownership fallback permanently unreadable, plan §4.7), allowlisted by content
 * type, corroborated by magic bytes, capped by size and plan, rate limited, and
 * recorded in `media_objects`. This is the only path allowed to write into the
 * media store.
 */
export const Route = createFileRoute("/api/uploads/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // One canonical session+identity resolver replaces the four hand-copied
        // bearer checks (plan §4.6, §7.2). Route files ship to the client
        // bundle, so the identity module (which pulls in env/server clients) is
        // imported lazily inside the handler.
        const { identityFromRequest, checkRateLimit } = await import("@/lib/identity.server");
        const identity = await identityFromRequest(request);
        if (!identity) return json({ error: "Sign in to upload media." }, 401);
        const { profileId } = identity;

        const url = new URL(request.url);
        const folder = (url.searchParams.get("folder") || "media").toLowerCase();
        if (!FOLDERS.has(folder)) {
          return json({ error: "That upload destination isn't allowed." }, 400);
        }

        const contentType = (request.headers.get("content-type") || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (!isAllowedContentType(contentType)) {
          return json({ error: "That file type isn't supported." }, 415);
        }

        const buffer = new Uint8Array(await request.arrayBuffer());
        if (buffer.byteLength === 0) {
          return json({ error: "The file appears to be empty." }, 400);
        }

        // Magic-byte verification: a payload whose leading bytes don't match its
        // declared (allowlisted) type is refused, so a renamed .html/.xml
        // polyglot can never be stored as an image (plan §4.6).
        if (!signatureMatches(contentType, buffer)) {
          return json({ error: "That file's contents don't match its declared type." }, 415);
        }

        // Per-user upload rate limit (atomic Postgres fixed-window counter).
        if (
          !(await checkRateLimit(
            `upload:${profileId}`,
            UPLOAD_RATE_LIMIT,
            UPLOAD_RATE_WINDOW_SECONDS,
          ))
        ) {
          return json({ error: "You're uploading too quickly. Please wait a moment." }, 429);
        }

        // Enforce the caller's plan, not just the global cap (plan §5).
        const { getPlanLimits, requirePlanCapability, UpgradeRequiredError } =
          await import("@/lib/plan-guard.server");
        try {
          if (folder === "recordings") {
            await requirePlanCapability(profileId, "spaces_recording");
          }
          const limits = await getPlanLimits(profileId);
          const planLimitBytes = limits.media_upload_max_mb * 1024 * 1024;
          const globalLimit = sizeLimitFor(contentType);
          const effectiveLimit = Math.min(planLimitBytes, globalLimit);
          if (buffer.byteLength > effectiveLimit) {
            const maxMb = Math.round(effectiveLimit / (1024 * 1024));
            return json(
              {
                error: `That file is too large for your ${limits.plan} plan. Max size is ${maxMb}MB.`,
                upgrade: true,
              },
              413,
            );
          }
        } catch (err) {
          if (err instanceof UpgradeRequiredError) {
            return json({ error: err.message, upgrade: true }, 402);
          }
          throw err;
        }

        const ext = EXTENSION_BY_CONTENT_TYPE[contentType] ?? "bin";
        // Cryptographically random, unguessable object key. Math.random() is
        // predictable and Date.now() is known from context, which made
        // "public" folders enumerable (guessing other users' files, plan §S11).
        const rand = randomBytes(9).toString("base64url");
        const key = `${folder}/${profileId}/${Date.now()}-${rand}.${ext}`;

        try {
          const provider = getStorageProvider();
          await provider.put(key, buffer, contentType);
        } catch (err) {
          console.error("Media upload failed:", err);
          return json({ error: "We couldn't save that file. Please try again." }, 502);
        }

        // Record the object so visibility/ownership/quota/GC all have a
        // referent (plan §4.5). `media_objects` is service-role-only, so the
        // insert goes through the admin client. Not fatal if the table isn't
        // migrated yet — the bytes are already stored.
        try {
          const sha256 = createHash("sha256").update(buffer).digest("hex");
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { error: mediaErr } = await (supabaseAdmin as any).from("media_objects").insert({
            path: key,
            owner_profile_id: profileId,
            folder,
            visibility: VISIBILITY_BY_FOLDER[folder] ?? "authed",
            content_type: contentType,
            bytes: buffer.byteLength,
            sha256,
          });
          if (mediaErr) console.error("media_objects insert failed:", mediaErr);
        } catch (err) {
          console.error("media_objects record threw:", err);
        }

        return json({ url: `/api/public/media/${key}`, path: key });
      },
    },
  },
});
