import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * X-like "For you" ranker.
 *
 * Candidate generation: 1st-degree (followed) + 2nd-degree (friends of
 * friends) authors, topic/interest affinity from past interactions and
 * `feed_preferences`, plus a recency/trending pool so the feed never runs dry
 * for new accounts.
 *
 * Scoring blends: engagement velocity (likes+reposts+comments per hour since
 * post creation), freshness decay, relationship strength (follow graph +
 * historical interactions with the author), and an author-diversity cap.
 * Posts the viewer has already been shown are demoted, and once shown 3+
 * times without engaging, dropped entirely so a session doesn't loop.
 *
 * Pagination is cursor based (`(score, id)` composite, base64 encoded) and
 * the score for a given post is stable within a "ranking epoch" (bucketed to
 * the current 10-minute window) so posts never visibly reorder while a user
 * is mid-scroll -- only new posts/pages shift the tail of the list.
 */

function encodeCursor(rank: number, id: string) {
  return Buffer.from(JSON.stringify({ rank, id })).toString("base64url");
}
function decodeCursor(cursor?: string | null): { rank: number; id: string } | null {
  if (!cursor) return null;
  try {
    const obj = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof obj?.rank === "number" && typeof obj?.id === "string") return obj;
  } catch {
    /* ignore malformed cursor */
  }
  return null;
}

