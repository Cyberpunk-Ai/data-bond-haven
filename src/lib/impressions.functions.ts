import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Best-effort post impression writer.
 *
 * The browser used to POST straight to `post_impressions` under the viewer's
 * own role. That path is `to authenticated` RLS with an `owns_profile` check,
 * so any hiccup — a stale cached profile whose `auth_user_id` no longer lines
 * up with the live token, a mid-refresh session — surfaced as a burst of 403s
 * while scrolling the feed. Impressions are pure telemetry (the public
 * `posts.view_count` is tallied by the after-insert trigger), so they don't
 * belong in the client's RLS surface at all.
 *
 * Now the viewer's profile id is resolved SERVER-SIDE from the verified bearer
 * token (`requireSupabaseAuth` → `claims.sub` → `profiles.auth_user_id`) and
 * the row is written with the service-role client, which bypasses RLS. Guests
 * never reach the handler (the middleware rejects them, and the caller skips
 * the call entirely when signed out), so there is no anonymous view inflation
 * and no code path that can return 403.
 */
export const recordImpressions = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    const raw = (data as { postIds?: unknown })?.postIds;
    const postIds = Array.isArray(raw)
      ? Array.from(
          new Set(raw.filter((x): x is string => typeof x === "string" && UUID_RE.test(x))),
        ).slice(0, 200)
      : [];
    return { postIds };
  })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    if (data.postIds.length === 0) return { ok: true };
    const { userId } = context as { userId: string };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Resolve the caller's profile from the verified auth id — never trust a
    // client-supplied user_id (which is what let a mismatch 403 before).
    const { data: me } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!me) return { ok: true };

    // Drop any ids that no longer exist so a single stale post can't trip the
    // foreign key and abort the whole batch.
    const { data: existing } = await supabaseAdmin
      .from("posts")
      .select("id")
      .in("id", data.postIds);
    const valid = new Set((existing ?? []).map((p: { id: string }) => p.id));
    const rows = data.postIds
      .filter((post_id) => valid.has(post_id))
      .map((post_id) => ({ post_id, user_id: me.id as string }));
    if (rows.length === 0) return { ok: true };

    const { error } = await supabaseAdmin
      .from("post_impressions")
      .upsert(rows, { onConflict: "post_id,user_id", ignoreDuplicates: true });
    // ignoreDuplicates keeps repeat views silent; a residual error is never
    // surfaced to the user (impressions are best-effort).
    if (error) console.warn("[impressions] upsert failed:", error.message);
    return { ok: true };
  });
