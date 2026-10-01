/**
 * Server-side storage abstraction. All media (avatars, posts, stories,
 * message attachments, recordings) goes through one of these implementations
 * so the rest of the app never talks to a specific storage backend directly.
 */

export interface StoragePutResult {
  /** Storage key/path the object was written to. */
  key: string;
}

export interface StorageStat {
  /** Object size in bytes. */
  size: number;
  contentType: string;
}

/** One read result. `totalSize` is the whole object; `body` may be a slice. */
export interface StorageRead {
  body: Uint8Array;
  contentType: string;
  totalSize: number;
  /** True when the backend served only the requested byte range (HTTP 206). */
  partial: boolean;
}

export interface StorageProbe {
  ok: boolean;
  /** Coarse reason for a failure — safe to show an admin, never a stack trace. */
  detail?: string;
}

/** What backend is actually live, for the admin console and the status page. */
export interface StorageInfo {
  /** `s3` covers every S3-compatible store (R2, B2, Spaces, MinIO, AWS). */
  id: "s3" | "supabase";
  label: string;
  bucket: string;
  /** Host only — credentials are never reported anywhere. */
  endpoint?: string;
}

/** One page of key names, plus the cursor that continues where this stopped. */
export interface StorageListing {
  keys: string[];
  /** null once the whole bucket has been enumerated. */
  nextCursor: string | null;
}

export interface StorageProvider {
  readonly info: StorageInfo;
  /** Write a file to storage under `key`. */
  put(key: string, body: Uint8Array | ArrayBuffer, contentType: string): Promise<StoragePutResult>;
  /** Read a file back out; returns null if it does not exist. */
  get(key: string): Promise<StorageRead | null>;
  /**
   * Read `start..end` (inclusive) of an object. Players seek through video and
   * audio with byte ranges, so without this the proxy had to pull the entire
   * recording into memory for every seek.
   */
  getRange(key: string, start: number, end?: number): Promise<StorageRead | null>;
  /**
   * Permanently remove an object. Required for GDPR/CCPA erasure, deleting a
   * post's media, and expiring stories — without it, bytes outlive every row
   * that references them. Returns the keys that were actually deleted.
   */
  delete(keys: string[]): Promise<string[]>;
  /** Metadata for an object (size/content-type); null if it does not exist. */
  stat(key: string): Promise<StorageStat | null>;
  /**
   * A directly-fetchable URL for a public object, when the bucket is mirrored
   * behind a CDN hostname. Returning null means "always stream through the
   * signed proxy", which is the default and the safe answer for private data.
   */
  publicUrl?(key: string): string | null;
  /**
   * Cheap credential/permission check used by /api/public/health. Must not
   * write anything: probes read a key that does not exist.
   */
  verifyAccess(): Promise<StorageProbe>;
  /**
   * Enumerate object keys a page at a time. Only the relocation tool needs this
   * (moving bytes out of a store the platform is leaving), so it is optional —
   * no request path may depend on it.
   */
  list?(cursor?: string | null): Promise<StorageListing>;
}

/** Extract a storage key from a `/api/public/media/<key>` URL or a raw key. */
export function mediaKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // A stored media column can hold several comma-joined urls (a multi-image
  // post). Callers are meant to split first; cutting at the first comma here
  // keeps a value that skipped splitting from producing a key that names two
  // objects at once (which matches nothing, so nothing ever gets reclaimed).
  const single = url.split(",")[0]?.trim();
  if (!single) return null;
  const marker = "/api/public/media/";
  const idx = single.indexOf(marker);
  if (idx !== -1) return decodeURIComponent(single.slice(idx + marker.length).split("?")[0]);
  // A bare object path (no protocol) is already a key.
  if (!/^https?:\/\//.test(single)) return single.replace(/^\/+/, "");
  return null;
}

/** Content types the app is willing to store, mapped to a "kind" for size limits. */
export const ALLOWED_CONTENT_TYPES: Record<string, "image" | "video" | "audio" | "document"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/webm": "audio",
  "audio/mp4": "audio",
  // Documents — always served back as inert downloads by the media reader.
  "application/pdf": "document",
  "text/plain": "document",
  "text/csv": "document",
  "application/json": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "application/zip": "document",
  "application/octet-stream": "document",
};

/** Per-kind size caps in bytes, read lazily so an env change takes effect
 * without a cold restart (previously computed once at module load). */
function sizeLimitsBytes(): Record<"image" | "video" | "audio" | "document", number> {
  const mb = (key: string, fallback: number) =>
    (Number(process.env[key] || fallback) || fallback) * 1024 * 1024;
  return {
    image: mb("MEDIA_MAX_IMAGE_MB", 25),
    video: mb("MEDIA_MAX_VIDEO_MB", 100),
    audio: mb("MEDIA_MAX_AUDIO_MB", 100),
    document: mb("MEDIA_MAX_DOC_MB", 25),
  };
}

export function isAllowedContentType(
  contentType: string,
): contentType is keyof typeof ALLOWED_CONTENT_TYPES {
  return Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_TYPES, contentType);
}

export function sizeLimitFor(contentType: string): number {
  const limits = sizeLimitsBytes();
  const kind = ALLOWED_CONTENT_TYPES[contentType];
  return kind ? limits[kind] : limits.image;
}
