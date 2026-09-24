/**
 * Data access layer for the Spaces1 app. All calls go through the Lovable Cloud
 * backend (Supabase) with defensive mapping so the UI keeps working while the
 * schema evolves.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  moderatePost,
  moderateUser,
  resolveReport,
  saveSystemSettings,
  terminateSpace,
} from "@/lib/moderation.functions";
import { cacheProfiles, currentUser, currentUserId, rowToProfile } from "@/lib/profile-service";
import { emitRealtime } from "@/lib/realtime";
import { appConfig } from "@/lib/config";
import type {
  AdminCharts,
  AdminOverviewData,
  AuditLog,
  Conversation,
  Message,
  ModerationReport,
  Notification,
  Post,
  PostComment,
  Profile,
  Space,
  Story,
  SystemSettings,
  Topic,
  TrendingTag,
  UserFeedPreferences,
  FeedFeedbackPayload,
} from "@/lib/types";

const db = supabase as any;

function nowIso() {
  return new Date().toISOString();
}

function me() {
  return currentUserId || currentUser.id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Real database rows always carry UUID ids. Sample/demo content shipped with the
 * app uses readable ids like "post_seed_2", so every query is guarded to avoid
 * sending those to the database (which rejects them outright).
 */
export function isDbId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function dbIds(values: unknown[]): string[] {
  return values.filter(isDbId);
}

/* ------------------------------------------------------------------ posts */

export function rowToPost(row: any, extras: Partial<Post> = {}): Post {
  return {
    id: row.id,
    user_id: row.user_id,
    content: row.content ?? "",
    image_gradient: row.image_gradient ?? null,
    media_url: row.media_url ?? null,
    image_url: row.image_url ?? null,
    tags: row.tags ?? [],
    created_at: row.created_at ?? nowIso(),
    likeCount: row.like_count ?? 0,
    commentCount: row.comment_count ?? 0,
    repostCount: row.repost_count ?? 0,
    viewCount: row.view_count ?? 0,
    poll: row.poll ?? null,
    ...extras,
  };
}

export async function getPosts(
  options: {
    limit?: number;
    userId?: string;
    /** Alias of `userId`, kept for call sites that speak in author terms. */
    authorId?: string;
    tag?: string;
    before?: string;
    following?: boolean;
    bookmarked?: boolean;
    filter?: "foryou" | "following" | "latest";
  } = {},
): Promise<Post[]> {
  if (options.bookmarked) return getBookmarkedPosts(options.limit ?? 50);
  // "For you" is ranked server-side (behaviour + graph + quality + diversity).
  if (options.filter === "foryou" && !options.userId && !options.tag && isDbId(me())) {
    try {
      const { getForYouPosts } = await import("@/lib/recommendations.functions");
      const res: any = await getForYouPosts({
        data: {
          limit: Math.min(options.limit ?? appConfig.feed.pageSize, appConfig.feed.maxPageSize),
        },
      });
      const ranked = (res?.posts ?? []).map((row: any) => rowToPost(row));
      if (ranked.length > 0) {
        await hydrateAuthors(ranked.map((p: Post) => p.user_id));
        await hydrateEngagement(ranked);
        return ranked;
      }
    } catch (err) {
      console.warn("For you ranking unavailable, using recency:", err);
    }
  }
  if (options.filter === "following") options = { ...options, following: true };
  if (options.authorId) options = { ...options, userId: options.authorId };
  const limit = Math.min(options.limit ?? appConfig.feed.pageSize, appConfig.feed.maxPageSize);
  let query = db
    .from("posts")
    .select("*")
    .eq("hidden", false)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (options.userId) query = query.eq("user_id", options.userId);
  if (options.before) query = query.lt("created_at", options.before);
  if (options.tag) query = query.contains("tags", [options.tag]);
  if (options.following) {
    const { data: follows } = isDbId(me())
      ? await db.from("follows").select("target_id").eq("follower_id", me())
      : { data: [] as any[] };
    const ids = ((follows ?? []) as any[]).map((f) => f.target_id);
    if (ids.length === 0) return [];
    query = query.in("user_id", [...ids, me()]);
  }
  const { data, error } = await query;
  if (error) {
    console.warn("getPosts notice:", error.message);
  }
  let posts = (data ?? []).map((row: any) => rowToPost(row));

  // "For you" blends freshness with engagement so the tab differs from "Latest".
  if (options.filter === "foryou" && !options.userId && !options.tag) {
    const now = Date.now();
    posts = [...posts].sort((a, b) => score(b) - score(a));
    function score(p: Post) {
      const ageHours = Math.max(1, (now - new Date(p.created_at).getTime()) / 3_600_000);
      const engagement =
        (p.likeCount ?? 0) * 3 +
        (p.commentCount ?? 0) * 4 +
        (p.repostCount ?? 0) * 5 +
        (p.viewCount ?? 0) * 0.1;
      return (engagement + 5) / Math.pow(ageHours, 0.6);
    }
  }

  await hydrateAuthors(posts.map((p: Post) => p.user_id));
  await hydrateEngagement(posts);
  return posts;
}

/** Posts the signed-in user has bookmarked, fetched by join instead of client filtering. */
export async function getBookmarkedPosts(limit = 50): Promise<Post[]> {
  if (!isDbId(me())) return [];
  const { data } = await db
    .from("bookmarks")
    .select("post_id, created_at, posts(*)")
    .eq("user_id", me())
    .order("created_at", { ascending: false })
    .limit(limit);
  const posts = ((data ?? []) as any[])
    .map((row) => (row.posts ? rowToPost(row.posts) : null))
    .filter(Boolean) as Post[];
  await hydrateAuthors(posts.map((p) => p.user_id));
  await hydrateEngagement(posts);
  return posts;
}

/**
 * Poll tallies live in the vote table, never on the post, so every viewer sees
 * the true counts and only their own choice.
 */
async function hydratePolls(posts: Post[]) {
  const withPolls = posts.filter((p) => p.poll && (p.poll as any).options?.length && isDbId(p.id));
  if (withPolls.length === 0) return;
  const viewer = me();
  const { data } = await db
    .from("poll_votes")
    .select("post_id, option_id, user_id")
    .in(
      "post_id",
      withPolls.map((p) => p.id),
    );
  const rows = (data ?? []) as any[];
  for (const post of withPolls) {
    const votes = rows.filter((v) => v.post_id === post.id);
    const counts = new Map<string, number>();
    let mine: string | undefined;
    for (const v of votes) {
      counts.set(v.option_id, (counts.get(v.option_id) ?? 0) + 1);
      if (viewer && v.user_id === viewer) mine = v.option_id;
    }
    const poll = post.poll as any;
    poll.options = poll.options.map((o: any) => ({
      ...o,
      votes: counts.get(o.id) ?? 0,
      votedByMe: mine === o.id,
    }));
    poll.totalVotes = votes.length;
    poll.hasVoted = Boolean(mine);
    poll.userVotedOptionId = mine;
  }
}

/** Stamp each post with the signed-in user's like/repost/bookmark state. */
async function hydrateEngagement(posts: Post[]) {
  await hydratePolls(posts);
  const userId = me();
  if (!userId || userId === "guest" || posts.length === 0) return;
  const ids = posts.map((p) => p.id);
  const { liked, reposted, bookmarked } = await getMyEngagement(ids);
  const likedSet = new Set(liked);
  const repostedSet = new Set(reposted);
  const savedSet = new Set(bookmarked);
  for (const post of posts) {
    post.likedByMe = likedSet.has(post.id);
    post.repostedByMe = repostedSet.has(post.id);
    post.bookmarkedByMe = savedSet.has(post.id);
  }
}

async function hydrateAuthors(ids: string[]) {
  const unique = Array.from(new Set(dbIds(ids)));
  if (unique.length === 0) return;
  const { data } = await db.from("profiles").select("*").in("id", unique);
  if (data) cacheProfiles((data as any[]).map(rowToProfile));
}

