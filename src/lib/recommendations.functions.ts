import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  RANK_EPOCH_MS,
  finalizePage,
  pageFromSnapshot,
  rankForYou,
  readFeedPrefs,
  hasMutedTag,
  normalizeTag,
  scoreFreshRow,
} from "@/lib/feed-rank-core";

/**
 * X-like "For you" feed — SERVE path.
 *
 * Ranking is no longer done here. A background worker (lib/feed-worker.server)
 * materializes each viewer's ranked timeline into `timeline_items` ahead of the
 * request, so opening the feed is ONE indexed read (<=300 slim rows) plus a page
 * hydrate — not a 2,000-row pool transfer + rescore that could blow the caller's
 * 9s budget and stall the whole node process. The scoring formulas themselves
 * live, unchanged, in lib/feed-rank-core.
 *
 * Freshness without re-introducing the cost:
 *   - a new post fans out to a re-rank job (SQL trigger) and the worker rebuilds
 *     affected timelines within ~a tick;
 *   - the first page of a warm read also pull-merges brand-new posts from the
 *     authors you directly follow (a handful of rows, no RPC) so following
 *     someone shows their post immediately;
 *   - a brand-new / unranked viewer (or a manual refresh) runs the inline ranker
 *     once, stores it as their timeline, and serves from it thereafter.
 *
 * Pagination keeps the `(score, id)` cursor from the snapshot helper, so a
 * materialized timeline and a freshly-computed one page identically.
 */

// The materialized timeline is capped when stored and read so the serve path is
// bounded; a scroll session rarely reaches row 300 before the next epoch.
const TIMELINE_STORE_MAX = 300;
const TIMELINE_READ_MAX = 300;
// Pull-merge stays cheap: a bounded follow scan + a bounded fresh-post scan.
const FOLLOW_SCAN_MAX = 200;
const FRESH_SCAN_MAX = 50;

/**
 * Store a freshly-ranked list as this viewer's timeline for the epoch (top
 * `TIMELINE_STORE_MAX`). Runs on the VIEWER's own token, so RLS
 * (`owns_profile(viewer_id)`) already scopes the write to their rows. Best
 * effort: a failed store only means the next read re-ranks, never a wrong feed.
 */
async function persistTimeline(
  supabase: any,
  myId: string,
  epochBucket: number,
  entries: Array<{ row: any; score: number }>,
) {
  try {
    await supabase
      .from("timeline_items")
      .delete()
      .eq("viewer_id", myId)
      .eq("kind", "foryou");
    const top = entries.slice(0, TIMELINE_STORE_MAX);
    if (top.length === 0) return;
    const rows = top.map((e) => ({
      viewer_id: myId,
      kind: "foryou",
      post_id: e.row.id,
      author_id: e.row.user_id,
      score: e.score,
      epoch: epochBucket,
      created_at: new Date(e.row.created_at).toISOString(),
    }));
    await supabase.from("timeline_items").insert(rows);
  } catch (err) {
    console.warn("timeline store failed (will re-rank next read):", err);
  }
}

/** Nudge the queue so the worker refreshes this viewer again next epoch. */
async function enqueueRankJob(supabase: any, myId: string) {
  try {
    const dueAt = new Date((Math.floor(Date.now() / RANK_EPOCH_MS) + 1) * RANK_EPOCH_MS).toISOString();
    await supabase
      .from("feed_rank_jobs")
      .upsert(
        { viewer_id: myId, reason: "read", due_at: dueAt, updated_at: new Date().toISOString() },
        { onConflict: "viewer_id" },
      );
  } catch {
    /* best-effort: a dropped enqueue just means the epoch sweep re-ranks later */
  }
}

/**
 * Fold in posts published since the timeline was materialized by authors the
 * viewer directly follows. Scores them with the signal-independent portion of
 * the ranker (decay + velocity + reach), which is what surfaces genuinely-new
 * followed content at the right rank without paying for a full re-rank. Never
 * fatal: on any miss the caller just serves the stored timeline.
 */
