/**
 * Media reclamation (M3 — plan §4.5).
 *
 * Two complementary mechanisms live here:
 *   * `deleteStoredMedia` — eager deletion wired into the post/story/message
 *     delete paths, so the common cases reclaim bytes immediately.
 *   * `runMediaGarbageCollection` — a nightly safety net that deletes any
 *     tracked object whose referencing row no longer exists. This catches the
 *     paths eager deletion cannot (a crashed client, an abandoned upload, and,
 *     once it ships, account erasure) — "media_objects rows with no referent".
 *
 * Storage deletion is a service-role concern (the browser can't delete arbitrary
 * objects), so everything here runs server-side via the admin client + provider.
 */

import { getStorageProvider, mediaKeyFromUrl } from "@/lib/storage/index.server";
import { splitMediaList } from "@/lib/media-list";

/** The `/api/public/media/<key>` URL the app stores in referencing columns. */
function mediaUrlForPath(path: string): string {
  return `/api/public/media/${path}`;
}

/**
 * A media column may hold SEVERAL urls — the composer joins a multi-image
 * post's attachments with commas (`posts.media_url`, and the same shape on
 * stories/messages). Every consumer here splits first, because treating the
 * joined string as one reference made every image of a multi-image post look
 * unreferenced: the nightly sweep would have reclaimed the bytes under a live
 * post, and an owner deleting their post left those bytes behind instead.
 */
function splitMediaRefs(value: unknown): string[] {
  // The shared, data-URL-aware splitter: a base64 fallback keeps its own comma
  // instead of being mistaken for two references.
  return splitMediaList(value);
}

/**
 * Delete the underlying objects for the given media URLs (or raw keys) and drop
 * their `media_objects` rows. Unknown/empty URLs are ignored; failures are
 * logged, not thrown, so a storage outage never blocks a user-facing delete.
 * Returns the number of objects actually removed from storage.
 */
export async function deleteStoredMedia(urls: Array<string | null | undefined>): Promise<number> {
  const keys = Array.from(
    new Set(
      urls
        .flatMap((u) => splitMediaRefs(u))
        .map((u) => mediaKeyFromUrl(u))
        .filter((k): k is string => Boolean(k)),
    ),
  );
  if (keys.length === 0) return 0;

  try {
    const provider = getStorageProvider();
    const removed = await provider.delete(keys);
    // Reclaim the DB rows whether or not the object still existed.
    const { adminDb } = await import("@/integrations/supabase/client.server");
    const { error } = await adminDb().from("media_objects").delete().in("path", keys);
    // The bytes are already gone, so a refused delete leaves rows that point at
    // nothing (and get retried by the next GC sweep). Say so instead of failing
    // quietly — supabase-js reports a rejected write as a resolved promise.
    if (error) console.error("deleteStoredMedia: media_objects rows left behind:", error);
    return removed.length;
  } catch (err) {
    console.error("deleteStoredMedia failed:", err);
    return 0;
  }
}

// Every column that can hold a media URL. A tracked object is considered "in
// use" while any of these still references it. Kept as data so adding a new
// media-bearing table is a one-line change rather than a hunt through the GC.
// Columns listed here may carry several comma-joined urls (see splitMediaRefs).
const REFERENCING_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "posts", column: "media_url" },
  { table: "stories", column: "media_url" },
  { table: "messages", column: "media_url" },
  { table: "profiles", column: "avatar_url" },
  { table: "spaces", column: "recording_url" },
];

/**
 * Collect every media URL still referenced by a live row. Returns a Set for
 * O(1) membership testing by {@link runMediaGarbageCollection}.
 */
async function collectReferencedUrls(db: any): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const { table, column } of REFERENCING_COLUMNS) {
    try {
      // A large deployment would page this; the app's tables are small enough to
      // read the non-null URLs in one pass per column.
      const { data, error } = await db.from(table).select(column).not(column, "is", null);
      if (error) {
        console.error(`GC reference scan failed on ${table}.${column}:`, error);
        continue;
      }
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        for (const url of splitMediaRefs(row[column])) referenced.add(url);
      }
    } catch (err) {
      // A table/column missing in a not-yet-migrated environment must not abort
      // the whole sweep.
      console.error(`GC reference scan threw on ${table}.${column}:`, err);
    }
  }
  return referenced;
}

export interface MediaGcResult {
  scanned: number;
  deleted: number;
  errors: number;
}

/**
 * Delete tracked objects that no row references any more. Objects are only
 * reclaimed once they are older than `graceSeconds`, so an upload that has been
 * written but whose referring row is still being created (a race) is not culled.
 */
export async function runMediaGarbageCollection(graceSeconds = 3600): Promise<MediaGcResult> {
  const { adminDb } = await import("@/integrations/supabase/client.server");
  const db = adminDb();

  const cutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();
  const { data: objects, error } = await db
    .from("media_objects")
    .select("path, created_at")
    .lt("created_at", cutoff);
  if (error) {
    console.error("GC: could not read media_objects:", error);
    return { scanned: 0, deleted: 0, errors: 1 };
  }

  const rows = (objects ?? []) as Array<{ path: string }>;
  if (rows.length === 0) return { scanned: 0, deleted: 0, errors: 0 };

  const referenced = await collectReferencedUrls(db);
  const orphans = rows.map((r) => r.path).filter((path) => !referenced.has(mediaUrlForPath(path)));

  let deleted = 0;
  let errors = 0;
  // Reclaim in batches so one bad object key doesn't abort the sweep.
  const CHUNK = 100;
  for (let i = 0; i < orphans.length; i += CHUNK) {
    const batch = orphans.slice(i, i + CHUNK);
    try {
      const provider = getStorageProvider();
      await provider.delete(batch);
      const { error } = await db.from("media_objects").delete().in("path", batch);
      // Only count the batch as reclaimed if the tracking rows actually went; a
      // rejected delete would otherwise report objects this sweep did not finish.
      if (error) {
        errors += 1;
        console.error("GC: media_objects rows still present after delete:", error);
      } else {
        deleted += batch.length;
      }
    } catch (err) {
      errors += 1;
      console.error("GC batch failed:", err);
    }
  }

  // Opportunistically trim old rate-limit windows while the cron is running.
  try {
    await db.rpc("prune_rate_limits");
  } catch {
    /* non-fatal */
  }

  return { scanned: rows.length, deleted, errors };
}