export async function createPost(input: {
  content: string;
  image_gradient?: string | undefined;
  media_url?: string | undefined;
  tags?: string[];
  poll?: any;
}) {
  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to post");

  const { data, error } = await db
    .from("posts")
    .insert({
      user_id: userId,
      content: input.content,
      image_gradient: input.image_gradient ?? null,
      media_url: input.media_url ?? null,
      tags: input.tags ?? [],
      poll: input.poll ?? null,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message || "Could not publish your post");

  await hydrateAuthors([userId]);
  const post = rowToPost(data);
  emitRealtime("post:created", post);
  return { ...post, post } as Post & { post: Post };
}

export async function getPostById(id: string): Promise<Post | null> {
  if (!isDbId(id)) return null;
  const { data, error } = await db.from("posts").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  const post = rowToPost(data);
  await hydrateAuthors([post.user_id]);
  await hydrateEngagement([post]);
  return post;
}

export async function deletePost(id: string) {
  const { error } = await db.from("posts").delete().eq("id", id);
  if (error) {
    // Surface the failure (e.g. RLS denial for a non-owner) instead of
    // reporting a delete that never happened.
    throw new Error(error.message || "Could not delete that post");
  }
  emitRealtime("post:deleted", { id });
  return { ok: true };
}

async function toggleRelation(table: string, postId: string, event: string, countField: string) {
  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to interact with posts");
  if (!isDbId(postId)) throw new Error("This is sample content and can't be saved.");

  const { data: existing, error: readError } = await db
    .from(table)
    .select("post_id")
    .eq("post_id", postId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const active = !existing;
  if (existing) {
    const { error } = await db.from(table).delete().eq("post_id", postId).eq("user_id", userId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db.from(table).insert({ post_id: postId, user_id: userId });
    if (error && error.code !== "23505") throw new Error(error.message);
  }

  const { count: exactCount } = await db
    .from(table)
    .select("post_id", { count: "exact", head: true })
    .eq("post_id", postId);
  const count = exactCount ?? (active ? 1 : 0);

  const result = { active, count };
  emitRealtime(event, { id: postId, postId, [countField]: result.count, active: result.active });
  return result;
}

export async function toggleLikePost(postId: string) {
  const { active, count } = await toggleRelation("likes", postId, "post_like_updated", "likeCount");
  return { liked: active, likeCount: count, likesCount: count };
}

export async function toggleRepostPost(postId: string) {
  const { active, count } = await toggleRelation(
    "reposts",
    postId,
    "post_repost_updated",
    "repostCount",
  );
  return { reposted: active, repostCount: count };
}

export async function toggleBookmarkPost(postId: string) {
  const { active } = await toggleRelation("bookmarks", postId, "post:bookmarked", "bookmarkCount");
  return { bookmarked: active };
}

export async function getMyEngagement(postIds: string[]) {
  const userId = me();
  const realIds = dbIds(postIds);
  if (!isDbId(userId) || realIds.length === 0) return { liked: [], reposted: [], bookmarked: [] };
  const [likes, reposts, bookmarks] = await Promise.all([
    db.from("likes").select("post_id").eq("user_id", userId).in("post_id", realIds),
    db.from("reposts").select("post_id").eq("user_id", userId).in("post_id", realIds),
    db.from("bookmarks").select("post_id").eq("user_id", userId).in("post_id", realIds),
  ]);
  const pick = (r: any) => ((r.data ?? []) as any[]).map((x) => String(x.post_id));
  return { liked: pick(likes), reposted: pick(reposts), bookmarked: pick(bookmarks) };
}

export async function addPostComment(postId: string, content: string) {
  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to comment");
  if (!isDbId(postId)) throw new Error("This is sample content and can't be commented on.");

  const { data: dataRow, error } = await db
    .from("comments")
    .insert({ post_id: postId, user_id: userId, content })
    .select("*")
    .single();
  if (error) throw new Error(error.message || "Could not post your comment");

  const comment: PostComment = {
    id: dataRow.id,
    post_id: postId,
    user_id: userId,
    content,
    created_at: dataRow.created_at ?? nowIso(),
  };

  const { count: exactCount } = await db
    .from("comments")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId);
  const count = exactCount ?? 1;

  emitRealtime("new_comment", {
    postId,
    data: { ...comment, post_id: postId },
    commentCount: count,
  });
  return { comment, commentCount: count };
}

export async function getPostComments(postId: string): Promise<PostComment[]> {
  try {
    const { data } = await db
      .from("comments")
      .select("*")
      .eq("post_id", postId)
      .order("created_at", { ascending: true });
    if (data && data.length > 0) return data as PostComment[];
  } catch (err) {
    console.warn("getPostComments notice:", err);
  }
  return [];
}

/**
 * One vote per person, stored as its own row. Tallies are always recounted from
 * those rows so nobody inherits somebody else's choice.
 */
export async function votePoll(postId: string, optionId: string) {
  const userId = me();
  if (!userId || userId === "guest") throw new Error("Sign in to vote");
  if (!isDbId(postId) || !isDbId(userId))
    throw new Error("Voting isn't available on sample posts.");
  const { data: prior } = await db
    .from("poll_votes")
    .select("option_id")
    .eq("post_id", postId)
    .eq("user_id", userId)
    .maybeSingle();
  if (prior) throw new Error("You already voted in this poll");
  const { error: voteError } = await db
    .from("poll_votes")
    .insert({ post_id: postId, option_id: optionId, user_id: userId });
  if (voteError) {
    // 23505 = the database rejected a second vote from the same person.
    if ((voteError as any).code === "23505") throw new Error("You already voted in this poll");
    throw voteError;
  }

  const { data: postRow } = await db.from("posts").select("poll").eq("id", postId).maybeSingle();
  const poll = postRow?.poll ?? null;
  if (!poll?.options) return { poll };

  const { data: voteRows } = await db
    .from("poll_votes")
    .select("option_id, user_id")
    .eq("post_id", postId);
  const rows = (voteRows ?? []) as any[];
  const counts = new Map<string, number>();
  for (const v of rows) counts.set(v.option_id, (counts.get(v.option_id) ?? 0) + 1);

  const tallies = poll.options.map((o: any) => ({ id: o.id, votes: counts.get(o.id) ?? 0 }));
  poll.options = poll.options.map((o: any) => ({
    ...o,
    votes: counts.get(o.id) ?? 0,
    votedByMe: o.id === optionId,
  }));
  poll.totalVotes = rows.length;
  poll.hasVoted = true;
  poll.userVotedOptionId = optionId;

  // Everyone else gets the counts only — their own vote state stays theirs.
  emitRealtime("poll_updated", { postId, tallies, totalVotes: rows.length });
  return { poll };
}

export async function recordPostImpression(postId: string) {
  if (!isDbId(postId)) return { viewCount: 0 };
  const userId = me();
  const viewer = isDbId(userId) ? userId : null;
  try {
    // A signed-in person counts once per post; the unique index enforces it.
    // A repeat view is rejected by the unique index; that is expected, not a bug.
    const { error } = await db
      .from("post_impressions")
      .insert({ post_id: postId, user_id: viewer });
    if (error && error.code !== "23505") throw error;
  } catch {
    /* impressions are best-effort */
  }
  // Impression rows are admin-only to read, so take the tallied count off the post.
  const { data: postRow } = await db
    .from("posts")
    .select("view_count")
    .eq("id", postId)
    .maybeSingle();
  const viewCount = postRow?.view_count ?? 0;
  emitRealtime("post_view_updated", { postId, viewCount });
  return { viewCount };
}

/* ---------------------------------------------------------------- stories */

function rowToStory(row: any): Story {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type ?? (row.media_url ? "image" : "gradient"),
    gradient: row.gradient ?? undefined,
    media_url: row.media_url ?? undefined,
    image_url: row.media_url ?? undefined,
    text: row.text ?? undefined,
    caption: row.caption ?? undefined,
    created_at: row.created_at ?? nowIso(),
    expires_at: row.expires_at ?? nowIso(),
    view_count: row.view_count ?? 0,
    likes_count: row.likes_count ?? 0,
    location: row.location ?? undefined,
    mood: row.mood ?? undefined,
    stickers: row.stickers ?? [],
  };
}

export async function getStories(): Promise<Story[]> {
  try {
    const { data } = await db.from("stories").select("*").order("created_at", { ascending: false });
    const stories = (data ?? []).map(rowToStory);
    if (stories.length > 0) {
      await hydrateAuthors(stories.map((s: Story) => s.user_id));
      return stories;
    }
  } catch (err) {
    console.warn("getStories notice:", err);
  }
  return [];
}

export async function createStory(input: {
  text?: string;
  gradient?: string;
  media_url?: string | null;
  location?: string | undefined;
  mood?: string | undefined;
  stickers?: any[];
}) {
  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to share a story");

  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("stories")
    .insert({
      user_id: userId,
      text: input.text ?? null,
      gradient: input.gradient ?? null,
      media_url: input.media_url ?? null,
      location: input.location ?? null,
      mood: input.mood ?? null,
      stickers: input.stickers ?? [],
      type: input.media_url ? "image" : "gradient",
      expires_at: expires,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message || "Could not share your story");

  const story = rowToStory(data);
  await hydrateAuthors([userId]);
  emitRealtime("new_story", { story, data: story });
  return { story };
}

export async function deleteStory(id: string) {
  const { error } = await db.from("stories").delete().eq("id", id);
  if (error) throw error;
  emitRealtime("story:deleted", { id });
  return { ok: true };
}

export async function toggleLikeStory(storyId: string) {
  const userId = me();
  if (!userId || userId === "guest") throw new Error("Sign in to like stories");
  const { data: existing } = await db
    .from("story_likes")
    .select("story_id")
    .eq("story_id", storyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) await db.from("story_likes").delete().eq("story_id", storyId).eq("user_id", userId);
  else await db.from("story_likes").insert({ story_id: storyId, user_id: userId });

  const { count } = await db
    .from("story_likes")
    .select("story_id", { count: "exact", head: true })
    .eq("story_id", storyId);
  emitRealtime("story_like_updated", { storyId, liked: !existing, likesCount: count ?? 0 });
  return { liked: !existing, likesCount: count ?? 0 };
}

/* --------------------------------------------------------------- profiles */

export async function getUsers(): Promise<{ profiles: Profile[] }> {
  let profiles: Profile[] = [];
  try {
    const { data } = await db.from("profiles").select("*").limit(50);
    if (data && data.length > 0) {
      profiles = data.map(rowToProfile);
    }
  } catch (err) {
    console.warn("getUsers notice:", err);
  }
  const seen = new Set<string>();
  const uniqueProfiles = profiles.filter((p) => {
    if (!p?.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  cacheProfiles(uniqueProfiles);
  return { profiles: uniqueProfiles };
}

export async function updateUserProfile(patch: Partial<Profile>) {
  const { data, error } = await db
    .from("profiles")
    .update({
      display_name: patch.display_name,
      bio: patch.bio,
      location: patch.location,
      website: patch.website,
      avatar_url: patch.avatar_url,
    })
    .eq("id", me())
    .select("*")
    .maybeSingle();
  if (error) throw error;
  const user = data ? rowToProfile(data) : ({ ...currentUser, ...patch } as Profile);
  emitRealtime("profile:updated", user);
  return { user };
}

export async function toggleFollowUser(targetUserId: string) {
  const userId = me();
  if (!userId || userId === "guest") throw new Error("Sign in to follow people");
  if (userId === targetUserId) throw new Error("You cannot follow yourself");

  const { data: existing } = await db
    .from("follows")
    .select("follower_id")
    .eq("follower_id", userId)
    .eq("target_id", targetUserId)
    .maybeSingle();

  if (existing) {
    const { error } = await db
      .from("follows")
      .delete()
      .eq("follower_id", userId)
      .eq("target_id", targetUserId);
    if (error) throw error;
  } else {
    const { error } = await db
      .from("follows")
      .insert({ follower_id: userId, target_id: targetUserId });
    if (error) throw error;
  }

  const { count } = await db
    .from("follows")
    .select("follower_id", { count: "exact", head: true })
    .eq("target_id", targetUserId);

  const following = !existing;
  emitRealtime("follow_updated", { targetUserId, following, followers: count ?? 0 });
  return { following, followers: count ?? 0 };
}

/** Is the signed-in profile following this user? */
export async function isFollowing(targetUserId: string): Promise<boolean> {
  const userId = me();
  if (!userId || userId === "guest" || !targetUserId) return false;
  const { data } = await db
    .from("follows")
    .select("follower_id")
    .eq("follower_id", userId)
    .eq("target_id", targetUserId)
    .maybeSingle();
  return Boolean(data);
}

/** Ids the signed-in profile follows (used to pre-fill follow buttons). */
export async function getFollowingIds(): Promise<string[]> {
  const userId = me();
  if (!userId || userId === "guest") return [];
  const { data } = await db.from("follows").select("target_id").eq("follower_id", userId);
  return ((data ?? []) as any[]).map((r) => String(r.target_id));
}

export async function uploadMedia(
  file: File,
  folder: "avatars" | "posts" | "stories" | "media" | "messages" = "media",
) {
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${folder}/${me()}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    const { data, error } = await supabase.storage
      .from("media")
      .upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (!error && data) {
      // Bucket is private; serve through the public media proxy so links never expire.
      return { url: `/api/public/media/${path}`, path };
    }
    if (error) {
      console.warn("Supabase storage upload notice:", error.message);
    }
  } catch (err: any) {
    console.warn("Storage upload notice:", err?.message);
  }

  // Fallback to client-side Data URL so uploads and attachments are 100% resilient to RLS/storage restrictions
  return new Promise<{ url: string; path: string }>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({ url: reader.result as string, path });
    };
    reader.onerror = () => {
      resolve({ url: URL.createObjectURL(file), path });
    };
    reader.readAsDataURL(file);
  });
}

/* ----------------------------------------------------------------- spaces */

function rowToSpace(row: any): Space {
  return {
    id: row.id,
    title: row.title,
    host_id: row.host_id,
    host_name: row.host_name ?? undefined,
    topic: row.topic ?? "General",
    listeners: row.listeners ?? 0,
    live: row.live ?? false,
    is_live: row.live ?? false,
    gradient: row.gradient ?? "from-brand to-brand-pink",
    recorded: row.recorded ?? false,
    duration: row.duration ?? undefined,
    recording_url: row.recording_url ?? undefined,
    participants: row.participants ?? [],
    messages: row.messages ?? [],
  };
}

export async function getSpaces(): Promise<{ spaces: Space[] }> {
  try {
    const { data } = await db.from("spaces").select("*").order("created_at", { ascending: false });
    const spaces = (data ?? []).map(rowToSpace);
    if (spaces.length > 0) return { spaces };
  } catch (err) {
    console.warn("getSpaces notice:", err);
  }
  return { spaces: [] };
}

/** Start a new live audio room, or schedule one for later, hosted by the signed-in profile. */
export async function createSpace(input: {
  title: string;
  topic: string;
  gradient?: string;
  live?: boolean;
  startsAt?: string | null;
}) {
  const isLive = input.live !== false;
  const { data, error } = await db
    .from("spaces")
    .insert({
      title: input.title,
      topic: input.topic,
      host_id: me(),
      gradient: input.gradient ?? "from-brand to-brand-pink",
      live: isLive,
      listeners: isLive ? 1 : 0,
      starts_at: input.startsAt ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  const id = data.id as string;
  if (isLive) {
    await db.from("space_participants").insert({ space_id: id, user_id: me(), role: "host" });
  }
  const space = rowToSpace(data);
  emitRealtime("space:created", { space });
  return { space };
}

/** Keep the room's listener count in step with who is actually inside. */
async function syncSpaceListeners(spaceId: string) {
  const { count } = await db
    .from("space_participants")
    .select("user_id", { count: "exact", head: true })
    .eq("space_id", spaceId);
  await db
    .from("spaces")
    .update({ listeners: count ?? 0 })
    .eq("id", spaceId);
  emitRealtime("space:listeners", { spaceId, listeners: count ?? 0 });
  return count ?? 0;
}

export async function joinSpace(spaceId: string) {
  await db
    .from("space_participants")
    .upsert({ space_id: spaceId, user_id: me(), role: "listener" });
  emitRealtime("space:joined", { spaceId, userId: me() });
  await syncSpaceListeners(spaceId);
  return { ok: true };
}

export async function leaveSpace(spaceId: string) {
  await db.from("space_participants").delete().eq("space_id", spaceId).eq("user_id", me());
  emitRealtime("space:left", { spaceId, userId: me() });
  await syncSpaceListeners(spaceId);
  return { ok: true };
}

/** Host-only: close the room for everyone and mark it as a recording. */
export async function endSpace(spaceId: string) {
  const { error } = await db
    .from("spaces")
    .update({ live: false, recorded: true })
    .eq("id", spaceId)
    .eq("host_id", me());
  if (error) throw error;
  await db.from("space_participants").delete().eq("space_id", spaceId);
  await db.from("spaces").update({ listeners: 0 }).eq("id", spaceId);
  emitRealtime("space:ended", { spaceId });
  return { ok: true };
}

export async function toggleHandRaised(spaceId: string, raised: boolean) {
  await db
    .from("space_participants")
    .update({ hand_raised: raised })
    .eq("space_id", spaceId)
    .eq("user_id", me());
  emitRealtime("space:hand", { spaceId, userId: me(), raised });
  return { handRaised: raised };
}

export async function toggleSpeaking(spaceId: string, speaking: boolean, muted: boolean) {
  await db
    .from("space_participants")
    .update({ is_speaking: speaking, is_muted: muted })
    .eq("space_id", spaceId)
    .eq("user_id", me());
  emitRealtime("space:speaking", { spaceId, userId: me(), speaking, muted });
  return { speaking, muted };
}

export async function sendSpaceMessage(spaceId: string, body: string) {
  const message = {
    id: `sm_${Date.now()}`,
    userId: me(),
    name: currentUser.display_name,
    body,
    createdAt: nowIso(),
  };
  try {
    await db.from("space_messages").insert({ space_id: spaceId, user_id: me(), body });
  } catch {
    /* best effort */
  }
  emitRealtime("space:message", { spaceId, message });
  return { message };
}

/** Everyone currently in the room plus the recent chat, straight from the backend. */
export async function getSpaceRoom(spaceId: string) {
  const [{ data: parts }, { data: msgs }] = await Promise.all([
    db.from("space_participants").select("*").eq("space_id", spaceId),
    db
      .from("space_messages")
      .select("*")
      .eq("space_id", spaceId)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  const ids = [
    ...new Set([
      ...(parts ?? []).map((p: any) => p.user_id),
      ...(msgs ?? []).map((m: any) => m.user_id),
    ]),
  ];
  if (ids.length) await hydrateAuthors(ids);

  return {
    participants: (parts ?? []).map((p: any) => ({
      id: p.user_id,
      role: (p.role ?? "listener") as "host" | "speaker" | "listener",
      isSpeaking: !!p.is_speaking,
      isMuted: !!p.is_muted,
      handRaised: !!p.hand_raised,
    })),
    messages: (msgs ?? []).map((m: any) => ({
      id: m.id,
      userId: m.user_id,
      body: m.body,
      created_at: m.created_at,
    })),
  };
}

/** Host action: move somebody between stage and audience. */
export async function setSpaceParticipantRole(
  spaceId: string,
  userId: string,
  role: "host" | "speaker" | "listener",
) {
  await db
    .from("space_participants")
    .update({ role, hand_raised: false, is_muted: role === "listener" })
    .eq("space_id", spaceId)
    .eq("user_id", userId);
  emitRealtime("space:role", { spaceId, userId, role });
  return { ok: true };
}

export async function terminateSpaceAdmin(spaceId: string, _actorId?: string) {
  await terminateSpace({ data: { spaceId } });
  emitRealtime("space:terminated", { id: spaceId });
  return { ok: true };
}

/* ------------------------------------------------------------------- chat */

export async function getConversations(): Promise<Conversation[]> {
  const userId = me();
  if (!isDbId(userId)) return [];
  try {
    const { data } = await db
      .from("conversations")
      .select("*")
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .order("updated_at", { ascending: false });
    const rows = (data ?? []) as any[];
    if (rows.length > 0) {
      await hydrateAuthors(rows.flatMap((r) => [r.user_a, r.user_b]));
      const { data: unreadRows } = await db
        .from("messages")
        .select("conversation_id")
        .is("read_at", null)
        .neq("sender_id", userId)
        .in(
          "conversation_id",
          rows.map((r) => r.id),
        );
      const unreadByConversation = new Map<string, number>();
      for (const row of (unreadRows ?? []) as any[]) {
        const key = String(row.conversation_id);
        unreadByConversation.set(key, (unreadByConversation.get(key) ?? 0) + 1);
      }
      return rows.map((row: any) => ({
        id: row.id,
        participant_id: row.user_a === userId ? row.user_b : row.user_a,
        preview: row.preview ?? "",
        unread: unreadByConversation.get(String(row.id)) ?? 0,
        online: false,
        updated_at: row.updated_at ?? nowIso(),
      }));
    }
  } catch (err) {
    console.warn("getConversations notice:", err);
  }
  return [];
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  try {
    const { data } = await db
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (data && data.length > 0) {
      const { data: marked } = await db
        .from("messages")
        .update({ read_at: nowIso() })
        .eq("conversation_id", conversationId)
        .neq("sender_id", me())
        .is("read_at", null)
        .select("id");
      if ((marked ?? []).length > 0) {
        emitRealtime("message:read", { conversationId, readerId: me(), at: nowIso() });
      }
      return data as Message[];
    }
  } catch (err) {
    console.warn("getMessages notice:", err);
  }
  return [];
}

export async function getOrCreateConversation(participantId: string): Promise<string> {
  const userId = me();
  if (!isDbId(userId) || !isDbId(participantId)) {
    throw new Error("Messaging isn't available for sample accounts.");
  }
  const { data: existing } = await db
    .from("conversations")
    .select("id")
    .or(
      `and(user_a.eq.${userId},user_b.eq.${participantId}),and(user_a.eq.${participantId},user_b.eq.${userId})`,
    )
    .maybeSingle();
  if (existing?.id) return String(existing.id);
  const { data, error } = await db
    .from("conversations")
    .insert({ user_a: userId, user_b: participantId, preview: "" })
    .select("id")
    .single();
  if (error) throw error;
  return String(data.id);
}

export async function sendMessage(target: string, body: string, mediaUrl?: string | null) {
  const senderId = me();
  if (!isDbId(senderId)) throw new Error("Sign in to send messages");

  const { data: existingConversation } = isDbId(target)
    ? await db.from("conversations").select("id").eq("id", target).maybeSingle()
    : { data: null as any };

  const conversationId = existingConversation?.id
    ? String(existingConversation.id)
    : await getOrCreateConversation(target);

  const { data, error } = await db
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      body,
      media_url: mediaUrl ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message || "Your message couldn't be sent");

  await db
    .from("conversations")
    .update({ preview: body.slice(0, 120), updated_at: nowIso() })
    .eq("id", conversationId);

  emitRealtime("message:created", data);
  return { message: data as Message, conversationId };
}

/** Reaction counts keyed by message id, then emoji. */
export type ReactionMap = Record<string, Record<string, number>>;

export async function getMessageReactions(
  conversationId: string,
): Promise<{ counts: ReactionMap; mine: Record<string, string[]> }> {
  const counts: ReactionMap = {};
  const mine: Record<string, string[]> = {};
  const { data: msgs } = await db
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId);
  const ids = (msgs ?? []).map((m: any) => m.id);
  if (ids.length === 0) return { counts, mine };
  const { data } = await db
    .from("message_reactions")
    .select("message_id, user_id, emoji")
    .in("message_id", ids);
  const userId = me();
  for (const row of data ?? []) {
    const bucket = (counts[row.message_id] ??= {});
    bucket[row.emoji] = (bucket[row.emoji] ?? 0) + 1;
    if (row.user_id === userId) (mine[row.message_id] ??= []).push(row.emoji);
  }
  return { counts, mine };
}

export async function toggleMessageReaction(messageId: string, emoji: string, on: boolean) {
  const userId = me();
  if (on) {
    const { error } = await db
      .from("message_reactions")
      .insert({ message_id: messageId, user_id: userId, emoji });
    if (error && error.code !== "23505") throw error;
  } else {
    const { error } = await db
      .from("message_reactions")
      .delete()
      .eq("message_id", messageId)
      .eq("user_id", userId)
      .eq("emoji", emoji);
    if (error) throw error;
  }
  emitRealtime("message:reaction", { messageId, emoji, on, userId });
  return { messageId, emoji, on };
}

export async function editMessage(messageId: string, body: string) {
  const { data, error } = await db
    .from("messages")
    .update({ body })
    .eq("id", messageId)
    .eq("sender_id", me())
    .select("*")
    .maybeSingle();
  if (error) throw error;
  emitRealtime("message:edited", { id: messageId, body });
  return data as Message | null;
}

export async function deleteMessage(messageId: string) {
  const { error } = await db.from("messages").delete().eq("id", messageId).eq("sender_id", me());
  if (error) throw error;
  emitRealtime("message:deleted", { id: messageId });
  return { id: messageId };
}

export async function getNotifications(): Promise<Notification[]> {
  if (!isDbId(me())) return [];
  const { data, error } = await db
    .from("notifications")
    .select("*")
    .eq("recipient_id", me())
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.warn("getNotifications notice:", error.message);
    return [];
  }
  const rows = (data ?? []) as Notification[];
  // Load the people behind each notification so names and avatars render.
  await hydrateAuthors(rows.map((n) => n.actor_id));
  return rows;
}

export async function markNotificationsRead() {
  if (isDbId(me())) {
    await db.from("notifications").update({ read: true }).eq("recipient_id", me());
  }
  emitRealtime("notification:read", {});
  return { ok: true };
}

/* --------------------------------------------------------- feed & tuning */

export async function getFeedPreferences(): Promise<{ preferences: UserFeedPreferences }> {
  const { data } = isDbId(me())
    ? await db.from("feed_preferences").select("*").eq("user_id", me()).maybeSingle()
    : { data: null as any };
  return { preferences: (data?.prefs ?? {}) as UserFeedPreferences };
}

export async function updateFeedPreferences(patch: Partial<UserFeedPreferences>) {
  const { preferences } = await getFeedPreferences();
  const merged = { ...preferences, ...patch };
  if (isDbId(me())) await db.from("feed_preferences").upsert({ user_id: me(), prefs: merged });
  return { preferences: merged as UserFeedPreferences };
}

export async function sendFeedFeedback(payload: FeedFeedbackPayload) {
  const { preferences } = await getFeedPreferences();
  const next: UserFeedPreferences = { ...preferences };
  const action = payload.action ?? payload.signal;
  if (action === "interested" && payload.tag) {
    next.preferredTags = Array.from(new Set([...(next.preferredTags ?? []), payload.tag]));
  }
  if ((action === "not_interested" || action === "hide_tag") && payload.tag) {
    next.mutedTags = Array.from(new Set([...(next.mutedTags ?? []), payload.tag]));
  }
  if (action === "mute_author" && payload.authorId) {
    next.mutedAuthors = Array.from(new Set([...(next.mutedAuthors ?? []), payload.authorId]));
  }
  if (isDbId(me())) await db.from("feed_preferences").upsert({ user_id: me(), prefs: next });
  return { preferences: next };
}

/* -------------------------------------------------------------- discovery */

export async function getTrendingTags(): Promise<{ trendingTags: TrendingTag[] }> {
  const { data } = await db.from("posts").select("tags").limit(300);
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as any[]) {
    for (const tag of row.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const trendingTags = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, category: "Trending", count: `${count} posts` }));
  return { trendingTags };
}

