import type { StorageProvider } from "@/lib/storage/provider.server";
import { createR2Provider, r2IsConfigured } from "@/lib/storage/r2.server";
import { createSupabaseProvider } from "@/lib/storage/supabase.server";

export * from "@/lib/storage/provider.server";

let cached: StorageProvider | null = null;

/** The active storage backend: R2 when configured, otherwise the Supabase 'media' bucket. */
export function getStorageProvider(): StorageProvider {
  if (!cached) {
    cached = r2IsConfigured() ? createR2Provider() : createSupabaseProvider();
  }
  return cached;
}

export function storageBackendName(): "r2" | "supabase" {
  return r2IsConfigured() ? "r2" : "supabase";
}
