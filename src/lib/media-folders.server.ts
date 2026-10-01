/**
 * One source of truth for what a media folder means.
 *
 * The upload route, the read proxy, the signed-URL issuer and the storage
 * providers all need the same answer to "is this object world-readable?", and
 * the bucket layout is derived from that answer: public folders live in a
 * genuinely public bucket (its own CDN domain can serve the bytes), private
 * folders live in a private bucket where nothing is readable without going
 * through an authorization check first.
 *
 * Nothing here may be duplicated in another module — a folder list that drifts
 * between the writer and the reader is how a private file ends up public.
 */

/** How a finished object may be read. */
export type MediaVisibility = "public" | "authed" | "private";

export const MEDIA_FOLDER_VISIBILITY: Record<string, MediaVisibility> = {
  // World-readable: everything a public profile or post page shows.
  avatars: "public",
  posts: "public",
  media: "public",
  // Addressed by a public URL, readable only inside a purpose-written rule
  // (a story's author and their follow network, mirroring the rows' RLS).
  stories: "authed",
  // Never world-readable: DM attachments and Space replays.
  messages: "private",
  recordings: "private",
};

/** Folders an upload may ask for; anything else is refused. */
export const UPLOAD_FOLDERS: readonly string[] = Object.keys(MEDIA_FOLDER_VISIBILITY);

export function isUploadFolder(folder: string): boolean {
  return Object.prototype.hasOwnProperty.call(MEDIA_FOLDER_VISIBILITY, folder);
}

/** `posts/<profile>/<file>.jpg` → `posts`. */
export function folderOfPath(path: string): string {
  return (path ?? "").split("/")[0] ?? "";
}

/** Visibility of an object path, or null when the folder is unknown. */
export function visibilityOfPath(path: string): MediaVisibility | null {
  const folder = folderOfPath(path);
  return isUploadFolder(folder) ? MEDIA_FOLDER_VISIBILITY[folder] : null;
}

/**
 * Only a declared public folder may ever be handed to a public bucket or a
 * public CDN URL. Unknown folders fail closed to private — a new media type is
 * world-readable only after someone adds it here on purpose.
 */
export function isPublicMediaPath(path: string): boolean {
  return visibilityOfPath(path) === "public";
}

/** Anything that is not public travels through the authorized reader. */
export function isPrivateMediaPath(path: string): boolean {
  const visibility = visibilityOfPath(path);
  return visibility !== null && visibility !== "public";
}

/** Buckets this deployment routes to. Names are configurable, defaults are not shared. */
export interface MediaBuckets {
  publicBucket: string;
  privateBucket: string;
  /** The single pre-split bucket, kept readable until its bytes are relocated. */
  legacyBucket: string;
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

export function mediaBucketNames(): MediaBuckets {
  return {
    publicBucket: env("MEDIA_PUBLIC_BUCKET", "SUPABASE_MEDIA_PUBLIC_BUCKET") ?? "media-public",
    privateBucket: env("MEDIA_PRIVATE_BUCKET", "SUPABASE_MEDIA_PRIVATE_BUCKET") ?? "media-private",
    legacyBucket: env("SUPABASE_MEDIA_BUCKET", "VITE_MEDIA_BUCKET") ?? "media",
  };
}

/** The bucket a key belongs in: public folders to the public bucket, rest private. */
export function bucketForPath(path: string, names: MediaBuckets = mediaBucketNames()): string {
  return isPublicMediaPath(path) ? names.publicBucket : names.privateBucket;
}

/**
 * Every bucket worth looking at for a key, in order: the bucket the layout says
 * it is in, then the legacy single bucket (objects uploaded before the split),
 * then the other routed bucket (a folder whose visibility changed later).
 */
export function bucketCandidatesForPath(
  path: string,
  names: MediaBuckets = mediaBucketNames(),
): string[] {
  const routed = bucketForPath(path, names);
  const other = routed === names.publicBucket ? names.privateBucket : names.publicBucket;
  return [...new Set([routed, names.legacyBucket, other])].filter(Boolean);
}
