/**
 * Media reclamation (M3 — plan §4.5).
 *
 * Two complementary mechanisms live here:
 *   * `deleteStoredMedia` — eager deletion the story-expiry and message
 *     paths call to reclaim bytes immediately. (Post deletion deliberately does
 *     NOT erase bytes — see migration 20261006000001 — so a feed post's media
 *     outlives the row and stays resolvable for old embeds and links.)
 *   * `runMediaGarbageCollection` — a nightly safety net that deletes any
 *     tracked object whose referencing row no longer exists. This catches the
 *     paths eager deletion cannot (a crashed client, an abandoned upload, and,
 *     once it ships, account erasure) — "media_objects rows with no referent".
 *     Permanent feed media (see PERMANENT_MEDIA_FOLDERS) is exempt from this.
 *
 * Storage deletion is a service-role concern (the browser can't delete arbitrary
 * objects), so everything here runs server-side via the admin client + provider.
 */

import { getStorageProvider, mediaKeyFromUrl } from "@/lib/storage/index.server";
import { splitMediaList } from "@/lib/media-list";
import { folderOfPath } from "@/lib/media-folders.server";

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
  { table: "workspaces", column: "avatar_url" },
];

/** Rows per read while paging a column. Bounds one request, not the table. */
const GC_PAGE = 1000;

/**
 * Folders whose objects are PERMANENT: the garbage collector may never reclaim
 * them, no matter what its reference scan concludes. This is the product
 * contract for public feed media — a post's images and videos stay up for
 * decades. Nothing automated erases them: the nightly GC skips these folders
 * entirely, and even deleting the post deliberately leaves the bytes in place
 * (see migration 20261006000001), so an embed or link minted years ago still
 * resolves. Feed media is therefore immortal on every current code path; the
 * only thing that could remove it is a future explicit admin media-purge.
 *
 * Exempting by folder (not by the scan) is deliberate: it makes the GC
 * structurally incapable of touching feed media, so the guarantee survives even
 * a future bug that gets the "what is in use" picture wrong again. The legacy
 * `media` folder is included because pre-split post attachments live there.
 * Avatars, stories, DM attachments and Space replays stay reclaimable — they
 * are replaceable or genuinely expiring, not permanent feed content.
 */
const PERMANENT_MEDIA_FOLDERS: ReadonlySet<string> = new Set(["posts", "media"]);

interface ReferenceScan {
  /** Storage keys extracted from every live reference (matched against media_objects.path). */
  keys: Set<string>;
  /** The exact strings a media column holds, as a belt-and-braces second match. */
  raws: Set<string>;
  /** False if any scan errored — an incomplete picture must never drive a delete. */
  complete: boolean;
}

/**
 * Collect every media reference still held by a live row.
 *
 * Each column is PAGED: a single unpaged read is capped by PostgREST's
 * max-rows, so once a table outgrew that cap the extra rows were invisible and
 * their still-live media looked orphaned and got reclaimed — media that used to
 * render silently disappearing as the app grew. Paging removes that whole class
 * of loss.
 *
 * On ANY scan error the result is marked incomplete and the caller reclaims
 * nothing. Previously a transient read failure on, say, `posts.media_url` was
 * logged and `continue`d, so every post's attachment was treated as unreferenced
 * and deleted — a single network blip could wipe the feed's media. Fail-closed
 * instead: never delete on an unsure picture of what is in use.
 */
async function collectReferences(db: any): Promise<ReferenceScan> {
  const keys = new Set<string>();
  const raws = new Set<string>();
  let complete = true;
  for (const { table, column } of REFERENCING_COLUMNS) {
    for (let from = 0; ; from += GC_PAGE) {
      try {
        const { data, error } = await db
          .from(table)
          .select(column)
          .not(column, "is", null)
          .order("id", { ascending: true })
          .range(from, from + GC_PAGE - 1);
        if (error) {
          console.error(`GC reference scan failed on ${table}.${column} @${from}:`, error);
          complete = false;
          break;
        }
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        for (const row of rows) {
          for (const url of splitMediaRefs(row[column])) {
            raws.add(url);
            const key = mediaKeyFromUrl(url);
            if (key) keys.add(key);
          }
        }
        if (rows.length < GC_PAGE) break; // reached the last page
      } catch (err) {
        // A table/column missing in a not-yet-migrated environment, or a thrown
        // read, must not be mistaken for "nothing here references media".
        console.error(`GC reference scan threw on ${table}.${column} @${from}:`, err);
        complete = false;
        break;
      }
    }
  }
  return { keys, raws, complete };
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

  // Strip permanent feed media BEFORE anything else: it is never a deletion
  // candidate, so even a wrong or incomplete reference scan below cannot reach
  // a post's images/videos. Only replaceable/expiring folders are reclaimable.
  const reclaimable = rows
    .map((r) => r.path)
    .filter((path) => !PERMANENT_MEDIA_FOLDERS.has(folderOfPath(path)));

  let orphans: string[] = [];
  if (reclaimable.length > 0) {
    const refs = await collectReferences(db);
    if (!refs.complete) {
      // Fail closed: if we could not read the full picture of what is in use, we
      // are not allowed to delete — reclaiming a live attachment is far worse
      // than leaving a true orphan on the store for one more night.
      console.error("GC: reference scan incomplete — skipping reclaim this run");
      return { scanned: rows.length, deleted: 0, errors: 1 };
    }
    orphans = reclaimable.filter(
      (path) => !refs.keys.has(path) && !refs.raws.has(mediaUrlForPath(path)),
    );
  }

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