async function mergeFreshFollowedPosts(
  supabase: any,
  myId: string,
  entries: Array<{ row: any; score: number }>,
): Promise<Array<{ row: any; score: number }>> {
  try {
    let watermark = 0;
    for (const e of entries) {
      const t = new Date(e.row.created_at).getTime();
      if (t > watermark) watermark = t;
    }
    if (!watermark) watermark = Math.floor(Date.now() / RANK_EPOCH_MS) * RANK_EPOCH_MS;

    const { data: follows } = await supabase
      .from("follows")
      .select("target_id")
      .eq("follower_id", myId)
      .limit(FOLLOW_SCAN_MAX);
    const authorIds = ((follows ?? []) as any[]).map((f) => f.target_id).filter(Boolean);
    if (authorIds.length === 0) return entries;

    const have = new Set(entries.map((e) => e.row.id));
    const { data: fresh } = await supabase
      .from("posts")
      .select(
        "id,user_id,created_at,like_count,comment_count,repost_count,view_count,workspace_id",
      )
      .in("user_id", authorIds)
      .eq("hidden", false)
      .gt("created_at", new Date(watermark).toISOString())
      .order("created_at", { ascending: false })
      .limit(FRESH_SCAN_MAX);

    const epoch = Math.floor(Date.now() / RANK_EPOCH_MS) * RANK_EPOCH_MS;
    const extra = ((fresh ?? []) as any[])
      .filter((p) => p?.id && !have.has(p.id))
      .map((p) => ({ row: p, score: scoreFreshRow(p, epoch) }));
    if (extra.length === 0) return entries;

    const merged = [...entries, ...extra];
    merged.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1));
    return merged;
  } catch {
    return entries;
  }
}

export const getForYouPosts = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => {
    const d = (data ?? {}) as { limit?: number; cursor?: string; refresh?: boolean };
    const limit = Number(d.limit);
    return {
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 30,
      cursor: typeof d.cursor === "string" ? d.cursor : undefined,
      // Manual refresh: rank with the live clock instead of the frozen 10-min
      // epoch, so pressing Refresh can never return an identical page.
      refresh: d.refresh === true,
    };
  })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as any;

    const { data: me } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!me) return { posts: [] as any[], personalised: false, nextCursor: null };
    const myId = me.id as string;

    const epochBucket = Math.floor(Date.now() / RANK_EPOCH_MS);

    // ---- warm path: read the materialized timeline (no ranking here) --------
    // A viewer holds exactly one epoch's rows (both persist paths delete-then-
    // insert), so we serve the latest stored timeline regardless of epoch and
    // let the worker/next-refresh advance it — no inline re-rank at a rollover.
    let entries: Array<{ row: any; score: number }> | null = null;
    let personalised = true;
    if (!data.refresh) {
      const { data: rows } = await supabase
        .from("timeline_items")
        .select("post_id, score, author_id, created_at")
        .eq("viewer_id", myId)
        .eq("kind", "foryou")
        .order("score", { ascending: false })
        .order("post_id", { ascending: true })
        .limit(TIMELINE_READ_MAX);
      if (rows && rows.length > 0) {
        entries = (rows as any[]).map((r) => ({
          row: { id: r.post_id, user_id: r.author_id, created_at: r.created_at },
          score: r.score,
        }));
      }
    }

    // ---- cold miss / refresh: rank inline once, then store + serve from it --
    // The caller bounds this call with its own budget; if it overruns, the catch
    // there falls back to recency exactly as before. Storing means the NEXT read
    // is a plain index scan, which is the whole point of the redesign.
    if (!entries) {
      const ranked = await rankForYou(supabase, myId, {
        refresh: data.refresh,
        limit: data.limit,
      });
      personalised = ranked.personalised;
      entries = ranked.entries;
      if (personalised) await persistTimeline(supabase, myId, epochBucket, entries);
    }

    // Surface genuinely-new followed posts on the head page without a re-rank.
    if (personalised && !data.cursor) {
      entries = await mergeFreshFollowedPosts(supabase, myId, entries);
    }

    // Keep the queue warm so the worker refreshes this viewer next epoch.
    void enqueueRankJob(supabase, myId);

    const page = pageFromSnapshot(entries, personalised, data.cursor, data.limit);
    return finalizePage(supabase, page);
  });

/**
 * Personalised "Who to follow" — the people analogue of `getForYouPosts`.
 *
 * Ranks not-yet-followed creators with the same signals the For-you feed
 * uses: how much this viewer engages with their content (author affinity),
 * graph proximity (people the accounts they follow also follow), overlap
 * between the viewer's tuned interests/tags and the creator's recent posts,
 * audience size, and activity/recency — plus a mild boost for paid-plan and
 * verified creators. Already-followed and explicitly muted authors are
 * filtered out entirely.
 *
 * Returns full profile rows so the rail can render them without a second
 * fetch. Guests (no bearer token) can't call this — the rail keeps its
 * chronological fallback for them.
 */
