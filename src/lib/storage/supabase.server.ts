import type { StorageProvider } from "@/lib/storage/provider.server";

/** Fallback provider that writes to the existing private Supabase 'media' bucket. */
export function createSupabaseProvider(): StorageProvider {
  return {
    async put(key, body, contentType) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      const { error } = await supabaseAdmin.storage
        .from("media")
        .upload(key, bytes, { upsert: true, contentType });
      if (error) throw new Error(error.message || "Storage upload failed");
      return { key };
    },
    async get(key) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin.storage.from("media").download(key);
      if (error || !data) return null;
      const contentType = data.type || "application/octet-stream";
      const body = new Uint8Array(await data.arrayBuffer());
      return { body, contentType };
    },
    async delete(keys) {
      const targets = keys.filter(Boolean);
      if (!targets.length) return [];
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      // storage-js typings for `remove()` drift across versions; the runtime
      // shape is `{ path, error }[]`, so read it defensively.
      const { data, error } = await supabaseAdmin.storage.from("media").remove(targets);
      if (error) {
        console.error("Supabase storage delete failed:", error.message);
        return [];
      }
      return ((data ?? []) as Array<{ path?: string }>)
        .map((d) => d.path)
        .filter((p): p is string => Boolean(p));
    },
    async stat(key) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin.storage.from("media").info(key);
      if (error || !data) return null;
      const info = data as unknown as {
        mimetype?: string;
        metadata?: { size?: number };
      };
      return {
        size: Number(info.metadata?.size ?? 0),
        contentType: info.mimetype || "application/octet-stream",
      };
    },
  };
}