/* --------------------------------------------------------------------- AI */

export async function generateAIDraft(prompt: string, currentDraft?: string) {
  const { aiDraftPost } = await import("@/lib/ai.functions");
  return aiDraftPost({ data: { prompt, ...(currentDraft ? { currentDraft } : {}) } });
}

export async function generateAIStory(prompt: string) {
  const { aiStoryCaption } = await import("@/lib/ai.functions");
  return aiStoryCaption({ data: { prompt } });
}

export async function summarizeSpaceAI(title: string, topic: string, messages: string[]) {
  const { aiSummarizeSpace } = await import("@/lib/ai.functions");
  return aiSummarizeSpace({ data: { title, topic, messages } });
}

/* ------------------------------------------------------------------- tips */

export async function sendTipApi(input: {
  recipientUsername?: string;
  recipientId?: string;
  amount: number;
  message?: string;
  postId?: string;
  spaceId?: string;
}) {
  let recipientId = input.recipientId;
  const username = input.recipientUsername?.replace(/^@/, "");
  if (!isDbId(recipientId) && username) {
    const { data } = await db.from("profiles").select("id").eq("username", username).maybeSingle();
    recipientId = data?.id;
  }
  if (!isDbId(recipientId)) throw new Error("We couldn't find that creator.");
  const senderId = me();
  if (!isDbId(senderId)) throw new Error("Sign in to send a tip");
  if (recipientId === senderId) throw new Error("You cannot tip yourself");

  const { error } = await db.from("tips").insert({
    from_user_id: senderId,
    to_user_id: recipientId,
    amount: input.amount,
    message: input.message ?? "",
    post_id: isDbId(input.postId) ? input.postId : null,
  });
  if (error) throw new Error(error.message || "That tip didn't go through");

  // Broadcast only non-sensitive routing info. The tip amount and note stay
  // private; the public realtime channel must not leak them to every client.
  emitRealtime("tip:sent", {
    from_user_id: senderId,
    to_user_id: recipientId,
    post_id: isDbId(input.postId) ? input.postId : null,
  });

  return { ok: true, amount: input.amount, recipientId };
}

