import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Hybrid "For you" ranking: behaviour (tags + authors you engage with),
 * graph (people you follow and who they follow), quality/recency with time
 * decay, a plan-based discovery boost, and a per-author diversity cap.
 * Falls back to plain recency for accounts with no history.
 */
export const getForYouPosts = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => {
    const d = (data ?? {}) as { limit?: number };
    const limit = Number(d.limit);
    return { limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 30 };
  })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as any;

    const { data: me } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!me) return { posts: [] as any[], personalised: false };
    const myId = me.id as string;

    // ---- behaviour signals -------------------------------------------------
    const [likes, reposts, bookmarks, comments, impressions] = await Promise.all([
      supabase.from("likes").select("post_id").eq("user_id", myId).limit(200),
      supabase.from("reposts").select("post_id").eq("user_id", myId).limit(200),
      supabase.from("bookmarks").select("post_id").eq("user_id", myId).limit(200),
      supabase.from("comments").select("post_id").eq("user_id", myId).limit(200),
      supabase.from("post_impressions").select("post_id").eq("user_id", myId).limit(400),
    ]);

    const weighted: Array<[any[], number]> = [
      [likes.data ?? [], 3],
      [reposts.data ?? [], 4],
      [bookmarks.data ?? [], 4],
      [comments.data ?? [], 3],
      [impressions.data ?? [], 1],
    ];
    const engagedWeight = new Map<string, number>();
    for (const [rows, w] of weighted) {
      for (const r of rows) {
        if (!r?.post_id) continue;
        engagedWeight.set(r.post_id, (engagedWeight.get(r.post_id) ?? 0) + w);
      }
    }
    const engagedIds = [...engagedWeight.keys()].slice(0, 400);

    const authorAffinity = new Map<string, number>();
    const tagAffinity = new Map<string, number>();
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

    // ---- graph signals -----------------------------------------------------
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

    // ---- candidates --------------------------------------------------------
    const { data: candidates } = await supabase
      .from("posts")
      .select("*")
      .eq("hidden", false)
      .order("created_at", { ascending: false })
      .limit(300);

    const rows = candidates ?? [];
    const personalised = engagedIds.length > 0 || firstDegree.size > 0 ? true : false;
    if (!personalised) {
      return { posts: rows.slice(0, data.limit), personalised: false };
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

    const now = Date.now();
    const seen = new Set(engagedIds);
    const scored: Array<{ row: any; score: number }> = rows.map((row: any) => {
      const ageHours = Math.max(0, (now - new Date(row.created_at).getTime()) / 3_600_000);
      const decay = Math.exp(-ageHours / 36); // ~1.5 day half-life-ish

      const engagement =
        (row.like_count ?? 0) * 1 + (row.comment_count ?? 0) * 2 + (row.repost_count ?? 0) * 3;
      const views = Math.max(1, row.view_count ?? 1);
      const quality = Math.log1p(engagement) * (0.5 + Math.min(1, engagement / views));

      const authorScore = Math.log1p(authorAffinity.get(row.user_id) ?? 0) * 2.2;
      const tagScore =
        ((row.tags ?? []) as string[]).reduce(
          (sum, tag) => sum + Math.log1p(tagAffinity.get(tag) ?? 0),
          0,
        ) * 1.6;

      const graphScore = firstDegree.has(row.user_id) ? 3 : secondDegree.has(row.user_id) ? 1.4 : 0;

      const ownPenalty = row.user_id === myId ? -1.5 : 0;
      const seenPenalty = seen.has(row.id) ? -2.5 : 0;

      const base = authorScore + tagScore + graphScore + quality;
      const score =
        (base * (0.35 + decay) + decay * 2) * (planBoost.get(row.user_id) ?? 1) +
        ownPenalty +
        seenPenalty;

      return { row, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Diversity cap: at most 2 posts per author in the returned page.
    const perAuthor = new Map<string, number>();
    const picked: any[] = [];
    for (const { row } of scored) {
      const used = perAuthor.get(row.user_id) ?? 0;
      if (used >= 2) continue;
      perAuthor.set(row.user_id, used + 1);
      picked.push(row);
      if (picked.length >= data.limit) break;
    }

    return { posts: picked, personalised: true };
  });
