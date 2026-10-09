/**
 * Data access layer for the Spaces1 app. All calls go through the Supabase
 * backend (PostgREST + RLS) with defensive mapping so the UI keeps working while
 * the schema evolves.
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
import { sanitizeReactionEmoji } from "@/lib/emojis";
import { tipAnnouncement } from "@/lib/space-reactions";
import { MAX_SPACE_CHAT_CHARS, lengthError, messageLengthError } from "@/lib/message-length";
import {
  callCardFromRow,
  callCardsFromRows,
  type CallCard,
  type CallRowLike,
} from "@/lib/call-cards";
import { emitRealtime } from "@/lib/realtime";
import { errorMessage } from "@/lib/error-messages";
import { firstMedia } from "@/lib/media-list";
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
  WorkspaceIdentity,
} from "@/lib/types";

const db = supabase as any;

/** A participant row is treated as present for this long; the heartbeat is
 * comfortably faster so an open room never expires its own members. */
export const SPACE_STALE_SECONDS = 90;
export const SPACE_HEARTBEAT_MS = 25_000;

function nowIso() {
  return new Date().toISOString();
}

function me() {
  return currentUserId || currentUser.id;
}

/**
 * True only when there is a live authenticated session — an access token the
 * REST client will actually attach as a bearer. The post_impressions INSERT
 * policy is `to authenticated` and anon writes are revoked, so a cached profile
 * id with an expired/absent token would send the POST under the anon role and
 * 403. Gate the best-effort impression write on the session itself, not merely
 * on having a profile id sitting in memory.
 */
async function hasAuthSession(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    return Boolean(data.session?.access_token);
  } catch {
    return false;
  }
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
    // Moderation state: the admin console lists hidden posts too, so it can
    // restore one. Feeds never see them (they filter on hidden = false).
    hidden: Boolean(row.hidden),
    // Sensitive media is a reader filter, not a takedown: the row is always
    // returned, and each viewer's privacy preference decides whether to blur it.
    is_sensitive: Boolean(row.is_sensitive),
    sensitive_source: row.sensitive_source ?? null,
    workspace_id: row.workspace_id ?? null,
    ...extras,
  };
}

export interface PostsPageOptions {
  limit?: number;
  userId?: string;
  /** Alias of `userId`, kept for call sites that speak in author terms. */
  authorId?: string;
  /** Restrict to posts published on behalf of one team workspace. */
  workspaceId?: string;
  tag?: string;
  before?: string;
  /** Opaque `(score, id)` cursor for the ranked "For you" feed. */
  cursor?: string;
  following?: boolean;
  bookmarked?: boolean;
  filter?: "foryou" | "following" | "latest";
  /** Manual refresh: bypass the ranker's frozen epoch and re-rank with live time. */
  refresh?: boolean;
}

export interface PostsPage {
  posts: Post[];
  /** Cursor to pass back for the next page, or `null` when the feed is exhausted. */
  nextCursor: string | null;
}

/**
 * Cursor-paginated post fetch used by the feed's infinite scroll. "For you" is
 * served as a bounded read of a precomputed timeline (ranked in the background
 * worker) and pages via the ranker's composite cursor; every other filter pages
 * chronologically via a `created_at` (`before`) cursor. Keeping the cursor
 * server-authoritative means a page never returns duplicate rows.
 */