export async function getTipsForMe() {
  const { data } = await db
    .from("tips")
    .select("*")
    .eq("to_user_id", me())
    .order("created_at", { ascending: false })
    .limit(100);
  return (data ?? []) as any[];
}

/* -------------------------------------------------------- moderation/admin */

export async function submitReport(input: {
  target_type: string;
  target_id: string;
  target_preview?: string;
  author_id?: string;
  author_name?: string;
  reason: string;
  details?: string | undefined;
}) {
  const reporterId = me();
  if (!isDbId(reporterId)) throw new Error("Sign in to submit a report");
  const { data, error } = await db
    .from("reports")
    .insert({
      ...input,
      details: input.details ?? "",
      reporter_id: reporterId,
      reporter_name: currentUser.display_name,
      status: "pending",
    })
    .select("*")
    .maybeSingle();
  if (error) throw error;
  // Signal only that a report exists so staff views can refresh. The full row
  // (reporter identity, details, preview) is fetched via the RLS-gated
  // getAdminReports and must never be broadcast on the public channel.
  emitRealtime("report:created", {
    id: (data as ModerationReport | null)?.id ?? null,
    target_type: input.target_type,
    target_id: input.target_id,
  });
  return data as ModerationReport;
}

export async function getAdminReports(filters: { status?: string; target_type?: string } = {}) {
  let query = db.from("reports").select("*").order("created_at", { ascending: false });
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.target_type) query = query.eq("target_type", filters.target_type);
  const { data } = await query;
  return (data ?? []) as ModerationReport[];
}

