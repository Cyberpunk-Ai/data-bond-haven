import { createFileRoute } from "@tanstack/react-router";
import { createHash, randomBytes } from "crypto";
import { isAllowedContentType, sizeLimitFor, getStorageProvider } from "@/lib/storage/index.server";
import { isUploadFolder, visibilityOfPath } from "@/lib/media-folders.server";
import { signatureMatches } from "@/lib/media-signature";
import { declaredBodyBytes, readCappedBody } from "@/lib/upload-limits";

// Storage visibility per folder lives in src/lib/media-folders.server.ts — the
// same map the read proxy and the storage providers route buckets by, so an
// upload can never file a private object into the public bucket by accident.
// avatars/posts/media are world-readable; stories/messages/recordings are
// authorized per reader (stories mirror the rows' follow-network RLS).
function visibilityForFolder(folder: string): "public" | "authed" | "private" {
  return visibilityOfPath(`${folder}/x`) ?? "authed";
}

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
  // Documents. Anything the browser could not classify is sent as
  // application/octet-stream by the client and stored as a generic download;
  // the recipient's card shows the real filename captured at send time.
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip",
  "application/octet-stream": "bin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** 413 with the plan named, so the client can route the refusal to an upgrade. */
function tooLarge(plan: string, limitBytes: number) {
  const maxMb = Math.round(limitBytes / (1024 * 1024));
  return json(
    {
      error: `That file is too large for your ${plan} plan. Max size is ${maxMb}MB.`,
      upgrade: true,
    },
    413,
  );
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
        if (!isUploadFolder(folder)) {
          return json({ error: "That upload destination isn't allowed." }, 400);
        }

        const contentType = (request.headers.get("content-type") || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (!isAllowedContentType(contentType)) {
          return json({ error: "That file type isn't supported." }, 415);
        }

        // Per-user upload rate limit (atomic Postgres fixed-window counter).
        // Ahead of the body read on purpose: a burst should cost one counter
        // read, not a buffered payload.
        if (
          !(await checkRateLimit(
            `upload:${profileId}`,
            UPLOAD_RATE_LIMIT,
            UPLOAD_RATE_WINDOW_SECONDS,
          ))
        ) {
          return json({ error: "You're uploading too quickly. Please wait a moment." }, 429);
        }

        // Enforce the caller's plan, not just the global cap (plan §5) — decided
        // *before* the body is read. `media_upload_max_mb` goes up to 1024 on Pro,
        // and this handler runs in the same process as the SSR app, so buffering
        // first and refusing afterwards let one oversized upload take the
        // process's memory with it.
        const { getPlanLimits, requirePlanCapability, UpgradeRequiredError } =
          await import("@/lib/plan-guard.server");
        const { requireSpaceStorageQuota, isSpaceStorageFull } =
          await import("@/lib/space-storage.server");

        const globalLimit = sizeLimitFor(contentType);
        let plan = "free";
        let effectiveLimit = globalLimit;
        try {
          if (folder === "recordings") {
            await requirePlanCapability(profileId, "spaces_recording");
          }
          const limits = await getPlanLimits(profileId);
          plan = limits.plan;
          effectiveLimit = Math.min(limits.media_upload_max_mb * 1024 * 1024, globalLimit);

          // A declared length that cannot fit is refused without reading a byte.
          // It is only the client's word, so the real size is checked again below.
          const declared = declaredBodyBytes(request);
          if (declared > effectiveLimit) {
            return tooLarge(plan, effectiveLimit);
          }
          // A live Space stores nothing; a saved replay does, and it has to fit
          // the host's replay budget — so an over-budget recording never becomes
          // a replay, while the broadcast itself is untouched.
          if (folder === "recordings" && declared > 0) {
            await requireSpaceStorageQuota(profileId, declared);
          }
        } catch (err) {
          if (err instanceof UpgradeRequiredError) {
            return json({ error: err.message, upgrade: true }, 402);
          }
          // 507: the host's replay budget is spent. `upgrade` is set because the
          // client routes any storage refusal to a useful next step — for a full
          // plan that is deleting an old replay, which the message says.
          if (isSpaceStorageFull(err)) {
            return json({ error: err.message, upgrade: true }, 507);
          }
          throw err;
        }

        // Reads at most `effectiveLimit` bytes and cancels the stream past that,
        // so an oversized body is never fully taken into memory.
        const { bytes, tooLarge: oversized } = await readCappedBody(request.body, effectiveLimit);
        if (oversized) {
          return tooLarge(plan, effectiveLimit);
        }

        const buffer = bytes;
        if (buffer.byteLength === 0) {
          return json({ error: "The file appears to be empty." }, 400);
        }

        // Magic-byte verification: a payload whose leading bytes don't match its
        // declared (allowlisted) type is refused, so a renamed .html/.xml
        // polyglot can never be stored as an image (plan §4.6).
        if (!signatureMatches(contentType, buffer)) {
          return json({ error: "That file's contents don't match its declared type." }, 415);
        }

        // The authoritative size checks, against the bytes actually held rather
        // than the length the client claimed.
        try {
          if (buffer.byteLength > effectiveLimit) {
            return tooLarge(plan, effectiveLimit);
          }
          if (folder === "recordings") {
            await requireSpaceStorageQuota(profileId, buffer.byteLength);
          }
        } catch (err) {
          if (err instanceof UpgradeRequiredError) {
            return json({ error: err.message, upgrade: true }, 402);
          }
          if (isSpaceStorageFull(err)) {
            return json({ error: err.message, upgrade: true }, 507);
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
            visibility: visibilityForFolder(folder),
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
