/**
 * Client-callable media deletion (M3 — plan §4.5).
 *
 * The browser data layer deletes its row (RLS-scoped) and then calls here to
 * reclaim the bytes. Storage deletion is a service-role capability, so it must
 * cross this server boundary — but we refuse to delete arbitrary keys: only
 * objects recorded in `media_objects` as owned by the caller's profile are
 * removed. Anything not owned (or not tracked) is silently skipped, which makes
 * this endpoint useless for enumerating or destroying other users' media.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Server-only modules are imported lazily inside handlers: this file is
// reachable from the client bundle, so top-level `.server.ts` imports are not
// allowed.
async function admin() {
  const { adminDb } = await import("@/integrations/supabase/client.server");
  return adminDb();
}

async function myProfileId(supabase: any, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("profiles")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return data?.id ? String(data.id) : null;
}

/**
 * Delete media objects the caller owns, given their stored `/api/public/media/…`
 * URLs (or raw keys). Returns how many were actually removed.
 */
export const deleteMyMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ urls: z.array(z.string().nullable()).max(100) }).parse(d))
  .handler(async ({ data, context }) => {
    const urls = data.urls;
    if (urls.length === 0) return { removed: 0 };

    const profileId = await myProfileId(context.supabase, context.userId);
    if (!profileId) return { removed: 0 };

    const { getStorageProvider, mediaKeyFromUrl } = await import("@/lib/storage/index.server");
    // A caller may hand over a stored column value verbatim, and those can hold
    // several comma-joined urls (a multi-image post), so split before mapping.
    const keys = Array.from(
      new Set(
        urls
          .flatMap((u) => (u ?? "").split(","))
          .map((u) => mediaKeyFromUrl(u.trim() || undefined))
          .filter((k): k is string => Boolean(k)),
      ),
    );
    if (keys.length === 0) return { removed: 0 };

    // Only keys this caller owns are eligible — an attacker-supplied key that
    // isn't theirs simply isn't returned and so is never deleted.
    const { data: owned, error } = await (
      await admin()
    )
      .from("media_objects")
      .select("path")
      .in("path", keys)
      .eq("owner_profile_id", profileId);
    if (error || !owned?.length) return { removed: 0 };

    const ownedKeys = (owned as Array<{ path: string }>).map((r) => r.path);
    const removed = await (await getStorageProvider()).delete(ownedKeys);
    const { error: rowError } = await (
      await admin()
    )
      .from("media_objects")
      .delete()
      .in("path", ownedKeys);
    // The bytes are already gone at this point, so a surviving row is a permanent
    // pointer at an object that no longer exists — report it instead of returning
    // a tidy count that hides the leak.
    if (rowError) console.error("media_objects rows not reclaimed:", rowError.message);
    return { removed: removed.length };
  });