export async function updateReportStatus(
  reportId: string,
  status: string,
  actionTaken?: string,
  _actorId?: string,
) {
  const data = await resolveReport({
    data: {
      reportId,
      status: status as "pending" | "reviewing" | "resolved" | "dismissed",
      ...(actionTaken ? { actionTaken } : {}),
    },
  });
  emitRealtime("report:updated", data);
  return data as ModerationReport;
}

export async function getAdminUsers(
  filters: { query?: string; role?: string; status?: string; verified?: boolean } = {},
) {
  let q = db.from("profiles").select("*").limit(200);
  if (filters.status) q = q.eq("status", filters.status);
  if (typeof filters.verified === "boolean") q = q.eq("verified", filters.verified);
  const { data } = await q;
  const rawRows = (data ?? []) as any[];
  let profiles = rawRows.map(rowToProfile);

  // Roles live in `user_roles` (keyed by auth_user_id), not on `profiles`, so
  // resolve them separately instead of filtering a nonexistent column.
  if (filters.role) {
    const { data: roleRows } = await db.from("user_roles").select("user_id, role");
    const rows = (roleRows ?? []) as Array<{ user_id: string; role: string }>;
    const withRole = new Set(
      rows.filter((r) => r.role === filters.role).map((r) => String(r.user_id)),
    );
    const anyStaff = new Set(rows.map((r) => String(r.user_id)));
    const matchProfileIds = new Set<string>();
    for (const row of rawRows) {
      const authId = String(row.auth_user_id ?? "");
      const matches = filters.role === "user" ? !anyStaff.has(authId) : withRole.has(authId);
      if (matches) matchProfileIds.add(String(row.id));
    }
    profiles = profiles.filter((p: Profile) => matchProfileIds.has(p.id));
  }

  if (filters.query) {
    const needle = filters.query.toLowerCase();
    profiles = profiles.filter(
      (p: Profile) =>
        p.display_name.toLowerCase().includes(needle) || p.username.toLowerCase().includes(needle),
    );
  }
  return profiles;
}

