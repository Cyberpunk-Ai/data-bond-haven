/**
 * "For you" ranking core — the pure retrieve + score pipeline.
 *
 * It used to live inline in `recommendations.functions.ts` and run INSIDE the
 * request path, so every cold epoch transferred the shared candidate pool and
 * the viewer's signals and re-scored up to 2,000 rows while the visitor waited.
 * The feed redesign keeps the FORMULAS byte-for-byte identical but moves WHEN
 * they run: this module is shared by the background materializer (the request
 * path never blocks on it) and by the server function's cold-miss fallback.
 *
 * Nothing here knows about HTTP, caching snapshots, or paging a response — it
 * turns (supabase, viewer) into an ordered, diversity-capped list of
 * `{ row, score }`. The caller pages it with `pageFromSnapshot` and hydrates it
 * with `finalizePage`.
 */

/**
 * Feed tuning the client writes (`sendFeedFeedback`) stores camelCase keys —
 * preferredTags / mutedTags / mutedAuthors — while this ranker historically
 * only read `interests` / `boostedTags`, so "Interested in #x" and "Not
 * interested in #x" were persisted and then ignored. Read every alias so one
 * tuned preference shape can't silently no-op.
 */
export function readFeedPrefs(raw: unknown): {
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
export function hasMutedTag(tags: unknown, muted: Set<string>): boolean {
  if (muted.size === 0 || !Array.isArray(tags)) return false;
  return tags.some((t) => muted.has(normalizeTag(String(t))));
}

/** Topics are compared case- and `#`-insensitively everywhere they are matched. */
export function normalizeTag(tag: unknown): string {
  return String(tag ?? "")
    .toLowerCase()
    .replace(/^#/, "")
    .trim();
}

export function encodeCursor(rank: number, id: string) {
  return Buffer.from(JSON.stringify({ rank, id })).toString("base64url");
}
export function decodeCursor(cursor?: string | null): { rank: number; id: string } | null {
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
 * pool walk) and the warm path (materialized timeline read) so pagination is
 * byte-identical whether the list was just computed or replayed from storage.
 * Personalised cursors carry `(score, id)`; the recency-led fallback carries
 * `(0, id)` and pages purely by id. This is what lets a scroll session paginate
 * against the SAME ranked list without re-walking the pool on every page.
 */
export function pageFromSnapshot(
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
 * Deterministic per-key jitter in [0,1). Used for discovery: mixing the
 * viewer id into the seed means two users with similar-but-different histories
 * get genuinely different tails of content, while the same (viewer, post,
 * epoch) triple always hashes identically — so a page never reshuffles itself
 * mid-scroll and the ranker stays reproducible (and debuggable) per epoch.
 */
export function jitter01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296;
}

/**
 * Candidate-pool ceiling. Kept at 2000 to preserve the feed-completeness
 * invariant: a post only leaves "For you" because it ranked below the page
 * window, never because a smaller `limit` cut it off. The pool is fetched SLIM
 * (scoring columns only) via the `for_you_candidates` RPC and cached once per
 * epoch for every viewer, so the ceiling no longer costs a full 2000-row
 * content-bearing transfer per viewer.
 */
export const POOL_MAX = 2000;
export const RANK_EPOCH_MS = 10 * 60_000;

interface SharedPoolCache {
  epochBucket: number;
  rows: any[];
}
let poolCache: SharedPoolCache | null = null;

/**
 * The viewer-INDEPENDENT candidate pool, cached process-locally for the current
 * ranking epoch. `for_you_candidates` returns recent UNION trending posts as
 * slim rows with the author/workspace plan pre-joined; because that set is
 * identical for every viewer it is fetched ONCE per epoch (on the long-lived
 * node server) instead of once per viewer per epoch. Callers must treat the
 * returned array as read-only (the ranker scores a filtered copy).
 */
export async function getSharedPool(supabase: any, epochBucket: number): Promise<any[]> {
  if (poolCache && poolCache.epochBucket === epochBucket) return poolCache.rows;
  const { data, error } = await supabase.rpc("for_you_candidates", { p_limit: POOL_MAX });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  // Only cache a non-empty result, so a transient empty (e.g. the migration not
  // applied yet, or a brand-new platform) retries rather than sticking for the epoch.
  if (rows.length > 0) poolCache = { epochBucket, rows };
  return rows;
}

/**
 * One round trip for the viewer's behaviour, follow graph, impressions and feed
 * tuning (see `for_you_signals`). Runs under the viewer's own token in the cold
 * path, or under the service role in the background worker; the function is
 * keyed by `p_viewer`, so it returns exactly that viewer's signals either way.
 */
export async function fetchViewerSignals(supabase: any, myId: string): Promise<any> {
  const { data, error } = await supabase.rpc("for_you_signals", { p_viewer: myId });
  if (error) throw error;
  return data ?? {};
}

/**
 * Fetch FULL rows for just the ranked page. Scoring ran on slim rows; only the
 * <=limit posts actually being shown need content/media/poll to render.
 * Preserves ranked order and falls back to the slim row if a full row is gone.
 */
export async function hydratePageRows(supabase: any, slimRows: any[]): Promise<any[]> {
  const ids = slimRows.map((r) => r?.id).filter(Boolean);
  if (ids.length === 0) return slimRows;
  const { data } = await supabase.from("posts").select("*").in("id", ids);
  const full = new Map<string, any>((data ?? []).map((row: any) => [row.id, row]));
  return slimRows.map((s) => full.get(s?.id) ?? s);
}

/** Slice a page from a ranked list and hydrate it to full rows for the client. */
export async function finalizePage(
  supabase: any,
  page: { posts: any[]; personalised: boolean; nextCursor: string | null },
) {
  page.posts = await hydratePageRows(supabase, page.posts);
  return page;
}

// Plan-based discovery boost: paid creators AND paid team workspaces reach
// further; free still reaches. The effective plan is pre-joined by
// for_you_candidates, so no per-viewer plan lookups are needed.
export const planFactor = (plan?: string | null) =>
  plan === "pro" ? 1.35 : plan === "plus" ? 1.18 : 1;

/**
 * The signal-independent portion of the score (decay + engagement velocity +
 * plan reach) — the same math the full ranker uses, minus the affinity /
 * relationship / discovery terms that need the viewer's signal fan-in. Used by
 * the serve path to fold a handful of brand-new followed posts (created since
 * the last materialization) into the head of a warm timeline without paying for
 * a re-rank.
 */
export function scoreFreshRow(row: any, epoch: number): number {
  const ageHours = Math.max(0.1, (epoch - new Date(row.created_at).getTime()) / 3_600_000);
  const decay = Math.exp(-ageHours / 36);
  const rawEngagement =
    (row.like_count ?? 0) * 1 + (row.comment_count ?? 0) * 2.2 + (row.repost_count ?? 0) * 3;
  const velocity = rawEngagement / ageHours;
  const views = Math.max(1, row.view_count ?? 1);
  const quality = Math.log1p(velocity * 10) * (0.5 + Math.min(1, rawEngagement / views));
  const effPlan = row.workspace_id ? (row.workspace_plan ?? row.author_plan) : row.author_plan;
  const reachBoost = planFactor(effPlan);
  return (quality * (0.35 + decay) + decay * 2) * reachBoost;
}

/**
 * Rank a candidate pool for one viewer. This is the whole cold path: two RPCs
 * (shared pool + viewer signals) then the affinity/relationship construction,
 * scoring, the seen-3 replay tail, and the diversity cap. It returns the final
 * ordered list; the caller stores it (worker) or pages straight from it
 * (server-fn cold miss). `opts.refresh` ranks against the live clock instead of
 * the frozen 10-minute epoch.
 */
export async function rankForYou(
  supabase: any,
  myId: string,
  opts: { refresh?: boolean; limit: number },
): Promise<{ entries: Array<{ row: any; score: number }>; personalised: boolean }> {
  const epochBucket = Math.floor(Date.now() / RANK_EPOCH_MS);
  const data = { refresh: opts.refresh === true, limit: opts.limit };

  // ---- retrieve: two round trips replace ~13 -------------------------------
  // `for_you_candidates` returns the viewer-INDEPENDENT pool (recent UNION
  // 48h-trending) as SLIM rows with the plan pre-joined, cached once per epoch
  // for everyone; `for_you_signals` fans the viewer's behaviour/graph/
  // impression/tuning into one jsonb. Both are SECURITY INVOKER and see exactly
  // what the old per-query reads saw under the same viewer id.
  const [pool, signals] = await Promise.all([
    getSharedPool(supabase, epochBucket),
    fetchViewerSignals(supabase, myId),
  ]);

  // ---- behaviour affinity (same values the six behaviour queries gave) -----
  const engagedWeight = new Map<string, number>();
  const addEngaged = (ids: unknown, w: number) => {
    for (const pid of (Array.isArray(ids) ? ids : []) as string[]) {
      if (pid) engagedWeight.set(pid, (engagedWeight.get(pid) ?? 0) + w);
    }
  };
  addEngaged(signals.likes, 3);
  addEngaged(signals.reposts, 4);
  addEngaged(signals.bookmarks, 4);
  addEngaged(signals.comments, 3);
  const engagedIds = [...engagedWeight.keys()].slice(0, 400);

  // Impression counts: 1 = seen once (mild demotion), 3+ = drop from feed.
  const impressionCount = new Map<string, number>();
  for (const pid of (Array.isArray(signals.impressions) ? signals.impressions : []) as string[]) {
    if (pid) impressionCount.set(pid, (impressionCount.get(pid) ?? 0) + 1);
  }

  const authorAffinity = new Map<string, number>();
  const tagAffinity = new Map<string, number>();

  // Preference-driven interests from explicit feed tuning (mute/boost tags & authors).
  const { preferredTags, mutedTags, mutedAuthors } = readFeedPrefs(signals.prefs);
  for (const tag of preferredTags) tagAffinity.set(tag, (tagAffinity.get(tag) ?? 0) + 5);
  for (const p of (Array.isArray(signals.engagedPosts) ? signals.engagedPosts : []) as any[]) {
    const w = engagedWeight.get(p.id) ?? 1;
    if (p.user_id) authorAffinity.set(p.user_id, (authorAffinity.get(p.user_id) ?? 0) + w);
    for (const tag of (p.tags ?? []) as string[]) {
      // Keyed the same way preferredTags is (normalised) so an affinity boost
      // survives a creator typing "#AI" where the viewer tuned "ai".
      const norm = normalizeTag(tag);
      if (!norm) continue;
      tagAffinity.set(norm, (tagAffinity.get(norm) ?? 0) + w);
    }
  }

  // ---- relationship (follow graph, resolved inside for_you_signals) --------
  const firstDegree = new Set<string>(
    ((Array.isArray(signals.following) ? signals.following : []) as string[]).filter(Boolean),
  );
  const secondDegree = new Set<string>(
    ((Array.isArray(signals.friendFollows) ? signals.friendFollows : []) as string[]).filter(
      (id) => id && id !== myId && !firstDegree.has(id),
    ),
  );

  // ---- candidate set (mutes still applied per-viewer; the pool is shared) --
  // Every visible post is feed material — including your own: the ranker never
  // hides a category by fiat, and the 2-per-10-window diversity cap below
  // already stops one account (including the viewer) from flooding a screenful.
  // Tags/authors the viewer muted through the post menu are dropped here.
  const rows = pool.filter(
    (r: any) => !mutedAuthors.has(r.user_id) && !hasMutedTag(r.tags, mutedTags),
  );

  const personalised =
    engagedIds.length > 0 || firstDegree.size > 0 || preferredTags.size > 0 || mutedTags.size > 0;
  if (!personalised) {
    // Brand-new viewer: still recency-led, but nudged ±6h by a per-user hash so
    // two fresh accounts don't stare at an identical feed, and everyone keeps
    // seeing mostly-new content. Deterministic within the 10-minute epoch, so
    // pagination is stable.
    const newBucket = Math.floor(Date.now() / (10 * 60_000));
    const adjusted = (r: any) =>
      new Date(r.created_at).getTime() +
      (jitter01(`${myId}:${r.id}:${newBucket}`) - 0.5) * 12 * 3_600_000;
    const sorted = rows.slice().sort((a: any, b: any) => adjusted(b) - adjusted(a));
    return { entries: sorted.map((row: any) => ({ row, score: 0 })), personalised: false };
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

    // Discovery nudge: content completely outside this viewer's known world
    // (unfollowed, never-engaged author AND no affinity tags) gets a small
    // per-(viewer, post, epoch) bonus — up to +1.4, bounded so it can never
    // out-rank genuinely relevant posts. Because the seed carries the viewer id,
    // different users explore different corners of the same pool instead of
    // everyone converging on one global ranking; because it is multiplied
    // through the decay term, only fresh unknowns get the lift.
    const tagsArr = (row.tags ?? []) as string[];
    const outsideKnownWorld =
      !firstDegree.has(row.user_id) &&
      !secondDegree.has(row.user_id) &&
      !authorAffinity.has(row.user_id) &&
      !tagsArr.some((tag) => tagAffinity.has(normalizeTag(tag)));
    const discovery = outsideKnownWorld ? jitter01(`${myId}:${row.id}:${epoch}`) * 1.4 : 0;

    const base = authorScore + tagScore + relationship + quality + discovery;
    // Reach boost from the plan pre-joined by for_you_candidates: a workspace
    // post inherits its workspace (or the owner's) plan, falling back to the
    // author's personal plan; a personal post uses the author's plan.
    const effPlan = row.workspace_id ? (row.workspace_plan ?? row.author_plan) : row.author_plan;
    const reachBoost = planFactor(effPlan);
    const score = (base * (0.35 + decay) + decay * 2) * reachBoost + seenPenalty;

    return { row, score };
  });

  // Stable tie-break by id keeps ordering deterministic within an epoch.
  scored.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1));

  // Seen-3+-times-without-engaging posts sink to the back of the queue instead
  // of leaving it: while unseen content can still fill a page the replayed ones
  // stay hidden (a session doesn't loop), but once the fresh supply runs out
  // they become candidates again — every available post stays reachable.
  const unseen = scored.filter(
    (s) => (impressionCount.get(s.row.id) ?? 0) < 3 || engagedWeight.has(s.row.id),
  );
  const replayed = scored.filter(
    (s) => (impressionCount.get(s.row.id) ?? 0) >= 3 && !engagedWeight.has(s.row.id),
  );
  const queue = unseen.length >= data.limit ? unseen : [...unseen, ...replayed];

  // Diversity cap: at most 2 posts per author inside any 10-post sliding
  // window (a very prolific author still reaches deeper pages — unlike a hard
  // global cap — but no one floods a screenful). A post that fails the window on
  // this pass is DEFERRED to the next one, never dropped: a single-pass
  // `continue` used to permanently hide an author's third-plus posts whenever
  // the window kept refilling with other people's content, so the feed quietly
  // swallowed part of the pool. Each pass re-evaluates against the (now longer)
  // ranked tail, and the leftovers are appended in score order once no
  // placement can honour the window.
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
      // Place only the BEST deferred item, then re-evaluate the rest against
      // the advanced tail — full coverage without ever flooding.
      placed.push(pending[0]);
      pending = pending.slice(1);
    } else {
      pending = deferred;
    }
    ranked.push(...placed);
  }

  return { entries: ranked, personalised: true };
}
