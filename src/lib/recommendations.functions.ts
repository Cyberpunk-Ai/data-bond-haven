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
 * times without engaging they sink behind everything unseen — the feed only
 * replays them once the platform genuinely has no fresh candidate left, so a
 * session doesn't loop while there is something new to show and never runs
 * dry when there isn't.
 *
 * Pagination is cursor based (`(score, id)` composite, base64 encoded) and
 * the score for a given post is stable within a "ranking epoch" (bucketed to
 * the current 10-minute window) so posts never visibly reorder while a user
 * is mid-scroll -- only new posts/pages shift the tail of the list.
 */

/**
 * Feed tuning the client writes (`sendFeedFeedback`) stores camelCase keys —
 * preferredTags / mutedTags / mutedAuthors — while this ranker historically
 * only read `interests` / `boostedTags`, so "Interested in #x" and "Not
 * interested in #x" were persisted and then ignored. Read every alias so one
 * tuned preference shape can't silently no-op.
 */
function readFeedPrefs(raw: unknown): {
  preferredTags: Set<string>;
  mutedTags: Set<string>;
  mutedAuthors: Set<string>;
} {
  const p = (raw ?? {}) as Record<string, unknown>;
  const list = (...keys: string[]) =>
    keys.flatMap((k) => (Array.isArray(p[k]) ? (p[k] as unknown[]).map(String) : []));
  const norm = (t: string) => t.toLowerCase().replace(/^#/, "").trim();
  return {
    preferredTags: new Set(
      [...list("preferredTags", "interests", "boostedTags", "preferred_tags")].map(norm),
    ),
    mutedTags: new Set([...list("mutedTags", "hidden_tags", "muted_tags")].map(norm)),
    mutedAuthors: new Set(list("mutedAuthors", "muted_authors")),
  };
}

/** Does any tag on a post sit in the viewer's muted list? (case/`#` insensitive) */
function hasMutedTag(tags: unknown, muted: Set<string>): boolean {
  if (muted.size === 0 || !Array.isArray(tags)) return false;
  return tags.some((t) => muted.has(normalizeTag(String(t))));
}

/** Topics are compared case- and `#`-insensitively everywhere they are matched. */
function normalizeTag(tag: unknown): string {
  return String(tag ?? "")
    .toLowerCase()
    .replace(/^#/, "")
    .trim();
}

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

/**
 * Slice one page out of an already-ranked list. Shared by the cold path (fresh
 * pool walk) and the warm path (snapshot hit) so pagination is byte-identical
 * whether the list was just computed or replayed from cache. Personalised
 * cursors carry `(score, id)`; the recency-led fallback carries `(0, id)` and
 * pages purely by id. This is what lets a scroll session paginate against the
 * SAME ranked list without re-walking the pool on every page.
 */
function pageFromSnapshot(
  entries: Array<{ row: any; score: number }>,
  personalised: boolean,
  cursor: string | undefined,
  limit: number,
) {
  const decoded = decodeCursor(cursor);
  let startIdx = 0;
  if (decoded) {
    if (personalised) {
      const idx = entries.findIndex(
        (e) => e.row.id === decoded.id && Math.abs(e.score - decoded.rank) < 1e-6,
      );
      startIdx = idx >= 0 ? idx + 1 : entries.findIndex((e) => e.score <= decoded.rank);
      if (startIdx < 0) startIdx = entries.length;
    } else {
      startIdx = entries.findIndex((e) => e.row.id === decoded.id) + 1;
      if (startIdx <= 0) startIdx = 0;
    }
  }
  const page = entries.slice(startIdx, startIdx + limit);
  const last = page[page.length - 1];
  return {
    posts: page.map((e) => e.row),
    personalised,
    nextCursor: last ? encodeCursor(personalised ? last.score : 0, last.row.id) : null,
  };
}

/**
 * Per-viewer ranked snapshots, keyed by viewer + the 10-minute ranking epoch
 * they were computed for. Without this, EVERY page of "For you" re-fetched
 * the entire visible pool and re-scored it — a scroll through a 1,500-post
 * library was 1,500 rows of compute per screen, most of it identical to the
 * last page. One scroll session now costs one pool walk.
 */
interface RankedSnapshot {
  entries: Array<{ row: any; score: number }>;
  personalised: boolean;
  expiresAt: number;
}
const rankedSnapshots = new Map<string, RankedSnapshot>();
const SNAPSHOT_MAX = 200;
const RANK_EPOCH_MS = 10 * 60_000;

function snapshotFor(myId: string, epochBucket: number): RankedSnapshot | null {
  const hit = rankedSnapshots.get(`${myId}:${epochBucket}`);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    rankedSnapshots.delete(`${myId}:${epochBucket}`);
    return null;
  }
  return hit;
}

function rememberSnapshot(
  myId: string,
  epochBucket: number,
  snapshot: Omit<RankedSnapshot, "expiresAt">,
) {
  const now = Date.now();
  // Live until a minute past the end of the epoch: a scroll that crosses the
  // boundary finishes its stable list instead of paying for a re-rank.
  rankedSnapshots.set(`${myId}:${epochBucket}`, {
    ...snapshot,
    expiresAt: (epochBucket + 1) * RANK_EPOCH_MS + 60_000,
  });
  // Opportunistic trim: epoch keys die naturally, but a burst of distinct
  // viewers could still pile up.
  for (const [key, snap] of rankedSnapshots) {
    if (snap.expiresAt < now) rankedSnapshots.delete(key);
  }
  while (rankedSnapshots.size > SNAPSHOT_MAX) {
    const oldest = rankedSnapshots.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    rankedSnapshots.delete(oldest);
  }
}

/**
 * Deterministic per-key jitter in [0,1). Used for discovery: mixing the
 * viewer id into the seed means two users with similar-but-different histories
 * get genuinely different tails of content, while the same (viewer, post,
 * epoch) triple always hashes identically — so a page never reshuffles itself
 * mid-scroll and the ranker stays reproducible (and debuggable) per epoch.
 */
function jitter01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296;
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

    // One ranked list per viewer per 10-minute epoch, reused across every page
    // of a scroll session: the pool walk, the six behaviour queries, the plan
    // lookups and the rescoring below then run ONCE, not on each "load more".
    // A manual refresh skips the read so Refresh can never hand back an
    // identical page, and overwrites the snapshot as the new baseline.
    const epochBucket = Math.floor(Date.now() / RANK_EPOCH_MS);
    if (!data.refresh) {
      const cached = snapshotFor(myId, epochBucket);
      if (cached)
        return pageFromSnapshot(cached.entries, cached.personalised, data.cursor, data.limit);
    }

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
    const { preferredTags, mutedTags, mutedAuthors } = readFeedPrefs(feedPrefsRow.data?.prefs);
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
          // Keyed the same way preferredTags is (normalised) so an affinity boost
          // survives a creator typing "#AI" where the viewer tuned "ai".
          const norm = normalizeTag(tag);
          if (!norm) continue;
          tagAffinity.set(norm, (tagAffinity.get(norm) ?? 0) + w);
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
    // Fetched in chunks so the pool holds EVERY visible post, not just the
    // newest few hundred — an older post can only leave the feed because it
    // ranked below the page window, never because a `limit` silently cut it
    // off. The short chunk answers fast, so stopping there costs nothing.
    // Fetched as ONE parallel batch instead of a sequential 4-request walk:
    // the candidate ceiling is identical, but the whole pool lands in ~a single
    // round trip rather than four back-to-back ones (plus a fifth for trending),
    // so a cold epoch can no longer stall past the client's fetch timeout. Empty
    // trailing ranges cost nothing on a small DB.
    const POOL_CHUNK = 500;
    const POOL_MAX = 2000;
    const trendingSince = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const poolBatch = await Promise.all([
      ...Array.from({ length: POOL_MAX / POOL_CHUNK }, (_, i) =>
        supabase
          .from("posts")
          .select("*")
          .eq("hidden", false)
          .order("created_at", { ascending: false })
          .range(i * POOL_CHUNK, i * POOL_CHUNK + POOL_CHUNK - 1),
      ),
      // Pool 2: trending — highest engagement in the last 48h, independent of
      // recency rank, so a viral post a viewer hasn't seen yet still surfaces.
      supabase
        .from("posts")
        .select("*")
        .eq("hidden", false)
        .gte("created_at", trendingSince)
        .order("like_count", { ascending: false })
        .limit(300),
    ]);
    const recentRows: any[] = [];
    for (const res of poolBatch.slice(0, -1)) {
      if (!res.error && res.data?.length) recentRows.push(...res.data);
    }
    const trendingRes = poolBatch[poolBatch.length - 1];

    const byId = new Map<string, any>();
    for (const row of recentRows) byId.set(row.id, row);
    for (const row of trendingRes.data ?? []) if (!byId.has(row.id)) byId.set(row.id, row);

    // Every visible post is feed material — including your own: "show all
    // available posts" means the ranker never hides a category by fiat, and
    // the 2-per-10-window diversity cap below already stops one account
    // (including the viewer) from flooding a screenful. Tags the viewer
    // muted through the post menu are still dropped here.
    const rows = [...byId.values()].filter(
      (r) => !mutedAuthors.has(r.user_id) && !hasMutedTag(r.tags, mutedTags),
    );

    const personalised =
      engagedIds.length > 0 || firstDegree.size > 0 || preferredTags.size > 0 || mutedTags.size > 0;
    if (!personalised) {
      // Brand-new viewer: still recency-led, but nudged ±6h by a per-user
      // hash so two fresh accounts don't stare at an identical feed, and
      // everyone keeps seeing mostly-new content. Deterministic within the
      // 10-minute epoch, so pagination is stable.
      const newBucket = Math.floor(Date.now() / (10 * 60_000));
      const adjusted = (r: any) =>
        new Date(r.created_at).getTime() +
        (jitter01(`${myId}:${r.id}:${newBucket}`) - 0.5) * 12 * 3_600_000;
      const sorted = rows.sort((a, b) => adjusted(b) - adjusted(a));
      const entries = sorted.map((row) => ({ row, score: 0 }));
      rememberSnapshot(myId, epochBucket, { entries, personalised: false });
      return pageFromSnapshot(entries, false, data.cursor, data.limit);
    }

    // Plan-based discovery boost: paid creators AND paid team workspaces reach
    // further; free still reaches. A workspace post inherits the boost from the
    // workspace's own plan, falling back to its owner's personal plan when the
    // workspace itself is on the free tier — so a Pro/Plus account boosts the
    // reach of the team brand it posts under, not just its personal handle.
    const planFactor = (plan?: string | null) =>
      plan === "pro" ? 1.35 : plan === "plus" ? 1.18 : 1;
    const authorIds = [...new Set(rows.map((r: any) => r.user_id))];
    const wsIds = [...new Set(rows.map((r: any) => r.workspace_id).filter(Boolean))];
    const planBoost = new Map<string, number>();
    const wsBoost = new Map<string, number>();
    if (authorIds.length) {
      const { data: plans } = await supabase
        .from("profiles")
        .select("id, plan")
        .in("id", authorIds);
      for (const p of plans ?? []) planBoost.set(p.id, planFactor(p.plan));
    }
    if (wsIds.length) {
      const { data: wsRows } = await supabase
        .from("workspaces")
        .select("id, plan, owner_id")
        .in("id", wsIds);
      const ownerIds = [
        ...new Set(
          (wsRows ?? [])
            .filter((w: any) => !w.plan || w.plan === "free")
            .map((w: any) => w.owner_id),
        ),
      ];
      const ownerPlan = new Map<string, string>();
      if (ownerIds.length) {
        const { data: op } = await supabase.from("profiles").select("id, plan").in("id", ownerIds);
        for (const p of op ?? []) ownerPlan.set(p.id, p.plan);
      }
      for (const w of wsRows ?? []) {
        const eff = w.plan && w.plan !== "free" ? w.plan : ownerPlan.get(w.owner_id);
        wsBoost.set(w.id, planFactor(eff));
      }
    }

    // Ranking epoch: bucket "now" to a 10-minute window so scores (and thus
    // order) are stable while a viewer scrolls/paginates through a session.
    // An explicit refresh opts out and ranks with the live clock.
    const epoch = data.refresh ? Date.now() : Math.floor(Date.now() / (10 * 60_000)) * 10 * 60_000;

    const scored: Array<{ row: any; score: number }> = rows.map((row: any) => {
      const ageHours = Math.max(0.1, (epoch - new Date(row.created_at).getTime()) / 3_600_000);
      const decay = Math.exp(-ageHours / 36); // ~1.5 day half-life-ish

      // Engagement velocity: interactions per hour since posting, weighted by type.
      const rawEngagement =
        (row.like_count ?? 0) * 1 + (row.comment_count ?? 0) * 2.2 + (row.repost_count ?? 0) * 3;
      const velocity = rawEngagement / ageHours;
      const views = Math.max(1, row.view_count ?? 1);
      const quality = Math.log1p(velocity * 10) * (0.5 + Math.min(1, rawEngagement / views));

      const authorScore = Math.log1p(authorAffinity.get(row.user_id) ?? 0) * 2.2;
      // Post tags are matched through the same normaliser the affinity map is
      // keyed with, so `#AI` and `ai` are one topic.
      const tagScore =
        ((row.tags ?? []) as string[]).reduce(
          (sum, tag) => sum + Math.log1p(tagAffinity.get(normalizeTag(tag)) ?? 0),
          0,
        ) * 1.6;

      // Relationship strength: graph proximity plus how much this viewer has
      // historically engaged with this specific author.
      const relationship =
        (firstDegree.has(row.user_id) ? 3 : secondDegree.has(row.user_id) ? 1.4 : 0) +
        Math.min(2, Math.log1p(authorAffinity.get(row.user_id) ?? 0) * 0.6);

      const seenTimes = impressionCount.get(row.id) ?? 0;
      const seenPenalty = seenTimes > 0 && !engagedWeight.has(row.id) ? -1.5 * seenTimes : 0;

      // Discovery nudge: content completely outside this viewer's known
      // world (unfollowed, never-engaged author AND no affinity tags) gets a
      // small per-(viewer, post, epoch) bonus — up to +1.4, bounded so it
      // can never out-rank genuinely relevant posts. Because the seed
      // carries the viewer id, different users explore different corners of
      // the same pool instead of everyone converging on one global ranking;
      // because it is multiplied through the decay term, only fresh unknowns
      // get the lift, which is what "discover new things" should mean.
      const tagsArr = (row.tags ?? []) as string[];
      const outsideKnownWorld =
        !firstDegree.has(row.user_id) &&
        !secondDegree.has(row.user_id) &&
        !authorAffinity.has(row.user_id) &&
        !tagsArr.some((tag) => tagAffinity.has(normalizeTag(tag)));
      const discovery = outsideKnownWorld ? jitter01(`${myId}:${row.id}:${epoch}`) * 1.4 : 0;

      const base = authorScore + tagScore + relationship + quality + discovery;
      // Paid team workspaces boost by the workspace (or its owner's) plan;
      // personal posts boost by the author's plan.
      const reachBoost = row.workspace_id
        ? (wsBoost.get(row.workspace_id) ?? planBoost.get(row.user_id) ?? 1)
        : (planBoost.get(row.user_id) ?? 1);
      const score = (base * (0.35 + decay) + decay * 2) * reachBoost + seenPenalty;

      return { row, score };
    });

    // Stable tie-break by id keeps ordering deterministic within an epoch.
    scored.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1));

    // Seen-3+-times-without-engaging posts sink to the back of the queue
    // instead of leaving it: while unseen content can still fill a page the
    // replayed ones stay hidden (a session doesn't loop), but once the fresh
    // supply runs out they become candidates again — every available post
    // stays reachable through the feed.
    const unseen = scored.filter(
      (s) => (impressionCount.get(s.row.id) ?? 0) < 3 || engagedWeight.has(s.row.id),
    );
    const replayed = scored.filter(
      (s) => (impressionCount.get(s.row.id) ?? 0) >= 3 && !engagedWeight.has(s.row.id),
    );
    const queue = unseen.length >= data.limit ? unseen : [...unseen, ...replayed];

    // Diversity cap: at most 2 posts per author inside any 10-post sliding
    // window (a very prolific author still reaches deeper pages — unlike a
    // hard global cap — but no one floods a screenful). A post that fails the
    // window on this pass is DEFERRED to the next one, never dropped: a
    // single-pass `continue` used to permanently hide an author's third-plus
    // posts whenever the window kept refilling with other people's content,
    // so the feed quietly swallowed part of the pool. Each pass re-evaluates
    // against the (now longer) ranked tail, and the leftovers are appended in
    // score order once no placement can honour the window.
    const ranked: Array<{ row: any; score: number }> = [];
    let pending = queue;
    while (pending.length) {
      const deferred: typeof pending = [];
      const placed: typeof pending = [];
      // The candidate tail is `ranked` followed by this pass's `placed`, so a
      // window slot maps onto one or the other depending on its position.
      const at = (i: number) => (i < ranked.length ? ranked[i] : placed[i - ranked.length]);
      for (const item of pending) {
        const total = ranked.length + placed.length;
        let inWindow = 0;
        for (let i = Math.max(0, total - 9); i < total; i++) {
          if (at(i).row.user_id === item.row.user_id) inWindow++;
        }
        (inWindow >= 2 ? deferred : placed).push(item);
      }
      if (!placed.length) {
        // Stall-break: the window is genuinely saturated for every leftover
        // (more posts from one author than 10-slots can hold at 2 each).
        // Place only the BEST deferred item, then re-evaluate the rest
        // against the advanced tail — full coverage without ever flooding.
        placed.push(pending[0]);
        pending = pending.slice(1);
      } else {
        pending = deferred;
      }
      ranked.push(...placed);
    }

    rememberSnapshot(myId, epochBucket, { entries: ranked, personalised: true });
    return pageFromSnapshot(ranked, true, data.cursor, data.limit);
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
