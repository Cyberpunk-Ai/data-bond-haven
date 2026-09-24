import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Owner-only post edit. Stamps `edited_at` so the UI can show an "Edited"
 * marker, and the row update flows to other viewers through the existing
 * `postgres_changes`/broadcast realtime wiring already used for posts.
 */
export const editPost = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    const d = (data ?? {}) as { postId?: string; content?: string; tags?: string[] };
    const postId = String(d.postId ?? "").trim();
    const content = String(d.content ?? "").trim();
    if (!postId) throw new Error("Missing post id");
    if (!content) throw new Error("Post content can't be empty");
    if (content.length > 5000) throw new Error("Post is too long");
    const tags = Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === "string").slice(0, 10) : undefined;
    return { postId, content, tags };
  })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as any;

    const { data: me } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!me) throw new Error("Profile not found");

    const { data: existing } = await supabase
      .from("posts")
      .select("id, user_id")
      .eq("id", data.postId)
      .maybeSingle();
    if (!existing) throw new Error("Post not found");
    if (existing.user_id !== me.id) throw new Error("You can only edit your own posts");

    const patch: Record<string, unknown> = {
      content: data.content,
      edited_at: new Date().toISOString(),
    };
    if (data.tags) patch.tags = data.tags;

    const { data: updated, error } = await supabase
      .from("posts")
      .update(patch)
      .eq("id", data.postId)
      .select("*")
      .maybeSingle();

    if (error) throw new Error(error.message);
    return { post: updated };
  });