export const getWhoToFollow = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => {
    const d = (data ?? {}) as { limit?: number };
    const limit = Number(d.limit);
    return { limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 20) : 6 };
  })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as any;

    const { data: me } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!me) return { profiles: [] as any[] };
    const myId = me.id as string;

    // ---- behaviour signals (same affinity feeds the post ranker) ----------
    const [likes, reposts, bookmarks, comments, feedPrefsRow] = await Promise.all([
      supabase.from("likes").select("post_id").eq("user_id", myId).limit(300),
      supabase.from("reposts").select("post_id").eq("user_id", myId).limit(300),
      supabase.from("bookmarks").select("post_id").eq("user_id", myId).limit(300),
      supabase.from("comments").select("post_id").eq("user_id", myId).limit(300),
      supabase.from("feed_preferences").select("prefs").eq("user_id", myId).maybeSingle(),
    ]);

    const engagedIds = new Set<string>();
    for (const rows of [likes.data, reposts.data, bookmarks.data, comments.data]) {
      for (const r of rows ?? []) if (r?.post_id) engagedIds.add(r.post_id);
    }

    const { preferredTags, mutedTags, mutedAuthors } = readFeedPrefs(feedPrefsRow.data?.prefs);

    // Author affinity: engagement weighted by interaction type.
    const authorAffinity = new Map<string, number>();
    const engagedList = [...engagedIds].slice(0, 400);
    if (engagedList.length) {
      const { data: engagedPosts } = await supabase
        .from("posts")
        .select("user_id")
        .in("id", engagedList);
      for (const p of engagedPosts ?? []) {
        if (!p?.user_id) continue;
        authorAffinity.set(p.user_id, (authorAffinity.get(p.user_id) ?? 0) + 3);
      }
    }

    // ---- graph signals ------------------------------------------------------
    const { data: following } = await supabase
      .from("follows")
      .select("target_id")
      .eq("follower_id", myId);
    const firstDegree = new Set<string>((following ?? []).map((f: any) => f.target_id));

    // Second degree: who do the accounts I follow follow? (friends-of-friends)
    const secondDegreeCount = new Map<string, number>();
    if (firstDegree.size) {
      const { data: theirFollows } = await supabase
        .from("follows")
        .select("target_id")
        .in("follower_id", [...firstDegree].slice(0, 200));
      for (const f of theirFollows ?? []) {
        const tid = f?.target_id as string;
        if (!tid || tid === myId || firstDegree.has(tid)) continue;
        secondDegreeCount.set(tid, (secondDegreeCount.get(tid) ?? 0) + 1);
      }
    }

    // Candidate pool: active accounts I don't follow yet, strongest audience
    // first — plus everyone my network already follows (graph candidates can
    // have a small audience but high relevance).
    const candidateIds = new Set<string>(secondDegreeCount.keys());
    const { data: popular } = await supabase
      .from("profiles")
      .select("id")
      .neq("id", myId)
      .eq("status", "active")
      .order("followers", { ascending: false })
      .limit(120);
    for (const p of popular ?? []) candidateIds.add(p.id);
    for (const [authorId] of authorAffinity) candidateIds.add(authorId);

    const ids = [...candidateIds].filter((id) => id !== myId && !mutedAuthors.has(id));
    if (!ids.length) return { profiles: [] as any[] };

    const { data: rows } = await supabase
      .from("profiles")
      .select(
        "id, username, display_name, avatar_url, bio, location, website, plan, verified, followers, following, last_active, created_at",
      )
      .eq("status", "active")
      .in("id", ids.slice(0, 300));
    let candidates = (rows ?? []).filter((p: any) => !firstDegree.has(p.id));

    // Tag overlap: recent public topics each candidate posts about.
    const candIds = candidates.map((p: any) => p.id);
    const tagOverlap = new Map<string, number>();
    const lastActive = new Map<string, number>();
    // Authors whose recent public posts carry a tag this viewer muted are not
    // suggested back to them — "not interested in #x" should mean that.
    const mutedTagAuthors = new Set<string>();
    if (candIds.length) {
      const { data: recentPosts } = await supabase
        .from("posts")
        .select("user_id, tags, created_at")
        .in("user_id", candIds)
        .eq("hidden", false)
        .order("created_at", { ascending: false })
        .limit(600);
      for (const post of recentPosts ?? []) {
        const uid = post.user_id as string;
        if (!lastActive.has(uid)) lastActive.set(uid, new Date(post.created_at).getTime());
        if (hasMutedTag(post.tags, mutedTags)) {
          mutedTagAuthors.add(uid);
          continue;
        }
        for (const tag of (post.tags ?? []) as string[]) {
          if (preferredTags.has(normalizeTag(tag)))
            tagOverlap.set(uid, (tagOverlap.get(uid) ?? 0) + 1);
        }
      }
    }
    if (mutedTagAuthors.size) {
      candidates = candidates.filter((p: any) => !mutedTagAuthors.has(p.id));
    }

    const planFactor = (plan?: string | null) =>
      plan === "pro" ? 1.35 : plan === "plus" ? 1.18 : 1;
    const now = Date.now();
    const scored = candidates.map((p: any) => {
      const relationship =
        Math.min(3, (secondDegreeCount.get(p.id) ?? 0) * 0.8) +
        Math.min(2, Math.log1p(authorAffinity.get(p.id) ?? 0) * 0.9);
      const affinity = tagOverlap.get(p.id) ?? 0;
      const audience = Math.log1p(Number(p.followers ?? 0));
      const activityTs = lastActive.get(p.id) ?? new Date(p.last_active ?? 0).getTime();
      const activityDays = Math.max(0.04, (now - activityTs) / 86_400_000);
      const activity = 1.2 * Math.exp(-activityDays / 10);
      const verifiedBoost = p.verified ? 0.6 : 0;
      const score =
        (1 + relationship) * (0.5 + audience + affinity * 1.5 + activity) * planFactor(p.plan) +
        verifiedBoost;
      return { p, score };
    });

    scored.sort((a: any, b: any) => b.score - a.score || (a.p.id < b.p.id ? -1 : 1));
    return { profiles: scored.slice(0, data.limit).map((s: any) => s.p) };
  });

