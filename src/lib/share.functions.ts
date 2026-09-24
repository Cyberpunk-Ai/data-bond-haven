/**
 * Public, read-only lookups that power shareable links: a single post page and
 * a public profile page. These run on the server so link previews (and search
 * engines) get real titles, descriptions and content.
 */
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

function publicClient() {
  const url = (process.env["SUPABASE_URL"] || process.env["BACKEND_URL"]);
  const key = (process.env["SUPABASE_PUBLISHABLE_KEY"] || process.env["BACKEND_PUBLISHABLE_KEY"]);
  if (!url || !key) throw new Error("Backend is not configured");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { apikey: key } },
  });
}

export type SharedPost = {
  id: string;
  content: string;
  mediaUrl: string | null;
  gradient: string | null;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  author: { id: string; username: string; displayName: string; avatarUrl: string | null };
} | null;

export const getSharedPost = createServerFn({ method: "GET" })
  .inputValidator((input: { id: string }) => ({ id: String(input?.id ?? "") }))
  .handler(async ({ data }): Promise<SharedPost> => {
    const supabase = publicClient() as any;
    const { data: post } = await supabase.from("posts").select("*").eq("id", data.id).maybeSingle();
    if (!post) return null;

    const { data: author } = await supabase
      .from("profiles")
      .select("id, username, display_name, avatar_url")
      .eq("id", post.user_id)
      .maybeSingle();

    return {
      id: String(post.id),
      content: String(post.content ?? ""),
      mediaUrl: post.media_url ?? null,
      gradient: post.image_gradient ?? null,
      createdAt: post.created_at,
      likeCount: Number(post.like_count ?? 0),
      commentCount: Number(post.comment_count ?? 0),
      viewCount: Number(post.view_count ?? 0),
      author: {
        id: String(author?.id ?? post.user_id),
        username: author?.username ?? "someone",
        displayName: author?.display_name ?? "Someone",
        avatarUrl: author?.avatar_url ?? null,
      },
    };
  });

export type SharedProfile = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  followers: number;
  posts: { id: string; content: string; createdAt: string }[];
} | null;

export const getSharedProfile = createServerFn({ method: "GET" })
  .inputValidator((input: { username: string }) => ({
    username: String(input?.username ?? "").replace(/^@/, ""),
  }))
  .handler(async ({ data }): Promise<SharedProfile> => {
    const supabase = publicClient() as any;
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, username, display_name, bio, avatar_url")
      .eq("username", data.username)
      .maybeSingle();
    if (!profile) return null;

    const [{ count }, { data: posts }] = await Promise.all([
      supabase
        .from("follows")
        .select("follower_id", { count: "exact", head: true })
        .eq("target_id", profile.id),
      supabase
        .from("posts")
        .select("id, content, created_at")
        .eq("user_id", profile.id)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    return {
      id: String(profile.id),
      username: profile.username,
      displayName: profile.display_name ?? profile.username,
      bio: profile.bio ?? "",
      avatarUrl: profile.avatar_url ?? null,
      followers: count ?? 0,
      posts: ((posts ?? []) as any[]).map((p) => ({
        id: String(p.id),
        content: String(p.content ?? ""),
        createdAt: p.created_at,
      })),
    };
  });
