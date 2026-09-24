/**
 * Server-side storage abstraction. All media (avatars, posts, stories,
 * message attachments, recordings) goes through one of these implementations
 * so the rest of the app never talks to a specific storage backend directly.
 */

export interface StoragePutResult {
  /** Storage key/path the object was written to. */
  key: string;
}

export interface StorageProvider {
  /** Write a file to storage under `key`. */
  put(key: string, body: Uint8Array | ArrayBuffer, contentType: string): Promise<StoragePutResult>;
  /** Read a file back out; returns null if it does not exist. */
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
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

/** Per-kind size caps in bytes. Recordings (audio/video from Spaces) default to 100MB. */
export const SIZE_LIMITS_BYTES: Record<"image" | "video" | "audio", number> = {
  image: Number(process.env["MEDIA_MAX_IMAGE_MB"] || 25) * 1024 * 1024,
  video: Number(process.env["MEDIA_MAX_VIDEO_MB"] || 100) * 1024 * 1024,
  audio: Number(process.env["MEDIA_MAX_AUDIO_MB"] || 100) * 1024 * 1024,
};

export function isAllowedContentType(contentType: string): contentType is keyof typeof ALLOWED_CONTENT_TYPES {
  return Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_TYPES, contentType);
}

export function sizeLimitFor(contentType: string): number {
  const kind = ALLOWED_CONTENT_TYPES[contentType];
  return kind ? SIZE_LIMITS_BYTES[kind] : SIZE_LIMITS_BYTES.image;
}
