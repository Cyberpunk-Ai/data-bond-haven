/**
 * Fallback provider for the Supabase 'media' bucket.
 *
 * Kept so the platform runs with zero extra credentials before an object store
 * is pointed at, and so an existing deployment keeps its objects readable after
 * a switch. The bucket name is configurable (`SUPABASE_MEDIA_BUCKET`) because
 * the default `media` is only a convention.
 */
import type { StorageProvider, StorageProbe, StorageRead } from "@/lib/storage/provider.server";

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function bucket(): string {
  return env("SUPABASE_MEDIA_BUCKET", "VITE_MEDIA_BUCKET") ?? "media";
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Ranged reads need a real HTTP URL: storage-js' download() has no Range support. */
async function signedDownloadUrl(key: string): Promise<string | null> {
  const supabase = await admin();
  const { data } = await supabase.storage
    .from(bucket())
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
  const info = { id: "supabase" as const, label: "Supabase Storage", bucket: bucket() };

  return {
    info,
    async put(key, body, contentType) {
      const supabase = await admin();
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      const { error } = await supabase.storage
        .from(bucket())
        .upload(key, bytes, { upsert: true, contentType });
      if (error) throw new Error(error.message || "Storage upload failed");
      return { key };
    },
    async get(key) {
      try {
        const supabase = await admin();
        const { data, error } = await supabase.storage.from(bucket()).download(key);
        if (error || !data) return null;
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
        console.error("[media] storage download failed:", err instanceof Error ? err.message : err);
        return null;
      }
    },
    async getRange(key, start, end) {
      const url = await signedDownloadUrl(key);
      if (!url) return null;
      const range = `bytes=${start}-${end === undefined ? "" : Math.max(start, end)}`;
      const res = await fetch(url, { headers: { range } });
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok && res.status !== 206) return null;
      return toRead(res, "application/octet-stream");
    },
    async delete(keys) {
      const targets = keys.filter(Boolean);
      if (!targets.length) return [];
      const supabase = await admin();
      // storage-js typings for `remove()` drift across versions; the runtime
      // shape is `{ path, error }[]`, so read it defensively.
      const { data, error } = await supabase.storage.from(bucket()).remove(targets);
      if (error) {
        console.error("Supabase storage delete failed:", error.message);
        return [];
      }
      return ((data ?? []) as Array<{ path?: string }>)
        .map((d) => d.path)
        .filter((p): p is string => Boolean(p));
    },
    async stat(key) {
      const supabase = await admin();
      const { data, error } = await supabase.storage.from(bucket()).info(key);
      if (error || !data) return null;
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
    },
    async list(cursor) {
      const supabase = await admin();
      // Supabase lists one folder at a time and returns sub-folders as
      // id-less entries, so the folders still to walk travel inside the cursor.
      const state: { queue: string[]; prefix: string; offset: number } = cursor
        ? JSON.parse(cursor)
        : { queue: [], prefix: "", offset: 0 };
      const keys: string[] = [];
      // The guard bounds one page of work, not the bucket size.
      for (let hops = 0; hops < 500 && keys.length < 500; hops++) {
        const { data, error } = await supabase.storage.from(bucket()).list(state.prefix, {
          limit: 200,
          offset: state.offset,
          sortBy: { column: "name", order: "asc" },
        });
        if (error) throw new Error(error.message || "Storage listing failed");
        if (!data?.length) {
          const next = state.queue.pop();
          if (next === undefined) return { keys, nextCursor: null };
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
      try {
        const supabase = await admin();
        const { error } = await supabase.storage.from(bucket()).list("", { limit: 1 });
        if (error) return { ok: false, detail: error.message.slice(0, 80) };
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message.slice(0, 80) : "error" };
      }
    },
  };
}