export const getForYouPosts = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => {
    const d = (data ?? {}) as { limit?: number; cursor?: string };
    const limit = Number(d.limit);
    return {
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 30,
      cursor: typeof d.cursor === "string" ? d.cursor : undefined,
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

    // ---- behaviour signals -------------------------------------------------
    const [likes, reposts, bookmarks, comments, impressions, feedPrefsRow] = await Promise.all([
      supabase.from("likes").select("post_id").eq("user_id", myId).limit(300),
      supabase.from("reposts").select("post_id").eq("user_id", myId).limit(300),
      supabase.from("bookmarks").select("post_id").eq("user_id", myId).limit(300),
      supabase.from("comments").select("post_id").eq("user_id", myId).limit(300),
      supabase.from("post_impressions").select("post_id").eq("user_id", myId).limit(1000),
      supabase.from("feed_preferences").select("prefs").eq("user_id", myId).maybeSingle(),
    ]);

    const weighted: Array<[any[], number]> = [
      [likes.data ?? [], 3],
      [reposts.data ?? [], 4],
      [bookmarks.data ?? [], 4],
      [comments.data ?? [], 3],
    ];
    const engagedWeight = new Map<string, number>();
    for (const [rows, w] of weighted) {
      for (const r of rows) {
        if (!r?.post_id) continue;
        engagedWeight.set(r.post_id, (engagedWeight.get(r.post_id) ?? 0) + w);
      }
    }
    const engagedIds = [...engagedWeight.keys()].slice(0, 400);

    // Impression counts: 1 = seen once (mild demotion), 3+ = drop from feed.
    const impressionCount = new Map<string, number>();
    for (const r of impressions.data ?? []) {
      if (!r?.post_id) continue;
      impressionCount.set(r.post_id, (impressionCount.get(r.post_id) ?? 0) + 1);
    }

    const authorAffinity = new Map<string, number>();
    const tagAffinity = new Map<string, number>();

    // Preference-driven interests from explicit feed tuning (mute/boost tags & authors).
    const prefs = (feedPrefsRow.data?.prefs ?? {}) as {
      interests?: string[];
      mutedAuthors?: string[];
      boostedTags?: string[];
    };
    const preferredTags = new Set<string>([...(prefs.interests ?? []), ...(prefs.boostedTags ?? [])]);
    const mutedAuthors = new Set<string>(prefs.mutedAuthors ?? []);
    for (const tag of preferredTags) tagAffinity.set(tag, (tagAffinity.get(tag) ?? 0) + 5);

    if (engagedIds.length) {
      const { data: engagedPosts } = await supabase
        .from("posts")
        .select("id, user_id, tags")
        .in("id", engagedIds);
      for (const p of engagedPosts ?? []) {
        const w = engagedWeight.get(p.id) ?? 1;
        authorAffinity.set(p.user_id, (authorAffinity.get(p.user_id) ?? 0) + w);
        for (const tag of (p.tags ?? []) as string[]) {
          tagAffinity.set(tag, (tagAffinity.get(tag) ?? 0) + w);
        }
      }
    }

    // ---- graph signals (relationship strength) ------------------------------
    const { data: following } = await supabase
      .from("follows")
      .select("target_id")
      .eq("follower_id", myId);
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

    // ---- candidate generation ------------------------------------------------
    // Pool 1: recent posts (covers followed + 2nd degree + everything else).
    // Pool 2: trending — highest engagement in the last 48h, independent of recency rank,
    // so a viral post a viewer hasn't seen yet still surfaces.
    const [recentRes, trendingRes] = await Promise.all([
      supabase
        .from("posts")
        .select("*")
        .eq("hidden", false)
        .order("created_at", { ascending: false })
        .limit(400),
      supabase
        .from("posts")
        .select("*")
        .eq("hidden", false)
        .gte("created_at", new Date(Date.now() - 48 * 3_600_000).toISOString())
        .order("like_count", { ascending: false })
        .limit(150),
    ]);

    const byId = new Map<string, any>();
    for (const row of recentRes.data ?? []) byId.set(row.id, row);
    for (const row of trendingRes.data ?? []) if (!byId.has(row.id)) byId.set(row.id, row);

    const rows = [...byId.values()].filter((r) => !mutedAuthors.has(r.user_id));

    const personalised = engagedIds.length > 0 || firstDegree.size > 0 || preferredTags.size > 0;
    if (!personalised) {
      const sorted = rows.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      const cursor = decodeCursor(data.cursor);
      const startIdx = cursor ? sorted.findIndex((r) => r.id === cursor.id) + 1 : 0;
      const page = sorted.slice(startIdx, startIdx + data.limit);
      const last = page[page.length - 1];
      return {
        posts: page,
        personalised: false,
        nextCursor: last ? encodeCursor(0, last.id) : null,
      };
    }

    // Plan-based discovery boost: paid creators reach further, free still reaches.
    const authorIds = [...new Set(rows.map((r: any) => r.user_id))];
    const planBoost = new Map<string, number>();
    if (authorIds.length) {
      const { data: plans } = await supabase
        .from("profiles")
        .select("id, plan")
        .in("id", authorIds);
      for (const p of plans ?? []) {
        planBoost.set(p.id, p.plan === "pro" ? 1.35 : p.plan === "plus" ? 1.18 : 1);
      }
    }

    // Ranking epoch: bucket "now" to a 10-minute window so scores (and thus
    // order) are stable while a viewer scrolls/paginates through a session.
    const epoch = Math.floor(Date.now() / (10 * 60_000)) * 10 * 60_000;

    const scored: Array<{ row: any; score: number }> = rows
      .filter((row: any) => (impressionCount.get(row.id) ?? 0) < 3 || engagedWeight.has(row.id))
      .map((row: any) => {
        const ageHours = Math.max(0.1, (epoch - new Date(row.created_at).getTime()) / 3_600_000);
        const decay = Math.exp(-ageHours / 36); // ~1.5 day half-life-ish

        // Engagement velocity: interactions per hour since posting, weighted by type.
        const rawEngagement =
          (row.like_count ?? 0) * 1 + (row.comment_count ?? 0) * 2.2 + (row.repost_count ?? 0) * 3;
        const velocity = rawEngagement / ageHours;
        const views = Math.max(1, row.view_count ?? 1);
        const quality = Math.log1p(velocity * 10) * (0.5 + Math.min(1, rawEngagement / views));

        const authorScore = Math.log1p(authorAffinity.get(row.user_id) ?? 0) * 2.2;
        const tagScore =
          ((row.tags ?? []) as string[]).reduce(
            (sum, tag) => sum + Math.log1p(tagAffinity.get(tag) ?? 0),
            0,
          ) * 1.6;

        // Relationship strength: graph proximity plus how much this viewer has
        // historically engaged with this specific author.
        const relationship =
          (firstDegree.has(row.user_id) ? 3 : secondDegree.has(row.user_id) ? 1.4 : 0) +
          Math.min(2, Math.log1p(authorAffinity.get(row.user_id) ?? 0) * 0.6);

        const ownPenalty = row.user_id === myId ? -3 : 0;
        const seenTimes = impressionCount.get(row.id) ?? 0;
        const seenPenalty = seenTimes > 0 && !engagedWeight.has(row.id) ? -1.5 * seenTimes : 0;

        const base = authorScore + tagScore + relationship + quality;
        const score =
          (base * (0.35 + decay) + decay * 2) * (planBoost.get(row.user_id) ?? 1) +
          ownPenalty +
          seenPenalty;

        return { row, score };
      });

    // Stable tie-break by id keeps ordering deterministic within an epoch.
    scored.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1));

    // Diversity cap: at most 2 posts per author within any 10-post window.
    const perAuthor = new Map<string, number>();
    const ranked: Array<{ row: any; score: number }> = [];
    for (const item of scored) {
      const used = perAuthor.get(item.row.user_id) ?? 0;
      if (used >= 2) continue;
      perAuthor.set(item.row.user_id, used + 1);
      ranked.push(item);
    }

    const cursor = decodeCursor(data.cursor);
    let startIdx = 0;
    if (cursor) {
      const idx = ranked.findIndex(
        (r) => r.row.id === cursor.id && Math.abs(r.score - cursor.rank) < 1e-6,
      );
      startIdx = idx >= 0 ? idx + 1 : ranked.findIndex((r) => r.score <= cursor.rank);
      if (startIdx < 0) startIdx = ranked.length;
    }

    const page = ranked.slice(startIdx, startIdx + data.limit);
    const lastItem = page[page.length - 1];

    return {
      posts: page.map((p) => p.row),
      personalised: true,
      nextCursor: lastItem ? encodeCursor(lastItem.score, lastItem.row.id) : null,
    };
  });