export async function getPostsPage(options: PostsPageOptions = {}): Promise<PostsPage> {
  if (options.bookmarked)
    return { posts: await getBookmarkedPosts(options.limit ?? 50), nextCursor: null };
  // "For you" is a plain read of the materialized timeline — the ranker runs in
  // the background worker, never here, so there is no request-time work to bound
  // (the old 9s withBudget guard is gone). A genuine failure still degrades to
  // the recency query below.
  if (options.filter === "foryou" && !options.userId && !options.tag && isDbId(me())) {
    try {
      const { getForYouPosts } = await import("@/lib/recommendations.functions");
      const res: any = await getForYouPosts({
        data: {
          limit: Math.min(options.limit ?? appConfig.feed.pageSize, appConfig.feed.maxPageSize),
          cursor: options.cursor,
          refresh: options.refresh,
        },
      });
      const ranked = (res?.posts ?? []).map((row: any) => rowToPost(row));
      if (ranked.length > 0) {
        await hydrateAuthors(ranked.map((p: Post) => p.user_id));
        await hydrateWorkspaces(ranked);
        await hydrateEngagement(ranked);
        return { posts: ranked, nextCursor: res?.nextCursor ?? null };
      }
      // The ranker answered with an empty page. On a pagination request (the
      // cursor is set) that IS the end of "For you": falling through to the
      // recency query below would re-serve the NEWEST page (a ranked cursor
      // has no `before` for it to continue from), the feed's dedupe would drop
      // every row, and `nextCursor` would keep `hasMore` alive — the spinner
      // looped forever at the end of all posts. End the walk honestly instead.
      if (options.cursor) return { posts: [], nextCursor: null };
    } catch (err) {
      console.warn("For you feed unavailable, using recency:", err);
      // Same rule for a failed ranker mid-paging: the chronological fallback
      // cannot resume a ranked walk, so hand back a terminal page rather than
      // a duplicate of the top of the feed.
      if (options.cursor) return { posts: [], nextCursor: null };
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
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);
  if (options.before) query = query.lt("created_at", options.before);
  // `tags` is a jsonb array column. PostgREST's `cs` (contains) operator needs
  // a valid JSON value on the right-hand side, so pass a JSON-array string
  // (`["ai"]`) rather than a JS array — the latter serialises to the native
  // `cs.{ai}` form, which the server rejects with "invalid input syntax for type json".
  if (options.tag) query = query.contains("tags", JSON.stringify([options.tag]));
  if (options.following) {
    // Same follow-graph read the profile buttons use; one query shape to keep
    // aligned with the `follows` RLS policies.
    const ids = await getFollowingIds();
    if (ids.length === 0) return { posts: [], nextCursor: null };
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
  await hydrateWorkspaces(posts);
  await hydrateEngagement(posts);
  // Chronological cursor: continue strictly older than the last returned row.
  const last = posts[posts.length - 1];
  const nextCursor = posts.length === limit && last ? last.created_at : null;
  return { posts, nextCursor };
}

export async function getPosts(options: PostsPageOptions = {}): Promise<Post[]> {
  return (await getPostsPage(options)).posts;
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
  await hydrateWorkspaces(posts);
  await hydrateEngagement(posts);
  return posts;
}

/**
 * Poll tallies come back as counts, never as ballots.
 *
 * `poll_votes` used to be world-readable and were counted in the browser, which
 * published who picked what on every poll (a "which tool should we use?" poll
 * becoming a public list of colleagues' answers) and downloaded one row per
 * vote per feed page. `poll_tallies()` answers only the two questions a card
 * asks — votes per option, and whether *this* viewer is one of them — with the
 * viewer resolved inside Postgres from `auth.uid()`, which is what let the
 * per-voter read be revoked (migration 20261001000096).
 */
async function hydratePolls(posts: Post[]) {
  const withPolls = posts.filter((p) => p.poll && (p.poll as any).options?.length && isDbId(p.id));
  if (withPolls.length === 0) return;
  const { data, error } = await db.rpc("poll_tallies", {
    _post_ids: withPolls.map((p) => p.id),
  });
  const rows = ((data ?? []) as TallyRow[]).filter((r) => r && r.post_id);
  if (error) {
    // Missing counts is a real state; zero counts are a lie about a live poll.
    // Mark it so the card says "not loading" instead of drawing an empty result.
    console.warn("poll tallies failed:", error.message);
    for (const post of withPolls) (post.poll as any).resultsUnavailable = true;
    return;
  }
  const byPost = new Map<string, TallyRow[]>();
  for (const row of rows) {
    const list = byPost.get(row.post_id) ?? [];
    list.push(row);
    byPost.set(row.post_id, list);
  }
  for (const post of withPolls) {
    const tallies = byPost.get(post.id) ?? [];
    const poll = post.poll as any;
    const mine = tallies.find((t) => t.voted_by_me)?.option_id;
    poll.options = poll.options.map((o: any) => {
      const tally = tallies.find((t) => t.option_id === o.id);
      return {
        ...o,
        votes: Number(tally?.votes ?? 0),
        votedByMe: tally?.voted_by_me === true,
      };
    });
    poll.totalVotes = tallies.reduce((sum, t) => sum + Number(t.votes ?? 0), 0);
    poll.hasVoted = Boolean(mine);
    poll.userVotedOptionId = mine;
    poll.resultsUnavailable = false;
  }
}

/** One row of `poll_tallies`: an option's count, plus this viewer's own choice. */
interface TallyRow {
  post_id: string;
  option_id: string;
  votes: number | string;
  voted_by_me: boolean;
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

export async function hydrateAuthors(ids: string[]) {
  const unique = Array.from(new Set(dbIds(ids)));
  if (unique.length === 0) return;
  const { data } = await db.from("profiles").select("*").in("id", unique);
  if (data) cacheProfiles((data as any[]).map(rowToProfile));
}

// Brand identity for team-workspace posts, cached by workspace id so a feed
// with many posts from one team only hits `workspaces` once.
const workspaceCache = new Map<string, WorkspaceIdentity>();
async function hydrateWorkspaces(posts: Post[]) {
  const ids = Array.from(new Set(posts.map((p) => p.workspace_id).filter(isDbId) as string[]));
  if (ids.length === 0) return;
  const missing = ids.filter((id) => !workspaceCache.has(id));
  if (missing.length) {
    // Read the *public* identity through the SECURITY DEFINER function rather
    // than the `workspaces` table: that table is only visible to the owner and
    // its members, so a plain SELECT would drop the brand for everyone else and
    // a team post would misleadingly render under the individual author. The
    // function exposes name/logo/avatar to anyone who can already see the post.
    const { data: rows } = await db
      .from("workspaces")
      .select("id, name, logo_emoji, avatar_url")
      .in("id", missing);
    const seen = new Set<string>();
    for (const w of (rows ?? []) as any[]) {
      workspaceCache.set(String(w.id), {
        id: String(w.id),
        name: String(w.name ?? "Workspace"),
        logoEmoji: String(w.logo_emoji ?? "✨"),
        avatarUrl: w.avatar_url ?? null,
      });
      seen.add(String(w.id));
    }
    // Fall back to the public-profile RPC for teams this viewer can't read
    // directly (i.e. teams they aren't a member of).
    for (const id of missing) {
      if (seen.has(id)) continue;
      const { data } = await db.rpc("get_workspace_profile", { _workspace_id: id });
      const w = (Array.isArray(data) ? data[0] : data) as any;
      if (w) {
        workspaceCache.set(String(w.id), {
          id: String(w.id),
          name: String(w.name ?? "Workspace"),
          logoEmoji: String(w.logo_emoji ?? "✨"),
          avatarUrl: w.avatar_url ?? null,
        });
      }
    }
  }
  for (const p of posts) {
    if (p.workspace_id) p.workspace = workspaceCache.get(p.workspace_id) ?? null;
  }
}

export async function createPost(input: {
  content: string;
  image_gradient?: string | undefined;
  media_url?: string | undefined;
  tags?: string[];
  poll?: any;
  /** Publish on behalf of a team workspace (RLS enforces Owner/Admin/Editor). */
  workspaceId?: string | null;
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
      workspace_id: input.workspaceId && isDbId(input.workspaceId) ? input.workspaceId : null,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message || "Could not publish your post");

  await hydrateAuthors([userId]);
  const post = rowToPost(data);
  await hydrateWorkspaces([post]);
  emitRealtime("post:created", post);
  return { ...post, post } as Post & { post: Post };
}

export async function getPostById(id: string): Promise<Post | null> {
  if (!isDbId(id)) return null;
  const { data, error } = await db.from("posts").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  const post = rowToPost(data);
  await hydrateAuthors([post.user_id]);
  await hydrateWorkspaces([post]);
  await hydrateEngagement([post]);
  return post;
}

export async function deletePost(id: string) {
  // The media URL is not read first any more: since 20261006000001 the
  // durability contract is that uploaded bytes are never erased by a row
  // delete, so there is nothing to reclaim here. The `media_objects` ledger
  // keeps its ownership row so the bytes still resolve to a real owner if
  // they are ever listed for moderation.
  const { error } = await db.from("posts").delete().eq("id", id);
  if (error) {
    // Surface the failure (e.g. RLS denial for a non-owner) instead of
    // reporting a delete that never happened.
    throw new Error(error.message || "Could not delete that post");
  }
  // Durability contract (see 20261006000001): deleting a post does NOT erase
  // the underlying bytes. Any embed, saved link, or archive that still points
  // at the media URL continues to resolve, and authenticated users cannot
  // issue a storage DELETE at all (the RLS policy no longer grants it).
  emitRealtime("post:deleted", { id });
  return { ok: true };
}

/**
 * Read a trigger-maintained tally column (`posts.like_count`, `stories.likes_count`).
 * `null` when the row is unreadable — deleted mid-click, or hidden by the
 * viewer's access rules — so callers can fall back to a live count.
 */
async function readTally(table: string, column: string, id: string): Promise<number | null> {
  const { data } = await db.from(table).select(column).eq("id", id).maybeSingle();
  const value = Number((data as Record<string, unknown> | null)?.[column]);
  return Number.isFinite(value) ? value : null;
}

/** Live `COUNT(*)` over a join table, used only when there is no tally to read. */
async function countRows(table: string, column: string, id: string): Promise<number | null> {
  const { count } = await db
    .from(table)
    .select(column, { count: "exact", head: true })
    .eq(column, id);
  return count ?? null;
}

/**
 * Toggle a (post, viewer) join row and return the viewer's new state together
 * with the *same* tally the feed renders. The counter columns are maintained by
 * AFTER triggers with the identical `count(*)` formula, but a toggle that
 * re-counted the join table itself would report a different number than the one
 * already on screen whenever a counter had drifted — the heart would fill while
 * the figure beside it moved the wrong way. Reading the column back after the
 * write keeps flag and count in one agreement; the count is only a fallback for
 * relations that have no counter column (bookmarks).
 */
async function toggleRelation(
  table: string,
  postId: string,
  event: string,
  countField: string,
  tallyColumn?: string,
) {
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

  const count =
    (tallyColumn ? await readTally("posts", tallyColumn, postId) : null) ??
    (await countRows(table, "post_id", postId)) ??
    (active ? 1 : 0);

  const result = { active, count };
  emitRealtime(event, { id: postId, postId, [countField]: result.count, active: result.active });
  return result;
}

/**
 * Ids of every workspace the viewer belongs to (owned or active membership).
 * Cached per session because engagement hydration runs on every feed page and
 * membership changes are rare — the workspace desk re-hydrates on demand.
 */
let wsIdsCache: { userId: string; ids: string[] } | null = null;
async function myWorkspaceIds(userId: string): Promise<string[]> {
  if (wsIdsCache?.userId === userId) return wsIdsCache.ids;
  const [{ data: memberRows }, { data: ownedRows }] = await Promise.all([
    db
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .eq("status", "active"),
    db.from("workspaces").select("id").eq("owner_id", userId),
  ]);
  const ids = [
    ...new Set([
      ...((memberRows ?? []) as any[]).map((r) => String(r.workspace_id)),
      ...((ownedRows ?? []) as any[]).map((r) => String(r.id)),
    ]),
  ].filter(isDbId);
  wsIdsCache = { userId, ids };
  return ids;
}

export async function toggleLikePost(postId: string) {
  const { active, count } = await toggleRelation(
    "likes",
    postId,
    "post_like_updated",
    "likeCount",
    "like_count",
  );
  return { liked: active, likeCount: count, likesCount: count };
}

/**
 * Repost with either your own name or an active team's. The row remembers which
 * identity acted (`workspace_id`), the DB keeps one repost per (post, person)
 * personally and one per (post, team), and RLS only lets Owners/Admins/Editors
 * repost for a team. Undoing prefers the team row when posting as a team, then
 * falls back to the personal row so a member can always take it back.
 */
export async function toggleRepostPost(postId: string, workspaceId?: string | null) {
  if (!workspaceId) {
    const userId = me();
    if (!isDbId(userId)) throw new Error("Sign in to interact with posts");
    if (!isDbId(postId)) throw new Error("This is sample content and can't be saved.");

    // Personal rows are exactly the ones without a workspace identity.
    const { data: existing, error: readError } = await db
      .from("reposts")
      .select("post_id")
      .eq("post_id", postId)
      .eq("user_id", userId)
      .is("workspace_id", null)
      .maybeSingle();
    if (readError) throw new Error(readError.message);

    const active = !existing;
    if (existing) {
      const { error } = await db
        .from("reposts")
        .delete()
        .eq("post_id", postId)
        .eq("user_id", userId)
        .is("workspace_id", null);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db.from("reposts").insert({ post_id: postId, user_id: userId });
      if (error && error.code !== "23505") throw new Error(error.message);
    }

    const count =
      (await readTally("posts", "repost_count", postId)) ??
      (await countRows("reposts", "post_id", postId)) ??
      (active ? 1 : 0);
    emitRealtime("post_repost_updated", { id: postId, postId, repostCount: count, active });
    return { reposted: active, repostCount: count };
  }

  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to repost");
  if (!isDbId(postId)) throw new Error("This is sample content and can't be reposted.");

  const { data: teamRow } = await db
    .from("reposts")
    .select("post_id")
    .eq("post_id", postId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (teamRow) {
    const { error } = await db
      .from("reposts")
      .delete()
      .eq("post_id", postId)
      .eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
  } else {
    const { data: personalRow } = await db
      .from("reposts")
      .select("post_id")
      .eq("post_id", postId)
      .eq("user_id", userId)
      .is("workspace_id", null)
      .maybeSingle();
    if (personalRow) {
      const { error } = await db
        .from("reposts")
        .delete()
        .eq("post_id", postId)
        .eq("user_id", userId)
        .is("workspace_id", null);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db
        .from("reposts")
        .insert({ post_id: postId, user_id: userId, workspace_id: workspaceId });
      // 23505 = the team already reposted this post; the state hydration below
      // still resolves the button to "reposted", so swallow it quietly.
      if (error && error.code !== "23505") throw new Error(error.message);
    }
  }

  const [{ count: exactCount }, wsIds] = await Promise.all([
    db.from("reposts").select("post_id", { count: "exact", head: true }).eq("post_id", postId),
    myWorkspaceIds(userId),
  ]);
  const { data: rows } = await db
    .from("reposts")
    .select("user_id, workspace_id")
    .eq("post_id", postId);
  const active = ((rows ?? []) as any[]).some(
    (r) => r.user_id === userId || (r.workspace_id && wsIds.includes(String(r.workspace_id))),
  );
  // Same tally the feed renders, falling back to a live count only if the post
  // row is unreadable.
  const count = (await readTally("posts", "repost_count", postId)) ?? exactCount ?? 0;

  emitRealtime("post_repost_updated", { id: postId, postId, repostCount: count, active });
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
  // "Reposted" covers any identity the viewer acts through: their own row or a
  // row belonging to one of their teams (the team reposts once, for everyone).
  const [likes, reposts, bookmarks, teamReposts] = await Promise.all([
    db.from("likes").select("post_id").eq("user_id", userId).in("post_id", realIds),
    db
      .from("reposts")
      .select("post_id")
      .eq("user_id", userId)
      .is("workspace_id", null)
      .in("post_id", realIds),
    db.from("bookmarks").select("post_id").eq("user_id", userId).in("post_id", realIds),
    myWorkspaceIds(userId).then((wsIds) =>
      wsIds.length
        ? db.from("reposts").select("post_id").in("workspace_id", wsIds).in("post_id", realIds)
        : Promise.resolve({ data: [] as any[] }),
    ),
  ]);
  const pick = (r: any) => ((r.data ?? []) as any[]).map((x) => String(x.post_id));
  const teamIds = ((teamReposts.data ?? []) as any[]).map((x) => String(x.post_id));
  return {
    liked: pick(likes),
    reposted: Array.from(new Set([...pick(reposts), ...teamIds])),
    bookmarked: pick(bookmarks),
  };
}

/** Posts this team has reposted, newest repost first — the profile's Reposts tab. */
export async function getWorkspaceReposts(workspaceId: string, limit = 50): Promise<Post[]> {
  if (!isDbId(workspaceId)) return [];
  const { data } = await db
    .from("reposts")
    .select("created_at, posts(*)")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  const posts = ((data ?? []) as any[])
    .map((row) => (row.posts && !row.posts.hidden ? rowToPost(row.posts) : null))
    .filter(Boolean) as Post[];
  await hydrateAuthors(posts.map((p) => p.user_id));
  await hydrateWorkspaces(posts);
  await hydrateEngagement(posts);
  return posts;
}

export type ProfileTabPage = "posts" | "media" | "reposts" | "likes";

export interface ProfileTabResult {
  posts: Post[];
  /** Cursor for the next page, or null once the tab is exhausted. */
  nextCursor: string | null;
  /** Exact row count for the tab, so the header never shows a page-length "total". */
  total: number;
}

const EMPTY_TAB: ProfileTabResult = { posts: [], nextCursor: null, total: 0 };

/**
 * One profile tab, fetched the way the tab actually means it.
 *
 * The profile page used to slice the *author's own posts* three ways and call
 * the results Reposts, Media and Likes. That can only ever be empty for two of
 * them: the posts you reposted and the posts you liked belong to other people,
 * so they are never in a list of this author's posts, and `repostedByMe` on your
 * own post is never true. Reposts and Likes therefore read the join tables by
 * profile id; Media asks the database instead of filtering a page of 15 down to
 * whatever happened to have a picture.
 *
 * `likes.public read` and `reposts.public read` are `using (true)`, so no new
 * policy is needed; Likes stays only on the tabs of your own profile, because
 * somebody else's likes are not ours to publish.
 */
export async function getProfileTabPage(options: {
  profileId: string;
  tab: ProfileTabPage;
  before?: string | null;
  limit?: number;
}): Promise<ProfileTabResult> {
  const { profileId, tab } = options;
  if (!isDbId(profileId)) return EMPTY_TAB;
  const limit = Math.min(options.limit ?? appConfig.feed.pageSize, appConfig.feed.maxPageSize);

  if (tab === "posts" || tab === "media") {
    let query = db
      .from("posts")
      .select("*", { count: "exact" })
      .eq("user_id", profileId)
      .eq("hidden", false)
      .order("created_at", { ascending: false })
      .limit(limit);
    // Uploaded attachments live only in `media_url`; the `posts` table has no
    // `image_url` column, and referencing one made PostgREST reject the whole
    // filter so the Media tab came back empty even for profiles that have media.
    if (tab === "media") query = query.not("media_url", "is", null);
    if (options.before) query = query.lt("created_at", options.before);
    const { data, error, count } = await query;
    if (error) console.warn("getProfileTabPage notice:", error.message);
    const rows = (data ?? []) as any[];
    const posts = rows.map((row) => rowToPost(row));
    await hydrateAuthors(posts.map((p) => p.user_id));
    await hydrateWorkspaces(posts);
    await hydrateEngagement(posts);
    return {
      posts,
      nextCursor: rows.length === limit ? String(rows[rows.length - 1].created_at) : null,
      total: count ?? rows.length,
    };
  }

  // Reposts and Likes are activity on somebody else's post, so the join row's
  // own timestamp orders the tab (newest reaction first) and carries the cursor.
  const table = tab === "reposts" ? "reposts" : "likes";
  let query = db
    .from(table)
    .select("created_at, post_id, posts(*)", { count: "exact" })
    .eq("user_id", profileId)
    .order("created_at", { ascending: false })
    // Over-fetch a little: a repost whose post was deleted or hidden yields no
    // card, and a page that silently returns 3 of 15 items looks broken.
    .limit(limit + 5);
  if (options.before) query = query.lt("created_at", options.before);
  const { data, error, count } = await query;
  if (error) {
    console.warn("getProfileTabPage notice:", error.message);
    return EMPTY_TAB;
  }
  const rows = (data ?? []) as any[];
  const posts = rows
    .filter((row) => row.posts && !row.posts.hidden)
    .slice(0, limit)
    .map((row) => rowToPost(row.posts));
  await hydrateAuthors(posts.map((p) => p.user_id));
  await hydrateWorkspaces(posts);
  await hydrateEngagement(posts);
  const last = rows[Math.min(rows.length, limit) - 1];
  return {
    posts,
    nextCursor: rows.length > limit ? String(last?.created_at ?? null) : null,
    total: count ?? rows.length,
  };
}

export async function addPostComment(postId: string, content: string, parentId?: string | null) {
  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to comment");
  if (!isDbId(postId)) throw new Error("This is sample content and can't be commented on.");
  if (parentId && !isDbId(parentId)) throw new Error("That reply target isn't real yet.");

  const { data: dataRow, error } = await db
    .from("comments")
    .insert({
      post_id: postId,
      user_id: userId,
      content,
      ...(parentId ? { parent_id: parentId } : {}),
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message || "Could not post your comment");

  const comment: PostComment = {
    id: dataRow.id,
    post_id: postId,
    user_id: userId,
    content,
    created_at: dataRow.created_at ?? nowIso(),
    parent_id: dataRow.parent_id ?? parentId ?? null,
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

/** Owner-only edit (RLS: "comments owner update"); stamps edited_at like editPost does. */
export async function editPostComment(commentId: string, content: string): Promise<PostComment> {
  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to edit comments");
  if (!isDbId(commentId)) throw new Error("That comment isn't real yet.");
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Comment can't be empty.");

  const editedAt = nowIso();
  const { data, error } = await db
    .from("comments")
    .update({ content: trimmed, edited_at: editedAt })
    .eq("id", commentId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  // Empty result means RLS filtered it (not our row) — never claim success.
  if (error) throw new Error(error.message || "Could not edit your comment");
  if (!data) throw new Error("You can only edit your own comments.");

  emitRealtime("comment_updated", {
    commentId,
    postId: data.post_id,
    content: trimmed,
    editedAt,
  });
  return data as PostComment;
}

/**
 * Owner delete (RLS: "comments owner delete"). replies cascade in the DB
 * (parent_id on delete cascade) and posts.comment_count is fixed by the
 * t_comments_after trigger, so the client only mirrors the list locally.
 */
export async function deletePostComment(commentId: string, postId: string) {
  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to delete comments");
  if (!isDbId(commentId)) throw new Error("That comment isn't real yet.");

  const { error } = await db.from("comments").delete().eq("id", commentId).eq("user_id", userId);
  if (error) {
    // Surface the failure (e.g. RLS denial for someone else's comment)
    // instead of reporting a delete that never happened.
    throw new Error(error.message || "Could not delete your comment");
  }
  emitRealtime("comment_deleted", { commentId, postId });
  return { ok: true };
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
 * One vote per person, stored as its own row. Tallies are always recounted by
 * the database from those rows so nobody inherits somebody else's choice, and
 * no viewer ever receives another person's ballot.
 */
export async function votePoll(postId: string, optionId: string) {
  const userId = me();
  if (!userId || userId === "guest") throw new Error("Sign in to vote");
  if (!isDbId(postId) || !isDbId(userId))
    throw new Error("Voting isn't available on sample posts.");
  // Owner-scoped read (migration 20261001000096): this can only ever find *our*
  // row, so the pre-check is a friendly message and the unique index below is
  // the actual guarantee under a double click.
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

  const { data: tallyRows, error: tallyError } = await db.rpc("poll_tallies", {
    _post_ids: [postId],
  });
  if (tallyError) {
    // The vote is stored — say so — but the counts are unknown, so the card is
    // told not to render a total it does not have.
    console.warn("poll tallies failed after vote:", tallyError.message);
    poll.options = poll.options.map((o: any) => ({ ...o, votedByMe: o.id === optionId }));
    poll.hasVoted = true;
    poll.userVotedOptionId = optionId;
    poll.resultsUnavailable = true;
    return { poll };
  }
  const rows = (tallyRows ?? []) as TallyRow[];
  const counts = new Map(rows.map((r) => [r.option_id, Number(r.votes ?? 0)]));
  const total = rows.reduce((sum, r) => sum + Number(r.votes ?? 0), 0);

  const tallies = poll.options.map((o: any) => ({ id: o.id, votes: counts.get(o.id) ?? 0 }));
  poll.options = poll.options.map((o: any) => ({
    ...o,
    votes: counts.get(o.id) ?? 0,
    votedByMe: o.id === optionId,
  }));
  poll.totalVotes = total;
  poll.hasVoted = true;
  poll.userVotedOptionId = optionId;
  poll.resultsUnavailable = false;

  // Everyone else gets the counts only — their own vote state stays theirs.
  emitRealtime("poll_updated", { postId, tallies, totalVotes: total });
  return { poll };
}

export async function recordPostImpression(postId: string) {
  // Routed through the shared impression queue so a feed scroll costs ONE
  // batched POST per flush window, not one per card that intersects the
  // viewport. The updated tally comes back on the `post_view_updated` realtime
  // event the flush emits, so nothing here needs to await the write.
  queuePostImpression(postId);
}

/* ---------------------------------------------------------------- stories */

function rowToStory(row: any): Story {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type ?? (row.media_url ? "image" : "gradient"),
    gradient: row.gradient ?? undefined,
    media_url: row.media_url ?? undefined,
    // media_url may hold several comma-joined attachments; single-URL
    // consumers (image_url) must never receive the joined string.
    image_url: firstMedia(row.media_url) ?? undefined,
    text: row.text ?? undefined,
    caption: row.caption ?? undefined,
    created_at: row.created_at ?? nowIso(),
    expires_at: row.expires_at ?? nowIso(),
    view_count: row.view_count ?? 0,
    likes_count: row.likes_count ?? 0,
    // Explicit: `undefined` and `false` rendering the same today is a coincidence
    // that makes a missing hydration pass invisible.
    likedByMe: false,
    location: row.location ?? undefined,
    mood: row.mood ?? undefined,
    stickers: row.stickers ?? [],
  };
}

export async function getStories(): Promise<Story[]> {
  try {
    // Stories live for 24 hours. Filter server-side on `expires_at` so expired
    // stories never load into the rail, regardless of how long a row lingers
    // before the nightly cleanup removes it. The rail is a horizontal strip of
    // the most-recent items, so a generous ceiling bounds the boot-path payload
    // on a large deployment without dropping anything a viewer would reach.
    const { data } = await db
      .from("stories")
      .select("*")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(300);
    const stories = (data ?? []).map(rowToStory);
    if (stories.length > 0) {
      await hydrateAuthors(stories.map((s: Story) => s.user_id));
      await hydrateStoryLikes(stories);
      return stories;
    }
  } catch (err) {
    console.warn("getStories notice:", err);
  }
  return [];
}

/**
 * Stamp each story with the viewer's own like. `likes_count` already includes
 * their like, so without this the story opens with an empty heart next to a
 * number that counts them — the post feed gets the same treatment from
 * `hydrateEngagement`.
 */
async function hydrateStoryLikes(stories: Story[]) {
  const userId = me();
  const ids = dbIds(stories.map((s) => s.id));
  if (!isDbId(userId) || ids.length === 0) return;
  try {
    const { data } = await db
      .from("story_likes")
      .select("story_id")
      .eq("user_id", userId)
      .in("story_id", ids);
    const rows = (data ?? []) as { story_id: string }[];
    const mine = new Set(rows.map((r) => String(r.story_id)));
    for (const story of stories) story.likedByMe = mine.has(String(story.id));
  } catch (err) {
    console.warn("story likes hydration skipped:", err);
  }
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
  // Same durability contract as posts: the story row disappears, the bytes
  // it referenced do not. `media-private` keeps the object owner-scoped so
  // the retired media is unreadable by anyone but its uploader, and future
  // moderation / reclaim flows can act on the ledger deliberately instead
  // of an implicit erase on user action.
  const { error } = await db.from("stories").delete().eq("id", id);
  if (error) throw error;
  emitRealtime("story:deleted", { id });
  return { ok: true };
}

export async function toggleLikeStory(storyId: string) {
  const userId = me();
  if (!isDbId(userId)) throw new Error("Sign in to like stories");
  if (!isDbId(storyId)) throw new Error("This story is no longer available.");

  const { data: existing, error: readError } = await db
    .from("story_likes")
    .select("story_id")
    .eq("story_id", storyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const liked = !existing;
  if (existing) {
    const { error } = await db
      .from("story_likes")
      .delete()
      .eq("story_id", storyId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db.from("story_likes").insert({ story_id: storyId, user_id: userId });
    // 23505: the (story_id,user_id) primary key already exists — another tab
    // liked it first, which is the state we were aiming for anyway.
    if (error && error.code !== "23505") throw new Error(error.message);
  }

  // Read back the counter the rail and modal render, so the heart and the number
  // beside it always come from the same write.
  const likesCount =
    (await readTally("stories", "likes_count", storyId)) ??
    (await countRows("story_likes", "story_id", storyId)) ??
    (liked ? 1 : 0);
  emitRealtime("story_like_updated", { storyId, liked, likesCount });
  return { liked, likesCount };
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

/**
 * Paged slice of the creator directory. The "view all creators" grid asks for
 * one chunk at a time instead of pulling the whole table into memory.
 * Ordered by newest join so pages are stable while more members arrive.
 */
export async function getCreatorsPage(
  options: { limit?: number; offset?: number } = {},
): Promise<Profile[]> {
  const limit = Math.min(options.limit ?? 12, 50);
  const offset = Math.max(0, options.offset ?? 0);
  try {
    const { data } = await db
      .from("profiles")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    const profiles = ((data ?? []) as any[]).map(rowToProfile).filter((p: Profile) => p?.id);
    cacheProfiles(profiles);
    return profiles;
  } catch (err) {
    console.warn("getCreatorsPage notice:", err);
    return [];
  }
}

export const USERNAME_REGEX = /^[a-z0-9_]{3,18}$/;

/** Strip a leading @, trim and lowercase — the canonical handle form. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/** Is this handle free (optionally ignoring the current owner's own row)? */
export async function isUsernameAvailable(username: string, exceptId?: string): Promise<boolean> {
  const u = normalizeUsername(username);
  if (!USERNAME_REGEX.test(u)) return false;
  let query = db.from("profiles").select("id").eq("username", u);
  // Only exclude a real row: a placeholder id like "guest" would make
  // PostgREST cast a non-uuid against the uuid column and 400.
  if (exceptId && isDbId(exceptId)) query = query.neq("id", exceptId);
  const { data } = await query.maybeSingle();
  return !data;
}

export async function updateUserProfile(patch: Partial<Profile>) {
  const meId = me();
  // Guests have a placeholder profile id; PATCHing `id=eq.guest` used to hit
  // the DB with an invalid uuid cast and fail silently.
  if (!isDbId(meId)) throw new Error("Sign in to save these changes");
  const update: Record<string, unknown> = {
    display_name: patch.display_name,
    bio: patch.bio,
    location: patch.location,
    website: patch.website,
    avatar_url: patch.avatar_url,
  };

  // Username is optional here so existing callers are unaffected; when present
  // it is validated and checked for uniqueness before writing (the DB unique
  // constraint is the final guard).
  if (patch.username !== undefined) {
    const username = normalizeUsername(patch.username);
    if (!USERNAME_REGEX.test(username)) {
      throw new Error(
        "Usernames can be 3–18 characters and use only letters, numbers and underscores.",
      );
    }
    const available = await isUsernameAvailable(username, meId);
    if (!available) throw new Error("That username is already taken. Please choose another one.");
    update.username = username;
  }

  const { data, error } = await db
    .from("profiles")
    .update(update)
    .eq("id", meId)
    .select("*")
    .maybeSingle();
  if (error) {
    if (/username/i.test(error.message) && /(duplicate|unique)/i.test(error.message)) {
      throw new Error("That username is already taken. Please choose another one.");
    }
    throw error;
  }
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
  // followerId rides along so a viewer watching the *target's* profile can tell
  // this was a real follower joining (and light up their network list), not just
  // some other follow somewhere on the app.
  emitRealtime("follow_updated", {
    targetUserId,
    followerId: userId,
    following,
    followers: count ?? 0,
  });
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

// A network list is browsed, not exported — the roster arrives in batches so
// one profile with tens of thousands of follows can't ship a megabyte of rows
// (and blow the request URL) on a single open. The headline counts shown next
// to the lists come from the authoritative profiles.followers/following columns.
export const NETWORK_PAGE_SIZE = 25;

/**
 * One batch of followers *or* following for any profile, resolved to fresh
 * Profile rows, newest relationship first. Both `follows` and `profiles` are
 * public-read, so this works for a signed-in user viewing their own network
 * and for a guest viewing someone else's. `more` means the edge page was full,
 * so the caller can ask for the next `from` offset.
 */
export async function getProfileNetworkPage(
  profileId: string,
  view: "followers" | "following",
  from: number,
  limit: number = NETWORK_PAGE_SIZE,
): Promise<{ profiles: Profile[]; more: boolean }> {
  const empty = { profiles: [] as Profile[], more: false };
  if (!profileId || profileId === "guest") return empty;

  // Followers are the edges whose target is this profile; the accounts this
  // profile follows are the edges whose follower is it.
  const column = view === "followers" ? "follower_id" : "target_id";
  let query = db.from("follows").select(column);
  query =
    view === "followers" ? query.eq("target_id", profileId) : query.eq("follower_id", profileId);
  const { data } = await query
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);
  const ids = ((data ?? []) as any[]).map((r) => String(r[column])).filter(Boolean);

  const profiles: Profile[] = [];
  if (ids.length) {
    const { data: rows } = await db.from("profiles").select("*").in("id", ids);
    const byId = new Map<string, Profile>();
    for (const row of (rows ?? []) as any[]) {
      const p = rowToProfile(row);
      if (p?.id) byId.set(p.id, p);
    }
    cacheProfiles([...byId.values()]);
    // Preserve the follow-graph order (newest relationship first) instead of
    // the arbitrary order `in(...)` hands back.
    profiles.push(...ids.map((id) => byId.get(id)).filter((p): p is Profile => Boolean(p)));
  }
  return { profiles, more: ids.length === limit };
}

/**
 * Responses that mean "we decided not to store these bytes". The server wrote
 * the reason and the client must show it, not paper over it with a data URL.
 * 5xx is deliberately absent: a storage outage keeps the resilient path below.
 */
const DELIBERATE_REJECTIONS = new Set([400, 401, 402, 413, 415, 429, 507]);

export async function uploadMedia(
  file: File,
  folder: "avatars" | "posts" | "stories" | "media" | "messages" | "recordings" = "media",
) {
  // Set when the endpoint answered with a refusal we are meant to surface.
  // Thrown *after* the try/catch below, so the resilience path cannot eat it.
  let rejection: string | null = null;
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (token) {
      // Media must keep its real MIME so the reader can render it inline; every
      // other file is sent as a generic document (application/octet-stream) so a
      // browser-inferred code/text MIME can never be rejected, and the reader
      // safely serves it back as a download.
      const isMedia = /^(image|video|audio)\//.test(file.type);
      const contentType = isMedia
        ? file.type || "application/octet-stream"
        : "application/octet-stream";
      const res = await fetch(`/api/uploads/?folder=${encodeURIComponent(folder)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": contentType,
        },
        body: file,
      });
      if (res.ok) {
        const json = await res.json();
        return { url: json.url as string, path: json.path as string };
      }
      const failure = await res.json().catch(() => null);
      if (failure?.error && DELIBERATE_REJECTIONS.has(res.status)) {
        // A deliberate refusal (empty or oversized file, wrong type, rate limit,
        // plan not covering recordings, Space replay budget spent) is the answer
        // the host asked for: these bytes are not going to storage. Turning it
        // into a data URL would hide the reason and bloat a DB row with base64.
        rejection = String(failure.error);
      } else {
        console.warn("Media upload notice:", failure?.error || res.statusText);
      }
    }
  } catch (err: unknown) {
    console.warn("Storage upload notice:", errorMessage(err));
  }

  if (rejection) throw new Error(rejection);

  // Fallback to client-side Data URL so uploads and attachments are 100% resilient
  // to transient storage/network issues (never reached by a deliberate refusal).
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${folder}/${me()}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
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
    is_recording: row.is_recording ?? false,
    replay_count: row.replay_count ?? 0,
    participants: row.participants ?? [],
    messages: row.messages ?? [],
    starts_at: row.starts_at ?? undefined,
    startsIn: spaceStartsLabel(row),
  };
}

/**
 * Human label for a scheduled (not live, not recorded) Space's start time,
 * derived from the persisted `starts_at` so a reload keeps it in the Upcoming
 * tab instead of falling back to the generic "no start info" state. Returns
 * undefined for live, recorded, and past-due rooms.
 */
function spaceStartsLabel(row: any): string | undefined {
  if (row.live || row.recorded || !row.starts_at) return undefined;
  const when = new Date(row.starts_at);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return undefined;
  const day = when.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} at ${time}`;
}

export async function getSpaces(
  options: { limit?: number; liveOnly?: boolean } = {},
): Promise<{ spaces: Space[] }> {
  // Bound the read. This table backs the Spaces page, the live-rooms rail and
  // (until now) boot, and an unbounded `select("*")` grew the payload with every
  // room ever created — a scaling cliff. Live-first ordering means a capped fetch
  // still returns the rooms people care about, and `liveOnly` pushes the rail's
  // `filter(s => s.live)` into the database so it never ships ended/scheduled rows.
  const limit = options.limit ?? 200;
  try {
    let query = db
      .from("spaces")
      .select("*")
      .order("live", { ascending: false })
      .order("created_at", { ascending: false });
    if (options.liveOnly) query = query.eq("live", true);
    const { data } = await query.limit(limit);
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
    const { error: hostError } = await db
      .from("space_participants")
      .insert({ space_id: id, user_id: me(), role: "host" });
    if (hostError) {
      // Without a host row the room opens with nobody able to broadcast, and the
      // stage rules would reject the host's own microphone. Undo the Space rather
      // than hand back a room that looks live but can't be spoken in.
      await db.from("spaces").delete().eq("id", id);
      throw hostError;
    }
  }
  const space = rowToSpace(data);
  emitRealtime("space:created", { space });
  return { space };
}

/** Read the room's current headcount so the badge updates without a refetch.
 * The stored `spaces.listeners` is maintained by the `t_space_participants_after`
 * trigger on every join/leave/heartbeat, so there is nothing to write here — an
 * earlier version updated the row from the client, which RLS rejected for anyone
 * who wasn't the host, making the count look ignored rather than missing. It
 * also *counted participant rows*, which is how a room ended up "full" of people
 * who had closed their tab: the column is the server's answer (fresh rows, host
 * excluded) and the only number we should be showing. */
async function syncSpaceListeners(spaceId: string) {
  const { data } = await db.from("spaces").select("listeners").eq("id", spaceId).maybeSingle();
  const listeners = Number(data?.listeners ?? 0);
  emitRealtime("space:listeners", { spaceId, listeners });
  return listeners;
}

export async function joinSpace(spaceId: string) {
  const { error } = await db
    .from("space_participants")
    .upsert(
      { space_id: spaceId, user_id: me(), role: "listener", last_seen: nowIso() },
      { onConflict: "space_id,user_id" },
    );
  if (error) {
    // The spaces_capacity_guard trigger rejects a join once the room is full
    // for the host's plan tier; surface it so the UI can bail out gracefully.
    if (/SPACE_AT_CAPACITY/i.test(error.message || "")) {
      throw new Error("This Space is full — it has reached the host's listener limit.");
    }
    throw error;
  }
  emitRealtime("space:joined", { spaceId, userId: me() });
  await syncSpaceListeners(spaceId);
  return { ok: true };
}

export async function leaveSpace(spaceId: string) {
  const { error } = await db
    .from("space_participants")
    .delete()
    .eq("space_id", spaceId)
    .eq("user_id", me());
  if (error) throw error;
  emitRealtime("space:left", { spaceId, userId: me() });
  await syncSpaceListeners(spaceId);
  return { ok: true };
}

/**
 * "Still here." Stamps this member's row, sweeps the rows whose people stopped
 * stamping, and hands back the room's fresh listener count — one round trip,
 * from the `space_heartbeat` RPC in `20261003000004_spaces_presence.sql`.
 *
 * It exists because `leaveSpace()` runs from a React cleanup, and closing a tab
 * runs no cleanup at all. Without a heartbeat the room's capacity, its headcount
 * and its signalling-channel access are all held by people who left.
 *
 * Failure is not an outage: a dropped beat only means this member looks stale a
 * minute earlier, so the caller keeps the room and tries again on the next tick.
 */
export async function spaceHeartbeat(spaceId: string): Promise<number | null> {
  const { data, error } = await db.rpc("space_heartbeat", {
    p_space_id: spaceId,
    p_stale_seconds: SPACE_STALE_SECONDS,
  });
  if (error) {
    console.warn("[spaces] heartbeat dropped:", error.message);
    return null;
  }
  const listeners = Number(data ?? 0);
  emitRealtime("space:listeners", { spaceId, listeners });
  return Number.isFinite(listeners) ? listeners : null;
}

/** Host-only: close the room for everyone. A room only becomes a replayable
 * "Recorded" item if a recording was actually saved (`recording_url` present,
 * written by finalizeSpaceRecording). Ending a never-recorded room must not
 * fabricate a dead "Listen Replay" entry. */
export async function endSpace(spaceId: string) {
  const { data, error } = await db
    .from("spaces")
    .update({ live: false, is_recording: false })
    .eq("id", spaceId)
    .eq("host_id", me())
    .select("recording_url")
    .maybeSingle();
  if (error) throw error;
  const { error: recordedError } = await db
    .from("spaces")
    .update({ recorded: Boolean(data?.recording_url), listeners: 0 })
    .eq("id", spaceId);
  if (recordedError) throw recordedError;
  const { error: clearError } = await db
    .from("space_participants")
    .delete()
    .eq("space_id", spaceId);
  if (clearError) throw clearError;
  emitRealtime("space:ended", { spaceId });
  return { ok: true };
}

export async function toggleHandRaised(spaceId: string, raised: boolean) {
  const { error } = await db
    .from("space_participants")
    .update({ hand_raised: raised })
    .eq("space_id", spaceId)
    .eq("user_id", me());
  // supabase-js resolves instead of throwing on a rejected write, so without
  // this check a host never sees the raised hand and the badge rolls back only
  // after the caller learns the row never changed.
  if (error) throw new Error(error.message || "Could not update your hand");
  emitRealtime("space:hand", { spaceId, userId: me(), raised });
  return { handRaised: raised };
}

export async function toggleSpeaking(spaceId: string, speaking: boolean, muted: boolean) {
  const { error } = await db
    .from("space_participants")
    .update({ is_speaking: speaking, is_muted: muted })
    .eq("space_id", spaceId)
    .eq("user_id", me());
  if (error) throw new Error(error.message || "Could not change your microphone state");
  emitRealtime("space:speaking", { spaceId, userId: me(), speaking, muted });
  return { speaking, muted };
}

export async function sendSpaceMessage(spaceId: string, body: string) {
  // `space_messages_body_length` refuses this in the database; saying it here is
  // what turns that into a sentence the room composer can show instead of a
  // constraint name — and it happens before the optimistic bubble is broadcast.
  const tooLong = lengthError(body, MAX_SPACE_CHAT_CHARS);
  if (tooLong) throw new Error(tooLong);
  const { data, error } = await db
    .from("space_messages")
    .insert({ space_id: spaceId, user_id: me(), body })
    .select("*")
    .single();
  // Only broadcast once the row exists. Emitting first showed the message to
  // everyone in the room — including the sender's own optimistic bubble — for a
  // write the database had actually refused (RLS denial, closed Space).
  if (error) throw new Error(error.message || "Message not sent");
  const message = {
    id: data.id,
    userId: data.user_id,
    name: currentUser.display_name,
    body: data.body,
    createdAt: data.created_at,
  };
  emitRealtime("space:message", { spaceId, message });
  return { message };
}

/**
 * A reaction tap in a live room is a sparkle, not a row: nothing is stored and
 * nothing is replayed, so it rides the same ephemeral broadcast bus as joins,
 * mutes and hand raises, and reaches everyone currently watching.
 *
 * The caller supplies the id. That is what lets the receiving side dedupe — a
 * retried event must not put two hearts on someone's screen — and what keeps a
 * person's own copy from being counted twice on their device.
 *
 * Returns false when the glyph or the id is unusable, so a silent no-op is
 * distinguishable from a sent one.
 */
export function sendSpaceReaction(
  spaceId: string,
  emoji: string,
  opts: { id: string; userId?: string },
): boolean {
  if (!spaceId || !opts?.id) return false;
  const glyph = sanitizeReactionEmoji(emoji);
  if (!glyph) return false;
  emitRealtime("space:reaction", {
    spaceId,
    id: opts.id,
    userId: opts.userId ?? me(),
    emoji: glyph,
  });
  return true;
}

/**
 * Tell a room that a tip has settled.
 *
 * Ordered on purpose. The chat row goes to the database first: it is the part
 * that lasts, it is checked by access rules, and it is what reaches everyone in
 * the room through the `space_messages` change feed even if their sockets were
 * busy. The banner is second and is decoration — a burst of bags and a figure
 * for whoever is watching at that moment.
 *
 * A failed insert does not throw. The money has already been taken and verified
 * by the server; a room line that could not be written (a closed Space, an RLS
 * denial, the person having been removed) must never be reported as a payment
 * problem, so the caller gets `false` and stays quiet.
 */
export async function announceSpaceTip(
  spaceId: string,
  tip: { amountUsd: number; message?: string; senderName?: string },
): Promise<boolean> {
  if (!spaceId) return false;
  const body = tipAnnouncement(tip.amountUsd, tip.message);
  if (!body) return false;

  // This runs on a cold page: the confirmation route is a fresh document after
  // the hosted checkout, so the in-memory profile may still be the guest
  // placeholder while the real session loads. The session is the authority on
  // who is writing — the access rules on `space_messages` check that the row
  // belongs to the caller — so ask the client instead of trusting memory, and
  // stay silent when nobody is signed in rather than posting a line as "guest".
  let senderId = "";
  try {
    const { data } = await supabase.auth.getSession();
    senderId = data.session?.user?.id ?? "";
  } catch {
    senderId = "";
  }
  if (!senderId) return false;

  const reference = `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const knownName = currentUser.id === senderId ? currentUser.display_name : "";
  let posted = true;
  try {
    const { error } = await db
      .from("space_messages")
      .insert({ space_id: spaceId, user_id: senderId, body });
    if (error) posted = false;
  } catch {
    posted = false;
  }

  emitRealtime("space:tip", {
    spaceId,
    tip: {
      id: reference,
      // The caller passes the amount the payment provider confirmed, so the
      // banner shows real money rather than a number off the disk.
      amount: tip.amountUsd,
      message: tip.message ?? "",
      // An id is quite enough: the room resolves the name from the people it
      // already knows and falls back to "A supporter" — never a placeholder
      // word, and never a raw UUID printed where a person's name belongs.
      sender_name: tip.senderName || knownName,
      sender_id: senderId,
    },
  });
  return posted;
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
  const { error } = await db
    .from("space_participants")
    .update({ role, hand_raised: false, is_muted: role === "listener" })
    .eq("space_id", spaceId)
    .eq("user_id", userId);
  if (error) throw error;
  emitRealtime("space:role", { spaceId, userId, role });
  return { ok: true };
}

/** Host-only: force-mute (or unmute) another participant's mic state. RLS lets the
 * host update any participant row in their room; non-hosts can only touch their own. */
export async function setSpaceParticipantMute(spaceId: string, userId: string, muted: boolean) {
  const { error } = await db
    .from("space_participants")
    .update({ is_muted: muted, is_speaking: muted ? false : undefined })
    .eq("space_id", spaceId)
    .eq("user_id", userId);
  if (error) throw error;
  emitRealtime("space:speaking", { spaceId, userId, speaking: !muted, muted });
  return { ok: true };
}

/** Host-only: remove a participant from the room entirely. Enforced server-side by
 * the "space participants self delete" RLS policy (self or host only). */
export async function removeSpaceParticipant(spaceId: string, userId: string) {
  const { error } = await db
    .from("space_participants")
    .delete()
    .eq("space_id", spaceId)
    .eq("user_id", userId);
  if (error) throw error;
  emitRealtime("space:removed", { spaceId, userId });
  await syncSpaceListeners(spaceId);
  return { ok: true };
}

/** Host-only: turn the room recording on/off. Recording defaults to OFF; only the
 * host can start or stop it, and every listener sees the same state via realtime. */
export async function setSpaceRecording(spaceId: string, recording: boolean) {
  const { data, error } = await db
    .from("spaces")
    .update(
      recording
        ? { is_recording: true, recording_started_at: nowIso(), recording_bytes: 0 }
        : { is_recording: false },
    )
    .eq("id", spaceId)
    .eq("host_id", me())
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Only the host can control recording.");
  emitRealtime("space:recording", { spaceId, recording });
  return { ok: true };
}

/** Host-only: report the current recording size so we can enforce the size limit server-side too. */
export async function reportSpaceRecordingBytes(spaceId: string, bytes: number) {
  const { error } = await db
    .from("spaces")
    .update({ recording_bytes: Math.max(0, Math.floor(bytes)) })
    .eq("id", spaceId)
    .eq("host_id", me());
  // `spaces.recording_bytes` is what the recording-cap check compares against the
  // host's plan budget. The caller treats a failure as non-fatal and warns — it
  // was already written for that, but this used to resolve successfully no matter
  // what happened, so a dropped report left the budget looking untouched.
  if (error) throw new Error(error.message || "Could not record the capture size");
  return { ok: true };
}

/** Host-only: finish a recording, attaching the uploaded replay URL. */
export async function finalizeSpaceRecording(spaceId: string, recordingUrl: string) {
  // Only a media-proxy URL is a real replay: it is what the ACL check in
  // /api/public/media/$ resolves `spaces.recording_url` against, and an inline
  // data: blob would ship base64 through every spaces query (the column has a
  // CHECK constraint enforcing this too).
  if (!recordingUrl || !recordingUrl.startsWith("/api/public/media/")) {
    throw new Error("The recording was not stored. Please try recording again.");
  }
  // A room can be recorded more than once. The previous take's bytes STAY in
  // storage (durability contract, 20261006000001); only `spaces.recording_url`
  // re-points. Nothing is reclaimed here, and authenticated users no longer
  // hold a storage.objects DELETE policy for any bucket, so a client cannot
  // erase the older object even if it wanted to.
  const { error } = await db
    .from("spaces")
    .update({ is_recording: false, recorded: true, recording_url: recordingUrl })
    .eq("id", spaceId)
    .eq("host_id", me());
  if (error) throw error;
  emitRealtime("space:recording", { spaceId, recording: false, recordingUrl });
  return { ok: true };
}

/** Host-only: drop the `recording_url` link. The bytes stay in the bucket by
 * durability contract (20261006000001): authenticated users hold no DELETE
 * policy on storage.objects, so a client cannot erase them, and any archive
 * or saved link that still resolves the old URL continues to work. The plan
 * budget is freed by resetting `recording_bytes` on the row. */
export async function deleteSpaceRecording(spaceId: string) {
  const { data: existing, error: readErr } = await db
    .from("spaces")
    .select("recording_url")
    .eq("id", spaceId)
    .eq("host_id", me())
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) throw new Error("Only the host can delete this recording.");
  const { error } = await db
    .from("spaces")
    .update({
      recording_url: null,
      recorded: false,
      is_recording: false,
      replay_count: 0,
      // ...and free the plan budget. The bytes are not erased, but the
      // accounting figure that gates the next recording is reset, so a
      // host who deletes their replay can immediately record another.
      recording_bytes: 0,
    })
    .eq("id", spaceId)
    .eq("host_id", me());
  if (error) throw error;
  emitRealtime("space:recording-deleted", { spaceId });
  return { ok: true };
}

/** Records a real, de-duplicated replay view for the signed-in listener (no fake counts). */
export async function recordSpaceReplayView(spaceId: string) {
  const userId = me();
  if (!isDbId(userId)) return { ok: false, replayCount: null as number | null };
  // supabase-js resolves with `error` rather than throwing, so the try/catch that
  // used to sit here could never have caught anything: a rejected insert was
  // reported as a recorded view and the host's replay count crept low forever.
  const { error } = await db
    .from("space_replay_views")
    .upsert(
      { space_id: spaceId, user_id: userId },
      { onConflict: "space_id,user_id", ignoreDuplicates: true },
    );
  if (error) console.warn("replay view not recorded:", error.message);
  // The AFTER INSERT trigger maintains spaces.replay_count; read the live value
  // back so the modal can show the true count instead of the stale list one.
  try {
    const { data } = await db.from("spaces").select("replay_count").eq("id", spaceId).maybeSingle();
    const count = Number(data?.replay_count);
    return { ok: true, replayCount: Number.isFinite(count) ? count : null };
  } catch {
    return { ok: true, replayCount: null as number | null };
  }
}

export async function terminateSpaceAdmin(spaceId: string, _actorId?: string) {
  await terminateSpace({ data: { spaceId } });
  emitRealtime("space:terminated", { id: spaceId });
  return { ok: true };
}

/* ------------------------------------------------------------------- chat */

/**
 * Both "Edit" and "Delete for everyone" share this window — 15 minutes from
 * `created_at`. It's a UX guard, not a security boundary: the DB still lets
 * participants update rows they can see (needed for the hidden_for tombstone),
 * and we re-check the window here so a caller can't skip the menu and hit
 * the client function directly.
 */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

function withinEditWindow(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= MESSAGE_EDIT_WINDOW_MS;
}

export async function getConversations(): Promise<Conversation[]> {
  const userId = me();
  if (!isDbId(userId)) return [];
  try {
    // The `hidden_for` filter drops threads the viewer chose "Delete chat" on.
    // Since 20261006000001 the exclusion lives in the RLS SELECT policy for
    // `conversations`, so the wire query no longer carries a `not.cs.<uuid>`
    // filter (which supabase-js encoded without the `{}` array wrapper and
    // PostgREST rejected with a 400). The client-side `.filter(...)` below is
    // the belt for a schema-cache-lag read that predates the migration.
    const { data: convData, error: convErr } = await db
      .from("conversations")
      .select("*")
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .order("updated_at", { ascending: false });
    if (convErr) throw convErr;
    const res = { data: convData };
    // Whether the filtered or the no-filter fallback read served the list, drop any
    // thread the viewer hid. A hidden chat must never light the badge; the
    // fallback path (schema-cache lag) otherwise returns hidden rows and their
    // unread messages — which are only individually tombstoned on "delete for me",
    // not on "hide chat" — would still be tallied below.
    const rows = ((res.data ?? []) as any[]).filter(
      (r) => !Array.isArray(r.hidden_for) || !r.hidden_for.includes(userId),
    );
    if (rows.length > 0) {
      // Hydrating the people behind each thread, tallying unread messages, and
      // reading last-call metadata are independent, so run them concurrently —
      // this round-trip gates how fast the conversation list paints on open.
      // `messages.hidden_for` is excluded by the SELECT policy added in
      // 20261006000001, so the unread tally is RLS-scoped, not query-scoped.
      const [, unreadRes, callsRes] = await Promise.all([
        hydrateAuthors(rows.flatMap((r) => [r.user_a, r.user_b])),
        db
          .from("messages")
          .select("conversation_id")
          .is("read_at", null)
          .neq("sender_id", userId)
          .in(
            "conversation_id",
            rows.map((r) => r.id),
          ),
        // Last finished call per relationship — the inbox rail shows a phone
        // glyph when a call beat the last message. Calls live in `calls`, never
        // in `messages`, so the conversation row cannot stamp them itself. RLS
        // (`calls participant read`) already confines rows to my pairs, and a
        // call hidden/deleted for me is invisible here, matching the thread.
        db
          .from("calls")
          .select(
            "id,caller_id,callee_id,kind,status,started_at,answered_at,ended_at,duration_seconds",
          )
          .or(`caller_id.eq.${userId},callee_id.eq.${userId}`)
          .order("started_at", { ascending: false })
          .limit(200),
      ]);
      const unreadByConversation = new Map<string, number>();
      for (const row of (unreadRes?.data ?? []) as any[]) {
        const key = String(row.conversation_id);
        unreadByConversation.set(key, (unreadByConversation.get(key) ?? 0) + 1);
      }
      // The newest call per peer drives the rail glyph. `calls` came back
      // ordered newest-first, so the first row that yields a real history card
      // (callCardFromRow drops live rings) for a peer is that peer's latest.
      const lastCallByPeer = new Map<string, { at: string; kind: "voice" | "video" }>();
      const callRows = (callsRes?.data ?? []) as CallRowLike[];
      const seenCallIds = new Set<string>();
      for (const row of callRows) {
        if (!row?.id || seenCallIds.has(row.id)) continue;
        const card = callCardFromRow(row, userId);
        if (!card) continue;
        seenCallIds.add(row.id);
        const peer = String(row.caller_id === userId ? row.callee_id : row.caller_id);
        if (!peer || lastCallByPeer.has(peer)) continue;
        lastCallByPeer.set(peer, {
          at: card.at,
          kind: card.kind === "video" ? "video" : "voice",
        });
      }
      return rows.map((row: any) => {
        const participantId = row.user_a === userId ? row.user_b : row.user_a;
        const lastCall = lastCallByPeer.get(String(participantId));
        return {
          id: row.id,
          participant_id: participantId,
          preview: row.preview ?? "",
          unread: unreadByConversation.get(String(row.id)) ?? 0,
          online: false,
          updated_at: row.updated_at ?? nowIso(),
          ...(lastCall ? { last_call_at: lastCall.at, last_call_kind: lastCall.kind } : {}),
        };
      });
    }
  } catch (err) {
    console.warn("getConversations notice:", err);
  }
  return [];
}

/**
 * One page of a thread's history, oldest-last, plus whether more exist above it.
 *
 * Threads used to be read whole (every row, ascending) on open, which grows
 * without bound for long conversations and gates first paint on the full
 * download. We now ask for `limit + 1` newest rows: the extra one is only a
 * sentinel that says "there is more above", so we drop it, reverse to ascending
 * for rendering, and hand the caller `hasMore` to drive load-older. The same
 * `hidden_for` resilience as getConversations keeps a schema-cache lag from
 * silently emptying an existing thread (build fresh per attempt: the supabase
 * builder is mutable, so reusing one would keep the failed filter).
 */
export async function getMessagesPage(
  conversationId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const limit = Math.max(1, opts.limit ?? 60);
  if (!isDbId(conversationId)) return { messages: [], hasMore: false };
  const myId = me();
  try {
    // RLS (`messages participant read`, see 20261006000001) now excludes both
    // a per-message tombstone AND any thread the viewer hid, so no `not.cs`
    // filter needs to leave the browser — that filter is what used to 400
    // on every thread open.
    let q = db
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit + 1);
    if (opts.before) q = q.lt("created_at", opts.before);
    const res = await q;
    const rows = (res.data ?? []) as any[];
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
    // Hydrate `is_edited` from the persisted `edited_at` column so the "(edited)"
    // marker survives a reload.
    const messages = page.map((row) => ({
      ...row,
      is_edited: !!row.edited_at,
    })) as Message[];
    return { messages, hasMore };
  } catch (err) {
    console.warn("getMessagesPage notice:", err);
    return { messages: [], hasMore: false };
  }
}

/**
 * Record that the viewer has this thread's inbound messages. Idempotent: the
 * `delivered_at` / `read_at` columns are only written where still null, so it is
 * safe to call on open AND every time a new message lands while the thread is
 * focused, advancing the sender's ticks live rather than on the next page load.
 */
export async function markThreadRead(conversationId: string): Promise<void> {
  const myId = me();
  if (!isDbId(myId) || !isDbId(conversationId)) return;
  try {
    // Opening the thread means the recipient's device has the messages — mark
    // them delivered even before they are explicitly read.
    const { data: deliveredNow } = await db
      .from("messages")
      .update({ delivered_at: nowIso() })
      .eq("conversation_id", conversationId)
      .neq("sender_id", myId)
      .is("delivered_at", null)
      .select("id");
    if ((deliveredNow ?? []).length > 0) {
      emitRealtime("message:delivered", { conversationId, at: nowIso() });
    }
    const { data: marked } = await db
      .from("messages")
      .update({ read_at: nowIso() })
      .eq("conversation_id", conversationId)
      .neq("sender_id", myId)
      .is("read_at", null)
      .select("id");
    if ((marked ?? []).length > 0) {
      emitRealtime("message:read", { conversationId, readerId: myId, at: nowIso() });
    }
  } catch (err) {
    console.warn("markThreadRead notice:", err);
  }
}

/**
 * Legacy whole-thread read kept for existing callers/tests: the initial paint
 * now uses `getMessagesPage` + `markThreadRead`, but this preserves the old
 * "load everything, then mark seen" behaviour in one call.
 */
export async function getMessages(conversationId: string): Promise<Message[]> {
  const { messages } = await getMessagesPage(conversationId, { limit: 1000 });
  if (messages.length > 0) await markThreadRead(conversationId);
  return messages;
}

/**
 * The call log for one 1:1 relationship, as cards for the thread.
 *
 * Read from `calls` rather than written into `messages`: the row already holds
 * who dialled, what kind, how it ended and for how long, `calls participant
 * read` already limits it to the two people involved, and a second copy of that
 * history in the message table would be a second thing to keep honest (a
 * declined call re-mentioned in `body` text could not be trusted, and a forged
 * `sender_id` on a call card would be a free way to write into somebody else's
 * thread). Only finished calls come back — a ring that is still going belongs to
 * the ringing UI, not to the history.
 */
export async function getCallHistory(participantId: string): Promise<CallCard[]> {
  const meId = me();
  if (!isDbId(meId) || !isDbId(participantId)) return [];
  try {
    const { data, error } = await db
      .from("calls")
      .select("id,caller_id,callee_id,kind,status,started_at,answered_at,ended_at,duration_seconds")
      .or(
        `and(caller_id.eq.${meId},callee_id.eq.${participantId}),and(caller_id.eq.${participantId},callee_id.eq.${meId})`,
      )
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) {
      console.warn("getCallHistory notice:", error.message);
      return [];
    }
    return callCardsFromRows((data ?? []) as CallRowLike[], meId);
  } catch (err) {
    console.warn("getCallHistory notice:", err);
    return [];
  }
}

/**
 * Hide one finished call from *this* viewer's thread only. Goes through the
 * `hide_call_for_me` RPC so the client can never rewrite a peer's history: the
 * function only ever appends `auth.uid()`, and only to a call they belong to.
 */
export async function hideCallForMe(callId: string): Promise<void> {
  const meId = me();
  if (!isDbId(meId) || !isDbId(callId)) return;
  const { error } = await db.rpc("hide_call_for_me", { p_call_id: callId });
  if (error) {
    console.warn("hideCallForMe notice:", error.message);
    throw new Error(error.message);
  }
}

/**
 * Delete a call for everyone — the shared `calls` row is removed, so the card
 * leaves both threads. The `calls participant delete` policy keeps this to the
 * two people on the call; a peer's device sees the row drop through the realtime
 * `calls` change feed and refreshes its own history.
 */
export async function deleteCallForEveryone(callId: string): Promise<void> {
  const meId = me();
  if (!isDbId(meId) || !isDbId(callId)) return;
  const { error } = await db.from("calls").delete().eq("id", callId);
  if (error) {
    console.warn("deleteCallForEveryone notice:", error.message);
    throw new Error(error.message);
  }
}

export async function getOrCreateConversation(participantId: string): Promise<string> {
  const userId = me();
  if (!isDbId(userId) || !isDbId(participantId)) {
    throw new Error("Messaging isn't available for sample accounts.");
  }
  const findExisting = async () => {
    const { data } = await db
      .from("conversations")
      .select("id")
      .or(
        `and(user_a.eq.${userId},user_b.eq.${participantId}),and(user_a.eq.${participantId},user_b.eq.${userId})`,
      )
      .limit(1);
    return data?.[0]?.id ? String(data[0].id) : null;
  };
  const existing = await findExisting();
  if (existing) return existing;
  const { data, error } = await db
    .from("conversations")
    .insert({ user_a: userId, user_b: participantId, preview: "" })
    .select("id")
    .maybeSingle();
  if (error) {
    // Both people hitting "message" at the same instant races unique(user_a,user_b).
    // The other transaction's row is just as good — find and reuse it instead of
    // failing the message send.
    if (error.code === "23505") {
      const raced = await findExisting();
      if (raced) return raced;
    }
    throw error;
  }
  if (!data?.id) {
    const fallback = await findExisting();
    if (fallback) return fallback;
    throw new Error("We couldn't open that conversation. Please try again.");
  }
  return String(data.id);
}

export async function sendMessage(
  target: string,
  body: string,
  mediaUrl?: string | null,
  clientId?: string | null,
) {
  const senderId = me();
  if (!isDbId(senderId)) throw new Error("Sign in to send messages");
  // The database refuses an over-long body (messages_body_length), which would
  // otherwise reach the user as a constraint name. Say what happened instead.
  const tooLong = messageLengthError(body);
  if (tooLong) throw new Error(tooLong);

  const { data: existingConversation } = isDbId(target)
    ? await db.from("conversations").select("id").eq("id", target).maybeSingle()
    : { data: null as any };

  const conversationId = existingConversation?.id
    ? String(existingConversation.id)
    : await getOrCreateConversation(target);

  // Repeated identical messages must all send — there is no dedupe by
  // content. A client-generated id lets the sender reconcile its optimistic
  // bubble with the persisted row without guessing from message text.
  // messages.id is a UUID column, so only honour a well-formed client id; a
  // non-UUID sentinel would otherwise fail the insert with
  // `invalid input syntax for type uuid`, so we let the DB assign the id.
  const isUuid =
    typeof clientId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);
  const insertRow: Record<string, unknown> = {
    conversation_id: conversationId,
    sender_id: senderId,
    body,
    media_url: mediaUrl ?? null,
  };
  if (isUuid) insertRow.id = clientId;

  const { data, error } = await db.from("messages").insert(insertRow).select("*").single();
  if (error) {
    // Retrying a message that actually landed (network dropped the response)
    // hits the client id's primary key — treat it as sent, not failed.
    if (isUuid && error.code === "23505") {
      const { data: row } = await db.from("messages").select("*").eq("id", clientId).maybeSingle();
      if (row) {
        emitRealtime("message:created", row);
        return { message: row as Message, conversationId };
      }
    }
    throw new Error(error.message || "Your message couldn't be sent");
  }

  // No preview/updated_at write here: the SECURITY DEFINER trigger
  // `t_messages_after` already sets both (and notifies the recipient) as part of
  // the same transaction that stored the message. The client copy wrote a shorter
  // preview on the browser's clock and cost an extra round-trip per message.
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
  // `message_reactions.emoji` is unbounded text and the value is rendered
  // straight back into the thread, so the boundary is enforced here rather than
  // trusted from whichever button happened to call this.
  const glyph = sanitizeReactionEmoji(emoji);
  if (!glyph) throw new Error("That reaction isn't valid");
  if (on) {
    const { error } = await db
      .from("message_reactions")
      .insert({ message_id: messageId, user_id: userId, emoji: glyph });
    if (error && error.code !== "23505") throw error;
  } else {
    const { error } = await db
      .from("message_reactions")
      .delete()
      .eq("message_id", messageId)
      .eq("user_id", userId)
      .eq("emoji", glyph);
    if (error) throw error;
  }
  emitRealtime("message:reaction", { messageId, emoji: glyph, on, userId });
  return { messageId, emoji: glyph, on };
}

export async function editMessage(messageId: string, body: string) {
  // Window enforcement lives here rather than in RLS: the same policy that
  // lets a recipient append their id to hidden_for can't also reject a
  // late edit, so we do the check in the code path that owns the column.
  const myId = me();
  if (!isDbId(myId)) throw new Error("Sign in to edit messages");
  const { data: existing } = await db
    .from("messages")
    .select("sender_id, created_at")
    .eq("id", messageId)
    .maybeSingle();
  if (!existing || existing.sender_id !== myId) throw new Error("Not your message");
  if (!withinEditWindow(existing.created_at)) throw new Error("Edit window closed");
  const editedAt = nowIso();
  const { data, error } = await db
    .from("messages")
    .update({ body, edited_at: editedAt })
    .eq("id", messageId)
    .eq("sender_id", myId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  emitRealtime("message:edited", { id: messageId, body, edited_at: editedAt });
  return (data ? { ...data, is_edited: true } : null) as Message | null;
}

/**
 * Delete a message. `scope` decides who loses it:
 *   - "me":       soft-hide just for the caller (RPC appends auth.uid() to
 *                 messages.hidden_for; the other side keeps the message).
 *   - "everyone": hard-delete for both sides, only within the edit window
 *                 and only if the caller is the sender (existing sender
 *                 policy is unchanged).
 * Media attached to a "for everyone" message is unlinked from storage so the
 * file itself does not linger after the row goes away.
 */
export async function deleteMessage(messageId: string, scope: "me" | "everyone" = "everyone") {
  const myId = me();
  if (!isDbId(myId)) throw new Error("Sign in to delete messages");
  if (scope === "me") {
    const { error } = await db.rpc("hide_message_for_me", { p_message_id: messageId });
    if (error) throw error;
    emitRealtime("message:hidden", { id: messageId, userId: myId });
    return { id: messageId, scope: "me" as const };
  }
  const { data: existing } = await db
    .from("messages")
    .select("media_url, created_at, sender_id")
    .eq("id", messageId)
    .eq("sender_id", myId)
    .maybeSingle();
  if (!existing) throw new Error("Not your message");
  if (!withinEditWindow(existing.created_at)) throw new Error("Delete window closed");
  const { error } = await db.from("messages").delete().eq("id", messageId).eq("sender_id", myId);
  if (error) throw error;
  // Durability contract (20261006000001): the attachment's bytes are NOT
  // erased. A recipient who saved or embedded the URL keeps working access,
  // and no authenticated user holds a storage.objects DELETE policy at all.
  emitRealtime("message:deleted", { id: messageId });
  return { id: messageId, scope: "everyone" as const };
}

/**
 * Hide a whole conversation from the caller's inbox. Non-destructive: the
 * thread stays for the other participant, and the DB trigger reopens it for
 * both parties the moment a fresh message lands.
 */
export async function hideConversationForMe(conversationId: string) {
  const myId = me();
  if (!isDbId(myId) || !isDbId(conversationId)) throw new Error("Not available");
  const { error } = await db.rpc("hide_conversation_for_me", {
    p_conversation_id: conversationId,
  });
  if (error) throw error;
  emitRealtime("conversation:hidden", { id: conversationId, userId: myId });
  return { id: conversationId };
}

export async function getNotifications(
  options: { limit?: number; offset?: number } = {},
): Promise<Notification[]> {
  if (!isDbId(me())) return [];
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = Math.max(0, options.offset ?? 0);
  const { data, error } = await db
    .from("notifications")
    .select("*")
    .eq("recipient_id", me())
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    console.warn("getNotifications notice:", error.message);
    return [];
  }
  const rows = (data ?? []) as Notification[];
  // Load the people behind each notification so names and avatars render.
  // Platform notices (payout/system) have no actor and are skipped.
  await hydrateAuthors(rows.map((n) => n.actor_id).filter((x): x is string => !!x));
  return rows;
}

export async function markNotificationsRead() {
  if (isDbId(me())) {
    const { error } = await db
      .from("notifications")
      .update({ read: true })
      .eq("recipient_id", me());
    // Deliberately not fatal: the bell already cleared optimistically and the
    // flags resync on the next load. Say so loudly in the console instead.
    if (error) console.warn("markNotificationsRead:", error.message);
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
  if (isDbId(me())) {
    const { error } = await db.from("feed_preferences").upsert({ user_id: me(), prefs: next });
    // The tuning panel reports the new preference set to the caller, so a
    // rejected write (expired session falls back to the anon role, which holds no
    // INSERT grant here) has to surface — otherwise "Not interested in #x" looks
    // saved, is re-read from the server on the next load, and silently comes back.
    if (error) throw new Error(error.message || "Could not save your feed preferences");
  }
  return { preferences: next };
}

/* -------------------------------------------------------------- discovery */

export async function getTrendingTags(options?: {
  limit?: number;
  offset?: number;
}): Promise<{ trendingTags: TrendingTag[] }> {
  // Sample a bounded window of recent posts (600 rows), aggregate tags, cap the
  // distinct result to 80 (enough for explore Topics load-more + rails), then
  // paginate the result for the caller's { limit, offset }. Reducing the scan
  // from 2000 to 600 cuts backend load per call significantly (multiple callers
  // on boot + explore). Tags past rank 80 or the 600th post are dropped, trading
  // absolute completeness for performance; callers slice their own subset.
  const { data } = await db
    .from("posts")
    .select("tags")
    .order("created_at", { ascending: false })
    .limit(600);
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as any[]) {
    for (const tag of row.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80);
  const offset = options?.offset ?? 0;
  const limit = options?.limit ? Math.min(options.limit, 80) : 80;
  const trendingTags = sorted
    .slice(offset, offset + limit)
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

/* --------------------------------------------------------------------- tips */

// Tipping is a payment: the only writer of a `tips` row is the settled-payment
// path (Paystack verify -> SECURITY DEFINER settle function) or the service-role
// client. There is deliberately no client-side "insert a tip" helper here — one
// would let anyone mint balance without paying, and the database now refuses it
// (see migration 20260930000094).

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

/**
 * Full single report row for the staff queue. Realtime only broadcasts a
 * minimal "a report exists" signal (identity/preview must never go public),
 * so moderation views re-hydrate the row through this RLS-gated read.
 */
export async function getAdminReportById(id: string): Promise<ModerationReport | null> {
  if (!isDbId(id)) return null;
  const { data } = await db.from("reports").select("*").eq("id", id).maybeSingle();
  return (data ?? null) as ModerationReport | null;
}

/** Live comment row by id for the moderation click-to-view preview. */
export async function getCommentById(id: string): Promise<Record<string, any> | null> {
  if (!isDbId(id)) return null;
  const { data } = await db.from("comments").select("*").eq("id", id).maybeSingle();
  return (data ?? null) as Record<string, any> | null;
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
      status: status as "pending" | "investigating" | "resolved" | "dismissed",
      ...(actionTaken ? { actionTaken } : {}),
    },
  });
  emitRealtime("report:updated", data);
  return data as ModerationReport;
}

export async function getAdminUsers(
  filters: { query?: string; role?: string; status?: string; verified?: boolean } = {},
  page: { limit?: number; offset?: number } = {},
) {
  // One chunk of the directory instead of 200 rows per keystroke; order makes
  // the offset pages stable. `hasMore` rides on the array so callers can show
  // a "Load more" button without a breaking return-shape change.
  const limit = Math.min(page.limit ?? 50, 200);
  const offset = Math.max(0, page.offset ?? 0);
  let q = db
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
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
  const list = profiles as Profile[] & { hasMore?: boolean };
  list.hasMore = rawRows.length === limit;
  return list;
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

export async function getAdminPosts(
  filters: { query?: string } = {},
  page: { limit?: number; offset?: number } = {},
) {
  // Narrow server-side: the console used to pull 200 rows and filter them in
  // JS on every keystroke. Now it also pages — 50 per chunk with a cursor the
  // table can walk via "Load more".
  const limit = Math.min(page.limit ?? 50, 200);
  const offset = Math.max(0, page.offset ?? 0);
  let builder = db
    .from("posts")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (filters.query) builder = builder.ilike("content", `%${filters.query}%`);
  const { data } = await builder;
  const posts = (data ?? []).map((row: any) => rowToPost(row));
  await hydrateAuthors(posts.map((p: Post) => p.user_id));
  const list = posts as Post[] & { hasMore?: boolean };
  list.hasMore = posts.length === limit;
  return list;
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

/**
 * A staff decision on the sensitive-media flag. It overrides the community
 * threshold (three reports flip it the same way) and pins the source, so a
 * moderator clearing a flag is not quietly re-flagged by the next report — see
 * `20261003000003_sensitive_content.sql`.
 */
export async function markPostSensitiveAdmin(postId: string, sensitive = true) {
  await moderatePost({
    data: { postId, action: sensitive ? "mark_sensitive" : "unmark_sensitive" },
  });
  emitRealtime("post:updated", { id: postId, is_sensitive: sensitive });
  return { ok: true, sensitive };
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

/** Neutral position of every toggle; also the shape shown before a read lands. */
export const DEFAULT_SETTINGS: SystemSettings = {
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
  const storedBanner =
    rest.announcement_banner && typeof rest.announcement_banner === "object"
      ? (rest.announcement_banner as Partial<SystemSettings["announcement_banner"]>)
      : {};
  return {
    ...DEFAULT_SETTINGS,
    ...(rest as Partial<SystemSettings>),
    // Deep-merge the banner: older rows store only { message, link }, and a
    // shallow spread would hand the admin tab a banner missing active/type/
    // dismissible — the save-time zod check then rejected every publish.
    announcement_banner: { ...DEFAULT_SETTINGS.announcement_banner, ...storedBanner },
  };
}

/**
 * The toggle panel, readable by anyone: guests need it too (maintenance banner,
 * closed-signups notice), and `system_settings` is select-only-public by policy.
 */
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
  // One parallel batch instead of six sequential head-counts.
  const results = await Promise.all(
    tables.map((table) => db.from(table).select("id", { count: "exact", head: true })),
  );
  const counts: Record<string, number> = {};
  tables.forEach((table, i) => (counts[table] = results[i].count ?? 0));
  return { counts, durationMs: Date.now() - started };
}

let overviewCache: { at: number; data: AdminOverviewData } | null = null;
const OVERVIEW_TTL_MS = 45_000;

/** Soft-failing head-count: the overview must render even if one table can't
 *  be counted right now (timeout, RLS hiccup); a failed count reads as 0. */
async function safeCount(query: PromiseLike<{ count: number | null }>): Promise<number> {
  try {
    return (await query).count ?? 0;
  } catch {
    return 0;
  }
}

export async function getAdminOverview(
  options: { force?: boolean } = {},
): Promise<AdminOverviewData> {
  // Switching admin tabs used to re-run ~20 aggregations every time the
  // overview remounted. A short TTL keeps revisits instant; the header
  // refresh button passes `force` for up-to-the-second numbers.
  if (!options.force && overviewCache && Date.now() - overviewCache.at < OVERVIEW_TTL_MS) {
    return overviewCache.data;
  }
  const started = Date.now();
  const since = new Date(Date.now() - 86_400_000).toISOString();

  // Every section is independent — fan out and join. Sequential awaits here
  // cost a full network round trip per stat on the slowest page in the app.
  const [
    { counts },
    reports,
    liveSpaces,
    impressions,
    likes,
    comments,
    reposts,
    suspended,
    verified,
    recentPosts,
    logs,
    tipData,
  ] = await Promise.all([
    syncSupabaseDatabase(),
    getAdminReports({ status: "pending" }),
    safeCount(db.from("spaces").select("id", { count: "exact", head: true }).eq("live", true)),
    safeCount(db.from("post_impressions").select("post_id", { count: "exact", head: true })),
    safeCount(db.from("likes").select("post_id", { count: "exact", head: true })),
    safeCount(db.from("comments").select("id", { count: "exact", head: true })),
    safeCount(db.from("reposts").select("post_id", { count: "exact", head: true })),
    safeCount(
      db.from("profiles").select("id", { count: "exact", head: true }).eq("status", "suspended"),
    ),
    safeCount(
      db.from("profiles").select("id", { count: "exact", head: true }).eq("verified", true),
    ),
    (async () => {
      try {
        const r = await db.from("posts").select("user_id").gte("created_at", since).limit(2000);
        return (r.data ?? []) as any[];
      } catch {
        return [] as any[];
      }
    })(),
    getAdminAuditLogs({ limit: 8 }).catch(() => []),
    Promise.all([db.rpc("admin_tip_stats"), db.rpc("admin_recent_tips", { _limit: 6 })])
      .then(([{ data: statsRow }, { data: tipsRows }]) => ({
        stats: (statsRow ?? [])[0] as any,
        rows: (tipsRows ?? []) as any[],
      }))
      .catch((err) => {
        console.warn("Tip stats unavailable:", err);
        return null;
      }),
  ]);

  // Real 24h-active count: distinct authors who posted in the last day.
  const active24h = new Set(recentPosts.map((r: any) => r.user_id)).size;

  // Recent moderation / system activity straight from the audit trail so the
  // overview reflects what is actually happening across the site (was a gap).
  const recent_activity = logs.map((l) => ({
    id: l.id,
    actor_name: l.actor_name || "System",
    action: l.action,
    target_type: l.target_type,
    details: l.details,
    severity: l.severity,
    created_at: l.created_at,
  }));

  // Tipping activity (staff-guarded inside the DB functions; non-staff
  // callers and failures simply leave the section empty).
  const tipStats = tipData?.stats
    ? {
        count: Number(tipData.stats.count ?? 0),
        amount: Number(tipData.stats.amount ?? 0),
        currency: String(tipData.stats.currency ?? "NGN"),
      }
    : { count: 0, amount: 0, currency: "NGN" };
  const recentTips: AdminOverviewData["recent_tips"] = (tipData?.rows ?? []).map((t) => ({
    id: String(t.id),
    tipper: String(t.tipper ?? "Member"),
    recipient: String(t.recipient ?? "Member"),
    amount: Number(t.amount ?? 0),
    currency: String(t.currency ?? "NGN"),
    message: String(t.message ?? ""),
    created_at: String(t.created_at),
  }));

  const data: AdminOverviewData = {
    stats: {
      total_users: counts.profiles ?? 0,
      active_24h_users: active24h,
      total_posts: counts.posts ?? 0,
      total_stories: counts.stories ?? 0,
      total_spaces: counts.spaces ?? 0,
      live_spaces_count: liveSpaces,
      total_impressions: impressions,
      total_likes: likes,
      total_comments: comments,
      total_reposts: reposts,
      pending_reports_count: reports.length,
      suspended_users_count: suspended,
      verified_creators_count: verified,
      total_tips_count: tipStats.count,
      total_tips_amount: tipStats.amount,
      tips_currency: tipStats.currency,
      system_health: {
        status: "operational",
        uptime_seconds: Math.floor(process_uptime()),
        database_latency_ms: Date.now() - started,
        error_rate_percent: 0,
        db_driver: "postgres",
        memory_mb: nodeMemoryMb(),
      },
    },
    charts: await buildAdminCharts({ likes, comments, reposts, impressions }),
    recent_activity,
    recent_reports: reports.slice(0, 5),
    recent_tips: recentTips,
  };
  overviewCache = { at: Date.now(), data };
  return data;
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

/** Live heap size from an environment that may or may not be Node, or 0.
 *  Exported separately from `nodeMemoryMb` so the two shapes can be tested
 *  directly instead of by deleting the worker's `process` global — which made
 *  every other test on the same worker race against it. */
export function heapMbFrom(
  env: { memoryUsage?: () => { heapUsed: number } } | undefined | null,
): number {
  const heap = env?.memoryUsage?.()?.heapUsed;
  if (typeof heap !== "number" || !Number.isFinite(heap) || heap < 0) return 0;
  return Math.round(heap / 1024 / 1024);
}

/** Live heap size, or 0 when the caller isn't Node. `process` is an undeclared
 *  identifier in the browser, so `process.memoryUsage?.()` still throws
 *  ReferenceError — only `typeof` may test it. This throw sits inside the
 *  overview payload, so it rejected an otherwise successful page of stats. */
function nodeMemoryMb(): number {
  return heapMbFrom(typeof process === "undefined" ? undefined : process);
}

// ---------------------------------------------------------------------------
// Feed preload bundle (used by the client-side feed cache)
// ---------------------------------------------------------------------------

export interface PreloadBundleResponse {
  foryou: Post[];
  following: Post[];
  latest: Post[];
  stories: Story[];
  trendingTags: TrendingTag[];
}

export async function preloadFeedBundle(): Promise<PreloadBundleResponse> {
  const [foryou, stories, trendingTags] = await Promise.all([
    getPosts({ limit: 15 }).catch(() => [] as Post[]),
    getStories().catch(() => [] as Story[]),
    getTrendingTags({ limit: 80 })
      .then((r) => r.trendingTags)
      .catch(() => [] as TrendingTag[]),
  ]);
  // Following and Spaces are deliberately not eagerly fetched: the feed loads
  // Following on tab-switch, and the live-rooms rail issues its own bounded
  // getSpaces({ liveOnly: true }). The boot bundle never rendered spaces, so
  // pulling the whole table on every load was pure dead work.
  return { foryou, following: [], latest: foryou, stories, trendingTags };
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
  // `id` is a uuid column: asking for `id.eq.janedoe` makes PostgREST reject the
  // whole or-filter with "invalid input syntax for type uuid", `data` comes back
  // null, and the page silently keeps the username placeholder — which is why a
  // copied /u/<username> link never opened the full profile. Only UUIDs may
  // match the id column; anything else is looked up by username (same rule as
  // fetchProfile in profile-service).
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(handle);
  const filter = isUuid ? `id.eq.${handle},username.eq.${handle}` : `username.eq.${handle}`;
  const { data } = await db.from("profiles").select("*").or(filter).maybeSingle();
  if (!data) return { profile: null };
  const profile = rowToProfile(data as any);
  cacheProfiles([profile]);
  return { profile };
}

/** Bookmarked posts for the signed-in user. */
export async function getBookmarks(): Promise<Post[]> {
  return getBookmarkedPosts();
}

/** Trending tags reshaped as browsable topics, paginated for explore. */
export async function getTopics(options?: {
  limit?: number;
  offset?: number;
}): Promise<{ topics: Topic[]; total: number }> {
  const { trendingTags } = await getTrendingTags();
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? trendingTags.length;
  const page = trendingTags.slice(offset, offset + limit);
  const topics: Topic[] = page.map((t, i) => ({
    name: `#${t.tag}`,
    posts: String(parseInt(String(t.count), 10) || 0),
    gradient: TOPIC_GRADIENTS[(offset + i) % TOPIC_GRADIENTS.length] ?? "from-brand to-brand-pink",
  }));
  return { topics, total: trendingTags.length };
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
  const { error } = await db.from("notifications").update({ read: true }).eq("id", id);
  // Deleting a notification one row below already refuses to lie about the
  // outcome; marking read has to as well, or the bell drops a count the server
  // never incremented and the alert reappears on the next load looking unread.
  if (error) throw new Error(error.message || "Could not mark that notification read");
  return { success: true };
}

export async function markAllNotificationsRead() {
  await markNotificationsRead();
  return { success: true };
}

export async function deleteNotification(id: string) {
  const { error } = await db.from("notifications").delete().eq("id", id);
  if (error) throw new Error(error.message || "Could not delete that notification");
  return { id };
}

/**
 * Record impressions for a batch of posts (viewport analytics).
 * Batched deliberately: one page of the feed is 15–30 posts, and the old
 * per-post fan-out cost two round-trips each. Now a scroll costs at most
 * three queries regardless of page size — the difference between a healthy
 * API and a self-inflicted DDoS once concurrent viewers scale.
 * Single-impression calls from a post card go through here too, so there is
 * only one set of guards to keep right.
 */
export async function recordPostImpressions(
  postIds: string[],
): Promise<{ ok: true; views: Record<string, number> }> {
  const ids = Array.from(new Set(dbIds(postIds)));
  if (ids.length === 0) return { ok: true, views: {} };
  const userId = me();
  const viewer = isDbId(userId) ? userId : null;
  // Impressions are recorded server-side with the service-role client, which
  // bypasses the `owns_profile` RLS check that used to 403 on every scroll.
  // Skipped unless there is a signed-in profile with a live session, so guests
  // never reach it (no anonymous inflation); the unique (post_id,user_id) index
  // dedupes repeat views and the posts after-insert trigger keeps view_count
  // accurate.
  if (viewer && (await hasAuthSession())) {
    try {
      const { recordImpressions } = await import("@/lib/impressions.functions");
      await recordImpressions({ data: { postIds: ids } });
    } catch {
      /* impressions are best-effort */
    }
  }
  // Tallied counts come off the posts rows (impression rows are staff-only).
  const { data: postRows } = await db.from("posts").select("id,view_count").in("id", ids);
  const views: Record<string, number> = {};
  for (const row of postRows ?? []) {
    views[String(row.id)] = row.view_count ?? 0;
    emitRealtime("post_view_updated", { postId: row.id, viewCount: row.view_count });
  }
  return { ok: true, views };
}

// ---------------------------------------------------------------------------
// Impression batching queue
//
// A feed scroll makes a dozen cards intersect the viewport almost at once, and
// each used to fire its own POST → its own server round-trip (a profile lookup,
// an existence check, the upsert and a read-back). That fan-out is the single
// biggest slice of Supabase write traffic in the app, and it scales with
// concurrent viewers like a self-inflicted DDoS. `recordImpressions` already
// accepts a batch, so we collect ids client-side and flush them as ONE call.
//
// Views are best-effort telemetry: collapsing N POSTs into one, delayed by a
// short window, is invisible to the reader — the card's tally still updates,
// driven by the `post_view_updated` realtime event the flush emits. So ingestion
// volume shrinks by an order of magnitude with no perceived performance cost.
// ---------------------------------------------------------------------------
const IMPRESSION_FLUSH_MS = 2000;
const IMPRESSION_BATCH_MAX = 40;
const pendingImpressions = new Set<string>();
let impressionTimer: ReturnType<typeof setTimeout> | null = null;
let impressionFlushHooked = false;

async function flushImpressions() {
  if (impressionTimer) {
    clearTimeout(impressionTimer);
    impressionTimer = null;
  }
  if (pendingImpressions.size === 0) return;
  const ids = Array.from(pendingImpressions);
  pendingImpressions.clear();
  // Fire-and-forget: a slow or failed telemetry write must never surface to the
  // reader. recordPostImpressions already no-ops for guests and swallows 403s.
  try {
    await recordPostImpressions(ids);
  } catch {
    /* best-effort */
  }
}

/**
 * Queue one post view for the next batched flush. De-duped against the pending
 * set (and, upstream, the card's own session set), so a card that re-enters the
 * viewport never re-sends. Flushes on a short timer, immediately at the batch
 * ceiling, and on navigation-away so nothing queued is lost.
 */
export function queuePostImpression(postId: string) {
  if (!isDbId(postId) || pendingImpressions.has(postId)) return;
  pendingImpressions.add(postId);
  // Hook the navigation-away flush once, so a reader who hides the tab or closes
  // the page mid-window still ships what they saw.
  if (!impressionFlushHooked && typeof window !== "undefined") {
    impressionFlushHooked = true;
    window.addEventListener("pagehide", () => void flushImpressions());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flushImpressions();
    });
  }
  // Hit the ceiling: ship now rather than wait out the timer.
  if (pendingImpressions.size >= IMPRESSION_BATCH_MAX) {
    void flushImpressions();
    return;
  }
  if (impressionTimer) return;
  impressionTimer = setTimeout(() => {
    impressionTimer = null;
    void flushImpressions();
  }, IMPRESSION_FLUSH_MS);
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
 * Real creator analytics for the signed-in profile — or, when `workspaceId`
 * is given, for a team's published posts (the owner-gated team Analytics tab).
 * Everything below is derived from posts, impressions, engagement rows,
 * follows and tips — there is no sample or placeholder data.
 */
export async function getCreatorAnalytics(
  timeframe: "7d" | "30d" = "7d",
  options: { workspaceId?: string } = {},
): Promise<CreatorAnalytics> {
  const userId = me();
  if (!isDbId(userId)) return EMPTY_ANALYTICS;

  const workspaceId =
    options.workspaceId && isDbId(options.workspaceId) ? options.workspaceId : null;

  const days = timeframe === "7d" ? 7 : 30;
  const since = new Date(Date.now() - days * 86400000);
  const sinceIso = since.toISOString();

  const { data: postRows } = await db
    .from("posts")
    .select("id,content,created_at,view_count,like_count,comment_count,repost_count")
    .eq(workspaceId ? "workspace_id" : "user_id", workspaceId ?? userId)
    .eq("hidden", false)
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

  // Analytics reads used to ship up to 5,000 impression and follow rows to the
  // browser just to total them. Pull an exact head count (cheap, no rows) for the
  // headline numbers and only fetch a bounded recent sample to shape the
  // trend/hourly/reach/region breakdowns — same visual result, a fraction of the
  // bytes and backend pressure.
  const IMPRESSION_SAMPLE = 500;
  const FOLLOWER_SAMPLE = 1000;

  const [impressionsRes, impressionsCountRes, followersRes, followersCountRes, tipsRes] =
    await Promise.all([
      postIds.length
        ? db
            .from("post_impressions")
            .select("post_id,user_id,created_at")
            .in("post_id", postIds)
            .gte("created_at", sinceIso)
            .limit(IMPRESSION_SAMPLE)
        : Promise.resolve({ data: [] as any[] }),
      postIds.length
        ? db
            .from("post_impressions")
            .select("post_id", { count: "exact", head: true })
            .in("post_id", postIds)
            .gte("created_at", sinceIso)
        : Promise.resolve({ count: 0 } as { count: number | null }),
      // Teams have no follow graph yet — audience stats stay personal.
      workspaceId
        ? Promise.resolve({ data: [] as any[] })
        : db.from("follows").select("follower_id").eq("target_id", userId).limit(FOLLOWER_SAMPLE),
      workspaceId
        ? Promise.resolve({ count: 0 } as { count: number | null })
        : db
            .from("follows")
            .select("follower_id", { count: "exact", head: true })
            .eq("target_id", userId),
      workspaceId
        ? db
            .from("tips")
            .select("id,amount,currency,message,created_at,from_user_id")
            .eq("to_workspace_id", workspaceId)
            .order("created_at", { ascending: false })
            .limit(200)
        : db
            .from("tips")
            .select("id,amount,currency,message,created_at,from_user_id")
            .eq("to_user_id", userId)
            .order("created_at", { ascending: false })
            .limit(200),
    ]);

  const impressions = (impressionsRes.data ?? []) as any[];
  const impressionCount = impressionsCountRes.count ?? impressions.length;
  const followerIds = ((followersRes.data ?? []) as any[]).map((r) => String(r.follower_id));
  const followersCount = followersCountRes.count ?? followerIds.length;
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
  const totalImpressions = Math.max(totalViews, impressionCount);
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
    hasData: posts.length > 0 || tips.length > 0 || followersCount > 0,
    totals: {
      impressions: totalImpressions,
      reach,
      engagementRate: Number(engagementRate.toFixed(1)),
      profileClicks: 0,
      followers: followersCount,
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