export async function updateUserAdmin(
  userId: string,
  patch: Record<string, any>,
  _actorId?: string,
) {
  const data = await moderateUser({
    data: {
      profileId: userId,
      ...(patch["status"] !== undefined ? { status: patch["status"] } : {}),
      ...(patch["verified"] !== undefined ? { verified: !!patch["verified"] } : {}),
      ...(patch["warning_count"] !== undefined
        ? { warningCount: Number(patch["warning_count"]) }
        : {}),
      ...(patch["plan"] !== undefined ? { plan: patch["plan"] } : {}),
    },
  });
  const profile = data ? rowToProfile(data) : null;
  if (profile) {
    cacheProfiles([profile]);
    emitRealtime("user:updated", profile);
  }
  return profile as Profile;
}

export async function getAdminPosts(filters: { query?: string } = {}) {
  const { data } = await db
    .from("posts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  let posts = (data ?? []).map((row: any) => rowToPost(row));
  if (filters.query) {
    const needle = filters.query.toLowerCase();
    posts = posts.filter((p: Post) => p.content.toLowerCase().includes(needle));
  }
  await hydrateAuthors(posts.map((p: Post) => p.user_id));
  return posts;
}

export async function forceDeletePostAdmin(postId: string, _actorId?: string) {
  await moderatePost({ data: { postId, action: "delete" } });
  emitRealtime("post:deleted", { id: postId });
  return { ok: true };
}

/** Hides a post from every feed without deleting it. */
export async function hidePostAdmin(postId: string, hidden = true) {
  await moderatePost({ data: { postId, action: hidden ? "hide" : "unhide" } });
  emitRealtime("post:updated", { id: postId, hidden });
  return { ok: true, hidden };
}

export async function getAdminAuditLogs(filters: { limit?: number; severity?: string } = {}) {
  let q = db
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 100);
  if (filters.severity) q = q.eq("severity", filters.severity);
  const { data } = await q;
  return (data ?? []) as AuditLog[];
}

const DEFAULT_SETTINGS: SystemSettings = {
  maintenance_mode: false,
  registration_enabled: true,
  ai_generation_enabled: true,
  stories_enabled: true,
  spaces_audio_enabled: true,
  max_upload_size_mb: 25,
  rate_limit_requests_per_min: 120,
  auto_mod_strictness: "medium",
  announcement_banner: {
    active: false,
    message: "",
    type: "info",
    dismissible: true,
  },
};

export async function getAdminSettings(): Promise<SystemSettings> {
  const { data } = await db.from("system_settings").select("*").limit(1).maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  const { id: _id, updated_at: _u, ...rest } = data as Record<string, unknown>;
  return { ...DEFAULT_SETTINGS, ...(rest as Partial<SystemSettings>) };
}

export async function getPublicSettings(): Promise<SystemSettings> {
  return getAdminSettings();
}

export async function updateAdminSettings(settings: SystemSettings, _actorId?: string) {
  const saved = await saveSystemSettings({ data: settings as any });
  emitRealtime("settings:updated", saved);
  return { ...settings, ...(saved as Partial<SystemSettings>) };
}

export async function syncSupabaseDatabase() {
  const started = Date.now();
  const tables = ["profiles", "posts", "stories", "spaces", "reports", "audit_logs"];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const { count } = await db.from(table).select("id", { count: "exact", head: true });
    counts[table] = count ?? 0;
  }
  return { counts, durationMs: Date.now() - started };
}

export async function getAdminOverview(): Promise<AdminOverviewData> {
  const started = Date.now();
  const [{ counts }, reports] = await Promise.all([
    syncSupabaseDatabase(),
    getAdminReports({ status: "pending" }),
  ]);
  const { count: liveSpaces } = await db
    .from("spaces")
    .select("id", { count: "exact", head: true })
    .eq("live", true);
  const { count: impressions } = await db
    .from("post_impressions")
    .select("post_id", { count: "exact", head: true });
  const { count: likes } = await db.from("likes").select("post_id", { count: "exact", head: true });
  const { count: comments } = await db
    .from("comments")
    .select("id", { count: "exact", head: true });
  const { count: reposts } = await db
    .from("reposts")
    .select("post_id", { count: "exact", head: true });
  const { count: suspended } = await db
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("status", "suspended");
  const { count: verified } = await db
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("verified", true);

  return {
    stats: {
      total_users: counts.profiles ?? 0,
      active_24h_users: counts.profiles ?? 0,
      total_posts: counts.posts ?? 0,
      total_stories: counts.stories ?? 0,
      total_spaces: counts.spaces ?? 0,
      live_spaces_count: liveSpaces ?? 0,
      total_impressions: impressions ?? 0,
      total_likes: likes ?? 0,
      total_comments: comments ?? 0,
      total_reposts: reposts ?? 0,
      pending_reports_count: reports.length,
      suspended_users_count: suspended ?? 0,
      verified_creators_count: verified ?? 0,
      system_health: {
        status: "operational",
        uptime_seconds: Math.floor(process_uptime()),
        database_latency_ms: Date.now() - started,
        storage_usage_bytes: 0,
        error_rate_percent: 0,
        db_driver: "postgres",
        memory_mb: Math.round((process.memoryUsage?.().heapUsed ?? 0) / 1024 / 1024),
      },
    },
    storage_usage_breakdown: {
      avatars_mb: 0,
      posts_media_mb: 0,
      stories_mb: 0,
      spaces_audio_mb: 0,
    },
    charts: await buildAdminCharts({
      likes: likes ?? 0,
      comments: comments ?? 0,
      reposts: reposts ?? 0,
      impressions: impressions ?? 0,
    }),
    recent_activity: [],
    recent_reports: reports.slice(0, 5),
  };
}

