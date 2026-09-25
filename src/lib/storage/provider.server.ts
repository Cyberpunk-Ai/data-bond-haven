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

export interface StorageProvider {
  /** Write a file to storage under `key`. */
  put(key: string, body: Uint8Array | ArrayBuffer, contentType: string): Promise<StoragePutResult>;
  /** Read a file back out; returns null if it does not exist. */
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /**
   * Permanently remove an object. Required for GDPR/CCPA erasure, deleting a
   * post's media, and expiring stories — without it, bytes outlive every row
   * that references them. Returns the keys that were actually deleted.
   */
  delete(keys: string[]): Promise<string[]>;
  /** Metadata for an object (size/content-type); null if it does not exist. */
  stat(key: string): Promise<StorageStat | null>;
}

/** Single-key convenience wrapper around {@link StorageProvider.delete}. */
export async function deleteObject(provider: StorageProvider, key: string): Promise<boolean> {
  if (!key) return false;
  const deleted = await provider.delete([key]);
  return deleted.length > 0;
}

/** Extract a storage key from a `/api/public/media/<key>` URL or a raw key. */
export function mediaKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = "/api/public/media/";
  const idx = url.indexOf(marker);
  if (idx !== -1) return decodeURIComponent(url.slice(idx + marker.length).split("?")[0]);
  // A bare object path (no protocol) is already a key.
  if (!/^https?:\/\//.test(url)) return url.replace(/^\/+/, "");
  return null;
}

/** Content types the app is willing to store, mapped to a "kind" for size limits. */
export const ALLOWED_CONTENT_TYPES: Record<string, "image" | "video" | "audio"> = {
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
};

/** Per-kind size caps in bytes, read lazily so an env change takes effect
 * without a cold restart (previously computed once at module load). */
function sizeLimitsBytes(): Record<"image" | "video" | "audio", number> {
  const mb = (key: string, fallback: number) =>
    (Number(process.env[key] || fallback) || fallback) * 1024 * 1024;
  return {
    image: mb("MEDIA_MAX_IMAGE_MB", 25),
    video: mb("MEDIA_MAX_VIDEO_MB", 100),
    audio: mb("MEDIA_MAX_AUDIO_MB", 100),
  };
}

export function isAllowedContentType(contentType: string): contentType is keyof typeof ALLOWED_CONTENT_TYPES {
  return Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_TYPES, contentType);
}

export function sizeLimitFor(contentType: string): number {
  const limits = sizeLimitsBytes();
  const kind = ALLOWED_CONTENT_TYPES[contentType];
  return kind ? limits[kind] : limits.image;
}
