/**
 * Provider for Supabase Storage.
 *
 * Kept so the platform runs with zero extra credentials before an object store
 * is pointed at, and so an existing deployment keeps its objects readable after
 * a switch. Media is split across two buckets — `media-public` for world-readable
 * folders and `media-private` for DM attachments, replays and stories — so a
 * public CDN domain can front the first one without ever exposing the second.
 * The pre-split single bucket (`SUPABASE_MEDIA_BUCKET`, default `media`) stays
 * readable until its bytes are relocated.
 */
import type { StorageProvider, StorageProbe, StorageRead } from "@/lib/storage/provider.server";
import {
  bucketCandidatesForPath,
  bucketForPath,
  isPublicMediaPath,
  mediaBucketNames,
} from "@/lib/media-folders.server";

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * A routed bucket that does not exist yet (the split migration has not been
 * applied on this database) must not fail the upload, so the first miss
 * remembers the answer and stops probing for the rest of the process.
 */
const missingBuckets = new Set<string>();

function isMissingBucketError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /bucket not found|Bucket not found|Invalid bucket/i.test(message);
}

/** Ranged reads need a real HTTP URL: storage-js' download() has no Range support. */
async function signedDownloadUrl(bucketName: string, key: string): Promise<string | null> {
  const supabase = await admin();
  const { data } = await supabase.storage
    .from(bucketName)
    .createSignedUrl(key, 60, { download: key });
  return data?.signedUrl ?? null;
}

function toRead(res: Response, fallbackType: string): Promise<StorageRead> {
  return res.arrayBuffer().then((buffer) => {
    const total = res.headers.get("content-range")?.split("/")[1];
    return {
      body: new Uint8Array(buffer),
      contentType: res.headers.get("content-type") || fallbackType,
      totalSize: Number(total) || buffer.byteLength,
      partial: res.status === 206,
    };
  });
}