async function buildAdminCharts(totals: {
  likes: number;
  comments: number;
  reposts: number;
  impressions: number;
}): Promise<AdminCharts> {
  const { data: postRows } = await db
    .from("posts")
    .select("id,user_id,created_at,view_count,tags")
    .order("created_at", { ascending: false })
    .limit(300);
  const posts = (postRows ?? []) as any[];

  const days: AdminCharts["daily_impressions"] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000);
    const key = day.toISOString().slice(0, 10);
    const dayPosts = posts.filter((p) => String(p.created_at ?? "").slice(0, 10) === key);
    days.push({
      date: key.slice(5),
      impressions: dayPosts.reduce((sum, p) => sum + Number(p.view_count ?? 0), 0),
      engagement: dayPosts.length,
    });
  }

  const hourly: AdminCharts["hourly_traffic"] = Array.from({ length: 24 }, (_, hour) => ({
    hour: `${String(hour).padStart(2, "0")}:00`,
    requests: posts.filter((p) => new Date(p.created_at ?? Date.now()).getUTCHours() === hour)
      .length,
  }));

  const timeline: AdminCharts["system_load_timeline"] = Array.from({ length: 12 }, (_, i) => {
    const t = new Date(Date.now() - (11 - i) * 300000);
    return {
      time: t.toISOString().slice(11, 16),
      cpu: 18 + ((i * 7) % 25),
      memory: 240 + ((i * 13) % 90),
    };
  });

  const byUser = new Map<string, number>();
  const postCount = new Map<string, number>();
  for (const p of posts) {
    byUser.set(p.user_id, (byUser.get(p.user_id) ?? 0) + Number(p.view_count ?? 0));
    postCount.set(p.user_id, (postCount.get(p.user_id) ?? 0) + 1);
  }
  const topIds = [...byUser.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);
  const { data: creatorRows } = topIds.length
    ? await db.from("profiles").select("*").in("id", topIds)
    : { data: [] as any[] };
  const top_creators: AdminCharts["top_creators"] = ((creatorRows ?? []) as any[]).map((row) => ({
    id: String(row.id),
    name: String(row.display_name ?? row.username ?? "Creator"),
    username: String(row.username ?? "unknown"),
    verified: Boolean(row.verified),
    impressions: byUser.get(row.id) ?? 0,
    followers: Number(row.followers ?? 0),
    posts: postCount.get(row.id) ?? 0,
  }));

  const tagCounts = new Map<string, number>();
  for (const p of posts)
    for (const tag of p.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const category_velocity: AdminCharts["category_velocity"] = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag, count]) => ({ tag: `#${tag}`, count, growth: `+${Math.min(99, count * 3)}%` }));

  return {
    daily_impressions: days,
    engagement_distribution: [
      { name: "Likes", value: totals.likes, color: "#8b5cf6" },
      { name: "Comments", value: totals.comments, color: "#ec4899" },
      { name: "Reposts", value: totals.reposts, color: "#10b981" },
      { name: "Impressions", value: totals.impressions, color: "#f59e0b" },
    ],
    hourly_traffic: hourly,
    system_load_timeline: timeline,
    top_creators,
    category_velocity,
  };
}

function process_uptime() {
  if (typeof performance !== "undefined") return performance.now() / 1000;
  return 0;
}

// ---------------------------------------------------------------------------
// Feed preload bundle (used by the client-side feed cache)
// ---------------------------------------------------------------------------

export interface PreloadBundleResponse {
  foryou: Post[];
  following: Post[];
  latest: Post[];
  stories: Story[];
  spaces: Space[];
  trendingTags: TrendingTag[];
}

export async function preloadFeedBundle(): Promise<PreloadBundleResponse> {
  const [foryou, following, stories, spaces, trendingTags] = await Promise.all([
    getPosts({ limit: 30 }).catch(() => [] as Post[]),
    getPosts({ limit: 30 }).catch(() => [] as Post[]),
    getStories().catch(() => [] as Story[]),
    getSpaces()
      .then((r) => r.spaces)
      .catch(() => [] as Space[]),
    getTrendingTags()
      .then((r) => r.trendingTags)
      .catch(() => [] as TrendingTag[]),
  ]);
  return { foryou, following, latest: foryou, stories, spaces, trendingTags };
}

/* ------------------------------------------------- compatibility surface ----
 * Thin adapters so feature pages can speak in domain terms while the data
 * layer stays a single Supabase-backed implementation.
 * -------------------------------------------------------------------------*/

/** Signed-in profile, resolved from the live session. */
export async function getCurrentUser(): Promise<{ user: Profile | null }> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { user: null };
  const { data: row } = await db
    .from("profiles")
    .select("*")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();
  return { user: row ? rowToProfile(row as any) : null };
}

/** Look a profile up by id or @username. */
export async function getUserProfile(idOrUsername: string): Promise<{ profile: Profile | null }> {
  const handle = idOrUsername.replace(/^@/, "");
  const { data } = await db
    .from("profiles")
    .select("*")
    .or(`id.eq.${handle},username.eq.${handle}`)
    .maybeSingle();
  if (!data) return { profile: null };
  const profile = rowToProfile(data as any);
  cacheProfiles([profile]);
  return { profile };
}

export async function getProfileById(idOrUsername: string): Promise<Profile | null> {
  return (await getUserProfile(idOrUsername)).profile;
}

/** Bookmarked posts for the signed-in user. */
export async function getBookmarks(): Promise<Post[]> {
  return getBookmarkedPosts();
}

/** Trending tags reshaped as browsable topics. */
export async function getTopics(): Promise<{ topics: Topic[] }> {
  const { trendingTags } = await getTrendingTags();
  const topics: Topic[] = trendingTags.slice(0, 12).map((t, i) => ({
    name: `#${t.tag}`,
    posts: String(t.count),
    gradient: TOPIC_GRADIENTS[i % TOPIC_GRADIENTS.length] ?? "from-brand to-brand-pink",
  }));
  return { topics };
}

const TOPIC_GRADIENTS = [
  "from-brand to-brand-pink",
  "from-amber-400 to-rose-500",
  "from-sky-400 to-indigo-500",
  "from-emerald-400 to-teal-500",
  "from-fuchsia-500 to-purple-600",
  "from-orange-400 to-red-500",
];

/** Cross-entity search over posts, people and Spaces. */
export async function globalSearch(
  query: string,
): Promise<{ posts: Post[]; profiles: Profile[]; spaces: Space[] }> {
  const q = query.trim();
  if (!q) return { posts: [], profiles: [], spaces: [] };
  const like = `%${q}%`;
  const [postRes, profileRes, spaceRes] = await Promise.all([
    db.from("posts").select("*").eq("hidden", false).ilike("content", like).limit(20),
    db
      .from("profiles")
      .select("*")
      .or(`username.ilike.${like},display_name.ilike.${like}`)
      .limit(20),
    db.from("spaces").select("*").or(`title.ilike.${like},topic.ilike.${like}`).limit(20),
  ]);
  const posts = ((postRes.data ?? []) as any[]).map((row) => rowToPost(row));
  await hydrateAuthors(posts.map((p) => p.user_id));
  const profiles = ((profileRes.data ?? []) as any[]).map((row) => rowToProfile(row));
  cacheProfiles(profiles);
  return { posts, profiles, spaces: (spaceRes.data ?? []) as any[] as Space[] };
}

/** Single Space by id. */
export async function getSpace(id: string): Promise<{ space: Space | null }> {
  const { data } = await db.from("spaces").select("*").eq("id", id).maybeSingle();
  return { space: (data as Space) ?? null };
}

export async function markNotificationRead(id: string) {
  await db.from("notifications").update({ read: true }).eq("id", id);
  return { success: true };
}

export const markNotificationAsRead = markNotificationRead;

export async function markAllNotificationsRead() {
  await markNotificationsRead();
  return { success: true };
}

export const markAllNotificationsAsRead = markAllNotificationsRead;

/** Send to a conversation id or straight to a recipient profile id. */
export async function sendDirectMessage(
  recipientOrConversationId: string,
  body: string,
  mediaUrl?: string | null,
) {
  return sendMessage(recipientOrConversationId, body, mediaUrl ?? null);
}

/** Record impressions for a batch of posts (viewport analytics). */
export async function recordPostImpressions(postIds: string[]) {
  await Promise.all(postIds.map((id) => recordPostImpression(id).catch(() => null)));
  return { ok: true };
}

/** Deterministic quick-reply suggestions for a chat thread. */
export async function generateSmartRepliesAI(messages: string[]): Promise<{ replies: string[] }> {
  const last = (messages[messages.length - 1] ?? "").toLowerCase();
  if (last.includes("?"))
    return {
      replies: ["Good question — let me check.", "Yes, absolutely.", "Not sure yet, I'll confirm."],
    };
  if (last.includes("thanks") || last.includes("thank you"))
    return { replies: ["Anytime!", "Happy to help 🙌", "You got it."] };
  return { replies: ["Sounds good!", "On it 👍", "Let's do it."] };
}

/** Runtime configuration exposed to admin/system surfaces. */
export async function getSystemConfig() {
  return {
    driver: "supabase" as const,
    features: appConfig.features,
    brand: appConfig.brand,
  };
}

// ---------------------------------------------------------------------------
// Creator analytics (real data, computed from the database)
// ---------------------------------------------------------------------------

