import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function handleFrom(email: string | undefined, fallback: string) {
  const base = (email?.split("@")[0] || fallback).replace(/[^a-z0-9_]/gi, "").toLowerCase();
  return base.slice(0, 18) || "member";
}

/**
 * Guarantees the signed-in auth user has a `profiles` row. Runs with admin
 * rights because a brand-new user has no profile yet, so RLS policies that key
 * off `current_profile_id()` cannot let them insert one themselves.
 */
export const ensureMyProfile = createServerFn({ method: "POST" })
  .inputValidator((input: { displayName?: string } | undefined) => input ?? {})
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { userId, claims } = context;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const lookup = async () => {
      const { data: row } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("auth_user_id", userId)
        .maybeSingle();
      return (row?.id as string | undefined) ?? null;
    };

    const existing = await lookup();
    if (existing) return { id: existing, created: false };

    const email = (claims as { email?: string } | null)?.email;
    const handle = handleFrom(email, "member");

    for (let attempt = 0; attempt < 5; attempt++) {
      const username =
        attempt === 0 ? handle : `${handle}${Math.floor(Math.random() * 9000 + 1000)}`;
      const { data: row, error } = await supabaseAdmin
        .from("profiles")
        .insert({
          auth_user_id: userId,
          username,
          display_name: data.displayName?.trim() || handle,
        })
        .select("id")
        .maybeSingle();

      if (!error && row) return { id: row.id as string, created: true };

      // Another request (or a retry) may have created the row first.
      const raced = await lookup();
      if (raced) return { id: raced, created: false };

      // Only a username clash is worth retrying; anything else is fatal.
      if (error && !/profiles_username/i.test(error.message)) {
        throw new Error(error.message);
      }
    }

    throw new Error("Could not create your profile. Please try again.");
  });

/**
 * Paginated, DB-accurate profile tabs. Unlike filtering an already-fetched
 * page of the global feed client-side, each tab is its own targeted query so
 * "Reposts" shows posts *this profile* reposted (not the viewer), "Likes"
 * shows posts *this profile* liked, and "Replies" shows comments this
 * profile made, each joined back to the full post row.
 */
export const getProfileTabPosts = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => {
    const d = (data ?? {}) as {
      profileId?: string;
      tab?: "posts" | "reposts" | "media" | "likes" | "replies";
      limit?: number;
      cursor?: string | null;
    };
    const profileId = String(d.profileId ?? "").trim();
    if (!profileId) throw new Error("Missing profile id");
    const tab = (["posts", "reposts", "media", "likes", "replies"] as const).includes(d.tab as any)
      ? (d.tab as "posts" | "reposts" | "media" | "likes" | "replies")
      : "posts";
    const limit = Number(d.limit);
    return {
      profileId,
      tab,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 15,
      cursor: typeof d.cursor === "string" ? d.cursor : null,
    };
  })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { supabase } = context as any;
    const { profileId, tab, limit, cursor } = data;

    if (tab === "posts" || tab === "media") {
      let q = supabase
        .from("posts")
        .select("*")
        .eq("user_id", profileId)
        .eq("hidden", false)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (cursor) q = q.lt("created_at", cursor);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      let posts = rows ?? [];
      if (tab === "media") {
        posts = posts.filter((p: any) => p.media_url || p.image_gradient);
      }
      const last = posts[posts.length - 1];
      return { posts, nextCursor: last ? last.created_at : null };
    }

    if (tab === "reposts") {
      let q = supabase
        .from("reposts")
        .select("post_id, created_at, posts(*)")
        .eq("user_id", profileId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (cursor) q = q.lt("created_at", cursor);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const posts = (rows ?? [])
        .filter((r: any) => r.posts && !r.posts.hidden)
        .map((r: any) => ({ ...r.posts, repostedAt: r.created_at, repostedBy: profileId }));
      const lastRow = (rows ?? [])[((rows ?? []).length || 1) - 1];
      return { posts, nextCursor: lastRow ? lastRow.created_at : null };
    }

    if (tab === "likes") {
      let q = supabase
        .from("likes")
        .select("post_id, created_at, posts(*)")
        .eq("user_id", profileId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (cursor) q = q.lt("created_at", cursor);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const posts = (rows ?? [])
        .filter((r: any) => r.posts && !r.posts.hidden)
        .map((r: any) => r.posts);
      const lastRow = (rows ?? [])[((rows ?? []).length || 1) - 1];
      return { posts, nextCursor: lastRow ? lastRow.created_at : null };
    }

    // replies: comments this profile made, surfaced with their parent post context.
    let q = supabase
      .from("comments")
      .select("id, content, created_at, post_id, posts(*)")
      .eq("user_id", profileId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (cursor) q = q.lt("created_at", cursor);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const replies = (rows ?? [])
      .filter((r: any) => r.posts && !r.posts.hidden)
      .map((r: any) => ({
        commentId: r.id,
        replyContent: r.content,
        repliedAt: r.created_at,
        post: r.posts,
      }));
    const lastRow = (rows ?? [])[((rows ?? []).length || 1) - 1];
    return { replies, nextCursor: lastRow ? lastRow.created_at : null };
  });