/**
 * Personalised Space ranking — the audio-room analogue of `getForYouPosts`.
 *
 * Rooms are ranked by relationship to the viewer (hosts they follow, and
 * friends-of-friends), topical affinity against their tuned feed interests,
 * live-audience momentum, freshness, and a plan-based discovery boost. The
 * client already has the full Space list; this returns only `{id, score}` so
 * the Spaces page can reorder its existing cards without a second fetch, and
 * degrades to the default (chronological) order for guests / unpersonalised
 * accounts.
 */
export const getRecommendedSpaces = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => {
    const d = (data ?? {}) as { limit?: number };
    const limit = Number(d.limit);
    return { limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 60 };
  })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as any;

    const { data: me } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!me) return { ranked: [] as { id: string; score: number }[], personalised: false };
    const myId = me.id as string;

    const [{ data: following }, feedPrefsRow] = await Promise.all([
      supabase.from("follows").select("target_id").eq("follower_id", myId),
      supabase.from("feed_preferences").select("prefs").eq("user_id", myId).maybeSingle(),
    ]);
    const firstDegree = new Set<string>((following ?? []).map((f: any) => f.target_id));
    let secondDegree = new Set<string>();
    if (firstDegree.size) {
      const { data: theirFollows } = await supabase
        .from("follows")
        .select("target_id")
        .in("follower_id", [...firstDegree].slice(0, 200));
      secondDegree = new Set<string>(
        (theirFollows ?? [])
          .map((f: any) => f.target_id)
          .filter((id: string) => id !== myId && !firstDegree.has(id)),
      );
    }

    const { preferredTags, mutedTags, mutedAuthors } = readFeedPrefs(feedPrefsRow.data?.prefs);
    const interestTokens = [...preferredTags];

    const epoch = Math.floor(Date.now() / (10 * 60_000)) * 10 * 60_000;
    const { data: spaces } = await supabase
      .from("spaces")
      .select("id, host_id, topic, live, listeners, created_at")
      .eq("recorded", false)
      .order("created_at", { ascending: false })
      .limit(200);
    const candidates = (spaces ?? []).filter((s: any) => {
      if (mutedAuthors.has(s.host_id)) return false;
      const topic = normalizeTag(String(s.topic ?? ""));
      // A room about a topic the viewer muted never appears in their list.
      return !topic || ![...mutedTags].some((t) => topic.includes(t));
    });

    const personalised = firstDegree.size > 0 || interestTokens.length > 0;
    if (!personalised)
      return { ranked: [] as { id: string; score: number }[], personalised: false };

    const scored = candidates.map((s: any) => {
      const relationship = firstDegree.has(s.host_id) ? 3 : secondDegree.has(s.host_id) ? 1.4 : 0;
      const topic = String(s.topic ?? "").toLowerCase();
      const affinity = interestTokens.some((tok) => topic && topic.includes(tok)) ? 2 : 0;
      const momentum = Math.log1p(Number(s.listeners ?? 0));
      const ageHours = Math.max(0.1, (epoch - new Date(s.created_at).getTime()) / 3_600_000);
      const freshness = Math.exp(-ageHours / 48);
      // Live rooms get an immediate reach boost over merely-upcoming ones.
      const liveBoost = s.live ? 1.5 : 0;
      const ownPenalty = s.host_id === myId ? -2 : 0;
      const score = relationship + affinity + momentum + freshness * 2 + liveBoost + ownPenalty;
      return { id: s.id as string, score };
    });

    scored.sort((a: any, b: any) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return { ranked: scored.slice(0, data.limit), personalised: true };
  });