export function createSupabaseProvider(): StorageProvider {
  const names = mediaBucketNames();
  const info = {
    id: "supabase" as const,
    label: "Supabase Storage",
    // Display only: the store is the pair, with the pre-split bucket as a read
    // fallback until relocation moves the old bytes.
    bucket: `${names.publicBucket} + ${names.privateBucket}`,
  };

  /**
   * The bucket to write a key into, falling back to the legacy single bucket
   * when the split has not been migrated yet — an upload must never fail
   * because the deployment is one migration behind.
   */
  function writableBucketFor(key: string): string {
    const routed = bucketForPath(key, names);
    if (missingBuckets.has(routed)) return names.legacyBucket;
    return routed;
  }

  return {
    info,
    async put(key, body, contentType) {
      const supabase = await admin();
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      const target = writableBucketFor(key);
      let { error } = await supabase.storage
        .from(target)
        .upload(key, bytes, { upsert: true, contentType });
      if (error && target !== names.legacyBucket && isMissingBucketError(error)) {
        missingBuckets.add(target);
        console.warn(
          `[storage] bucket "${target}" is not available yet (${names.publicBucket}/` +
            `${names.privateBucket} are created by the media bucket migration); ` +
            `writing to "${names.legacyBucket}" instead.`,
        );
        ({ error } = await supabase.storage
          .from(names.legacyBucket)
          .upload(key, bytes, { upsert: true, contentType }));
      }
      if (error) throw new Error(error.message || "Storage upload failed");
      return { key };
    },
    async get(key) {
      // Tried in routing order: the bucket the folder belongs in, then the
      // legacy bucket, so objects uploaded before the split keep rendering.
      for (const bucketName of bucketCandidatesForPath(key, names)) {
        try {
          const supabase = await admin();
          const { data, error } = await supabase.storage.from(bucketName).download(key);
          if (error || !data) continue;
          const body = new Uint8Array(await data.arrayBuffer());
          return {
            body,
            contentType: data.type || "application/octet-stream",
            totalSize: body.byteLength,
            partial: false,
          };
        } catch (err) {
          // Missing server credentials (SUPABASE_SERVICE_ROLE_KEY) surface here
          // in local dev — answer 404 instead of an unhandled 500 error page.
          console.error(
            `[media] storage download failed from "${bucketName}":`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      return null;
    },
    async getRange(key, start, end) {
      const range = `bytes=${start}-${end === undefined ? "" : Math.max(start, end)}`;
      for (const bucketName of bucketCandidatesForPath(key, names)) {
        const url = await signedDownloadUrl(bucketName, key);
        if (!url) continue;
        const res = await fetch(url, { headers: { range } });
        if (res.status === 404 || res.status === 403) continue;
        if (!res.ok && res.status !== 206) continue;
        return toRead(res, "application/octet-stream");
      }
      return null;
    },
    async delete(keys) {
      const targets = keys.filter(Boolean);
      if (!targets.length) return [];
      const supabase = await admin();
      // Group by the bucket each key is expected in, then remove from every
      // candidate: an object may still be sitting in the pre-split bucket, and
      // storage-js reports a missing key as an error entry rather than throwing.
      const groups = new Map<string, string[]>();
      for (const key of targets) {
        for (const bucketName of bucketCandidatesForPath(key, names)) {
          const list = groups.get(bucketName) ?? [];
          list.push(key);
          groups.set(bucketName, list);
        }
      }
      const removed = new Set<string>();
      for (const [bucketName, bucketKeys] of groups) {
        // storage-js typings for `remove()` drift across versions; the runtime
        // shape is `{ path, error }[]`, so read it defensively.
        const { data, error } = await supabase.storage.from(bucketName).remove(bucketKeys);
        if (error) {
          console.error(`Supabase storage delete failed on "${bucketName}":`, error.message);
          continue;
        }
        for (const entry of (data ?? []) as Array<{ path?: string; error?: unknown }>) {
          if (entry.path && !entry.error) removed.add(entry.path);
        }
      }
      return [...removed];
    },
    async stat(key) {
      for (const bucketName of bucketCandidatesForPath(key, names)) {
        const supabase = await admin();
        const { data, error } = await supabase.storage.from(bucketName).info(key);
        if (error || !data) continue;
        // Supabase reports `info()` fields at the top level and leaves
        // `metadata` empty; the nested `size`/`mimetype` shape only appears in
        // `list()` results, so reading just the nested one reported every object
        // as 0 bytes / octet-stream (suffix byte-range reads broke).
        const meta = data as unknown as {
          size?: number;
          contentType?: string;
          mimetype?: string;
          metadata?: { size?: number; mimetype?: string };
        };
        return {
          size: Number(meta.size ?? meta.metadata?.size ?? 0),
          contentType:
            meta.contentType ||
            meta.mimetype ||
            meta.metadata?.mimetype ||
            "application/octet-stream",
        };
      }
      return null;
    },
    /**
     * Public bucket objects are readable straight off Supabase's own public
     * path — no token, no proxy hop. Private keys answer null so the reader
     * never redirects a DM attachment into a world-readable URL.
     */
    publicUrl(key) {
      if (!isPublicMediaPath(key)) return null;
      const base = env("SUPABASE_URL", "VITE_SUPABASE_URL");
      if (!base) return null;
      const bucketName = missingBuckets.has(names.publicBucket)
        ? names.legacyBucket
        : names.publicBucket;
      if (bucketName === names.legacyBucket) return null; // legacy bucket is not public
      return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${bucketName}/${key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
    },
    async list(cursor) {
      const supabase = await admin();
      // Supabase lists one folder at a time and returns sub-folders as
      // id-less entries, so the folders still to walk travel inside the cursor.
      // The bucket still to walk travels with them: every bucket in the layout
      // is enumerated so a reconciliation sees all of the store's bytes.
      const state: { queue: string[]; prefix: string; offset: number; buckets: string[] } = cursor
        ? JSON.parse(cursor)
        : { queue: [], prefix: "", offset: 0, buckets: walkableBuckets(names) };
      const keys: string[] = [];
      // The guard bounds one page of work, not the bucket size.
      for (let hops = 0; hops < 2000 && keys.length < 500; hops++) {
        const bucketName = state.buckets[state.buckets.length - 1];
        if (!bucketName) return { keys, nextCursor: null };
        const { data, error } = await supabase.storage.from(bucketName).list(state.prefix, {
          limit: 200,
          offset: state.offset,
          sortBy: { column: "name", order: "asc" },
        });
        if (error) {
          // A bucket that does not exist yet is simply skipped, not fatal.
          if (isMissingBucketError(error)) {
            missingBuckets.add(bucketName);
            state.buckets.pop();
            state.prefix = "";
            state.offset = 0;
            state.queue = [];
            continue;
          }
          throw new Error(error.message || "Storage listing failed");
        }
        if (!data?.length) {
          const next = state.queue.pop();
          if (next === undefined) {
            state.buckets.pop();
            state.prefix = "";
            state.offset = 0;
            if (!state.buckets.length) return { keys, nextCursor: null };
            continue;
          }
          state.prefix = next;
          state.offset = 0;
          continue;
        }
        for (const item of data as Array<{ id?: string | null; name: string }>) {
          const path = state.prefix ? `${state.prefix}/${item.name}` : item.name;
          if (item.id) keys.push(path);
          else state.queue.push(path);
        }
        state.offset += data.length;
      }
      return { keys, nextCursor: JSON.stringify(state) };
    },
    async verifyAccess(): Promise<StorageProbe> {
      // Any one reachable bucket means the store is usable: a fresh project has
      // only the split pair, an old one may still have only the legacy bucket.
      const supabase = await admin();
      let lastDetail = "no buckets configured";
      for (const bucketName of walkableBuckets(names)) {
        try {
          const { error } = await supabase.storage.from(bucketName).list("", { limit: 1 });
          if (!error) return { ok: true };
          lastDetail = error.message.slice(0, 80);
        } catch (err) {
          lastDetail = err instanceof Error ? err.message.slice(0, 80) : "error";
        }
      }
      return { ok: false, detail: lastDetail };
    },
  };
}

/**
 * Buckets a listing walks: the two routed ones first (where new bytes live),
 * then the legacy bucket if it is not one of them.
 */
function walkableBuckets(names: ReturnType<typeof mediaBucketNames>): string[] {
  return [...new Set([names.publicBucket, names.privateBucket, names.legacyBucket])].filter(
    Boolean,
  );
}