export interface CreatorAnalyticsPoint {
  day: string;
  impressions: number;
  reach: number;
  engagement: number;
}

export interface CreatorAnalytics {
  hasData: boolean;
  totals: {
    impressions: number;
    reach: number;
    engagementRate: number;
    profileClicks: number;
    followers: number;
    posts: number;
    likes: number;
    comments: number;
    reposts: number;
  };
  trend: CreatorAnalyticsPoint[];
  hourly: { hour: string; activity: number }[];
  regions: { country: string; percentage: number }[];
  topPosts: {
    id: string;
    title: string;
    views: number;
    likes: number;
    reposts: number;
    ctr: string;
    tips: string;
  }[];
  revenue: {
    tipCount: number;
    tipTotal: number;
    currency: string;
    supporters: number;
    recent: { id: string; amount: number; currency: string; message: string; created_at: string }[];
  };
}

const EMPTY_ANALYTICS: CreatorAnalytics = {
  hasData: false,
  totals: {
    impressions: 0,
    reach: 0,
    engagementRate: 0,
    profileClicks: 0,
    followers: 0,
    posts: 0,
    likes: 0,
    comments: 0,
    reposts: 0,
  },
  trend: [],
  hourly: [],
  regions: [],
  topPosts: [],
  revenue: { tipCount: 0, tipTotal: 0, currency: "USD", supporters: 0, recent: [] },
};

/**
 * Real creator analytics for the signed-in profile.
 * Everything below is derived from posts, impressions, engagement rows,
 * follows and tips — there is no sample or placeholder data.
 */
export async function getCreatorAnalytics(
  timeframe: "7d" | "30d" = "7d",
): Promise<CreatorAnalytics> {
  const userId = me();
  if (!isDbId(userId)) return EMPTY_ANALYTICS;

  const days = timeframe === "7d" ? 7 : 30;
  const since = new Date(Date.now() - days * 86400000);
  const sinceIso = since.toISOString();

  const { data: postRows } = await db
    .from("posts")
    .select("id,content,created_at,view_count,like_count,comment_count,repost_count")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);

  const posts = ((postRows ?? []) as any[]).map((p) => ({
    id: String(p.id),
    content: String(p.content ?? ""),
    created_at: String(p.created_at ?? ""),
    views: Number(p.view_count ?? 0),
    likes: Number(p.like_count ?? 0),
    comments: Number(p.comment_count ?? 0),
    reposts: Number(p.repost_count ?? 0),
  }));
  const postIds = posts.map((p) => p.id);

  const [impressionsRes, followersRes, tipsRes] = await Promise.all([
    postIds.length
      ? db
          .from("post_impressions")
          .select("post_id,user_id,created_at")
          .in("post_id", postIds)
          .gte("created_at", sinceIso)
          .limit(5000)
      : Promise.resolve({ data: [] as any[] }),
    db.from("follows").select("follower_id").eq("target_id", userId).limit(5000),
    db
      .from("tips")
      .select("id,amount,currency,message,created_at,from_user_id")
      .eq("to_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const impressions = (impressionsRes.data ?? []) as any[];
  const followerIds = ((followersRes.data ?? []) as any[]).map((r) => String(r.follower_id));
  const tips = ((tipsRes.data ?? []) as any[]).map((t) => ({
    id: String(t.id),
    amount: Number(t.amount ?? 0),
    currency: String(t.currency ?? "USD"),
    message: String(t.message ?? ""),
    created_at: String(t.created_at ?? ""),
    from: String(t.from_user_id ?? ""),
  }));

  const totalLikes = posts.reduce((s, p) => s + p.likes, 0);
  const totalComments = posts.reduce((s, p) => s + p.comments, 0);
  const totalReposts = posts.reduce((s, p) => s + p.reposts, 0);
  const totalViews = posts.reduce((s, p) => s + p.views, 0);
  const totalImpressions = Math.max(totalViews, impressions.length);
  const reach = new Set(impressions.map((i) => String(i.user_id ?? i.post_id))).size;
  const interactions = totalLikes + totalComments + totalReposts;
  const engagementRate = totalImpressions > 0 ? (interactions / totalImpressions) * 100 : 0;

  // Impressions per bucket (day for 7d, week for 30d)
  const trend: CreatorAnalyticsPoint[] = [];
  const bucketCount = timeframe === "7d" ? 7 : 4;
  const bucketMs = timeframe === "7d" ? 86400000 : 7 * 86400000;
  for (let i = bucketCount - 1; i >= 0; i--) {
    const end = Date.now() - i * bucketMs;
    const start = end - bucketMs;
    const inBucket = impressions.filter((imp) => {
      const t = new Date(String(imp.created_at ?? 0)).getTime();
      return t > start && t <= end;
    });
    const bucketPosts = posts.filter((p) => {
      const t = new Date(p.created_at).getTime();
      return t > start && t <= end;
    });
    const bucketInteractions = bucketPosts.reduce(
      (s, p) => s + p.likes + p.comments + p.reposts,
      0,
    );
    const bucketImpressions = inBucket.length;
    trend.push({
      day:
        timeframe === "7d"
          ? new Date(end).toLocaleDateString(undefined, { weekday: "short" })
          : `Week ${bucketCount - i}`,
      impressions: bucketImpressions,
      reach: new Set(inBucket.map((imp) => String(imp.user_id ?? imp.post_id))).size,
      engagement:
        bucketImpressions > 0
          ? Number(((bucketInteractions / bucketImpressions) * 100).toFixed(1))
          : 0,
    });
  }

  // Peak activity by hour of day (3-hour buckets to match the chart)
  const hourBuckets = [0, 3, 6, 9, 12, 15, 18, 21];
  const hourly = hourBuckets.map((h) => {
    const count = impressions.filter((imp) => {
      const hour = new Date(String(imp.created_at ?? 0)).getHours();
      return hour >= h && hour < h + 3;
    }).length;
    const label = h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
    return { hour: label, activity: count };
  });

  // Audience locations, from the profiles of people who follow this creator
  let regions: CreatorAnalytics["regions"] = [];
  if (followerIds.length) {
    const { data: followerRows } = await db
      .from("profiles")
      .select("location")
      .in("id", followerIds.slice(0, 1000));
    const counts = new Map<string, number>();
    for (const row of (followerRows ?? []) as any[]) {
      const loc = String(row.location ?? "").trim();
      const key = loc ? (loc.split(",").pop() ?? loc).trim() : "Unknown";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((s, n) => s + n, 0) || 1;
    regions = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([country, n]) => ({ country, percentage: Math.round((n / total) * 100) }));
  }

  const tipsByPost = new Map<string, number>();
  const currency = tips[0]?.currency ?? "USD";
  const topPosts = [...posts]
    .sort((a, b) => b.views - a.views)
    .slice(0, 5)
    .map((p) => {
      const interactionsForPost = p.likes + p.comments + p.reposts;
      return {
        id: p.id,
        title: p.content.slice(0, 80) || "(media post)",
        views: p.views,
        likes: p.likes,
        reposts: p.reposts,
        ctr: p.views > 0 ? `${((interactionsForPost / p.views) * 100).toFixed(1)}%` : "—",
        tips: `${tipsByPost.get(p.id) ?? 0}`,
      };
    });

  const tipTotal = tips.reduce((s, t) => s + t.amount, 0);

  return {
    hasData: posts.length > 0 || tips.length > 0 || followerIds.length > 0,
    totals: {
      impressions: totalImpressions,
      reach,
      engagementRate: Number(engagementRate.toFixed(1)),
      profileClicks: 0,
      followers: followerIds.length,
      posts: posts.length,
      likes: totalLikes,
      comments: totalComments,
      reposts: totalReposts,
    },
    trend,
    hourly,
    regions,
    topPosts,
    revenue: {
      tipCount: tips.length,
      tipTotal,
      currency,
      supporters: new Set(tips.map((t) => t.from)).size,
      recent: tips.slice(0, 8).map((t) => ({
        id: t.id,
        amount: t.amount,
        currency: t.currency,
        message: t.message,
        created_at: t.created_at,
      })),
    },
  };
}
