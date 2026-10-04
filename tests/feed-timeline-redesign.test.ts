// @vitest-environment node
/**
 * "For you" redesign: rank ahead of the request, serve a read.
 *
 * The feed used to compute a viewer's whole ranked pool INSIDE the request (and
 * inside the shared node event loop), which is what produced the reported
 * "ranker over budget (9000ms)" and the slow initial domain load. These tests
 * pin the new shape so it can't silently regress back to inline ranking:
 *
 *   1. the migration gives the design its storage (materialized timeline + a
 *      coalescing re-rank queue + a write fan-out with a big-account cutoff);
 *   2. the serve path is a READ of the timeline (it no longer touches the
 *      ranking RPCs itself);
 *   3. a background worker owns the ranking, capped and event-loop-friendly;
 *   4. the first paint skips the landing→hydrate→navigate hop for the signed-in.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

describe("feed timelines migration storage", () => {
  const mig = read("db", "migrations", "20261002000096_feed_timelines.sql");

  it("wraps the whole change in a transaction and ships a rollback", () => {
    expect(mig).toMatch(/^begin;/m);
    expect(mig).toMatch(/^commit;/m);
    expect(mig).toMatch(/--\s*Rollback/);
    expect(mig).toMatch(/drop trigger if exists posts_fanout_feed_rank/);
  });

  it("materializes a per-viewer timeline keyed to the (score, id) cursor", () => {
    expect(mig).toMatch(/create table if not exists public\.timeline_items/);
    expect(mig).toMatch(/primary key \(viewer_id, kind, post_id\)/);
    // Ranked paging index leads with the viewer, then score desc, then id.
    expect(mig).toMatch(/on public\.timeline_items \(viewer_id, kind, score desc, post_id\)/);
  });

  it("gives a viewer access to ONLY their own rows via the schema's owns_profile", () => {
    expect(mig).toMatch(/alter table public\.timeline_items enable row level security/);
    expect(mig).toMatch(/alter table public\.feed_rank_jobs enable row level security/);
    // viewer_id is a PROFILE id, so RLS matches every other profile-keyed table.
    expect(mig).toMatch(
      /create policy "timeline owner read" on public\.timeline_items[\s\S]*?using \(public\.owns_profile\(viewer_id\)\)/,
    );
    expect(mig).toMatch(
      /public\.feed_rank_jobs for insert to authenticated[\s\S]*?with check \(public\.owns_profile\(viewer_id\)\)/,
    );
    // The worker runs as service_role (bypasses RLS), never as the viewer.
    expect(mig).toMatch(/grant all on public\.timeline_items to service_role/);
  });

  it("fans out on write but stops pushing for big accounts (Twitter threshold)", () => {
    expect(mig).toMatch(/create or replace function public\.fanout_feed_rank_jobs\(\)/);
    expect(mig).toMatch(/language plpgsql/);
    expect(mig).toMatch(/security definer/);
    expect(mig).toMatch(/set search_path = public/);
    expect(mig).toMatch(/create trigger posts_fanout_feed_rank/);
    expect(mig).toMatch(/after insert on public\.posts/);
    // Push/pull cutoff: skip the per-follower fan-out at >= 10000 followers,
    // detected with a bounded existence probe (offset 9999) not a full count.
    expect(mig).toMatch(/limit 1 offset 9999/);
    expect(mig).toMatch(/if over_threshold then[\s\S]*?return new;/);
    // A re-rank is coalesced to one row per viewer.
    expect(mig).toMatch(/on conflict \(viewer_id\) do update/);
  });

  it("lets the service role run the retrieval RPCs the worker depends on", () => {
    expect(mig).toMatch(
      /grant execute on function public\.for_you_candidates\(integer\) to service_role/,
    );
    expect(mig).toMatch(
      /grant execute on function public\.for_you_signals\(uuid\) to service_role/,
    );
  });
});

describe("the serve path is a read, not a re-rank", () => {
  const reader = read("src", "lib", "recommendations.functions.ts");

  it("reads timeline_items and never calls the ranking RPCs itself", () => {
    expect(reader).toMatch(/from\("timeline_items"\)/);
    expect(reader).not.toMatch(/rpc\("for_you_candidates"/);
    expect(reader).not.toMatch(/rpc\("for_you_signals"/);
  });

  it("never ranks on the request path: a cold miss seeds recency + queues work", () => {
    // The request no longer runs the ranker at all — that pool transfer/rescore
    // is what slowed the first paint. A cold miss serves a cheap recency page and
    // queues a due-now job; ranking + timeline writes live ONLY in the worker.
    expect(reader).not.toMatch(/rankForYou\(/);
    expect(reader).toMatch(/serveRecencySeed\(supabase, myId\)/);
    expect(reader).not.toMatch(/from\("timeline_items"\)\.insert\(/);
    expect(reader).toMatch(/enqueueRankJob\(supabase, myId, true\)/);
  });

  it("keeps the client's (score, id) pagination + page hydration intact", () => {
    // The trailing `rotation` arg is the refresh seed echoed into the cursor so a
    // paged scroll reproduces the same arrangement; the 4 positional args are the
    // established contract.
    expect(reader).toMatch(
      /pageFromSnapshot\(entries, personalised, data\.cursor, data\.limit, rotation\)/,
    );
    expect(reader).toMatch(/return finalizePage\(supabase, page\);/);
  });

  it("pull-merges brand-new followed posts so writes are not stuck behind a tick", () => {
    expect(reader).toMatch(/mergeFreshFollowedPosts\(supabase, myId, entries\)/);
    // Enqueues next-epoch work so active viewers stay fresh without per-request ranking.
    expect(reader).toMatch(/enqueueRankJob\(supabase, myId\)/);
  });
});

describe("the background worker owns the ranking", () => {
  const worker = read("src", "lib", "feed-worker.server.ts");

  it("is a server-only module that runs the pipeline and writes the timeline", () => {
    // The .server suffix is enforced by vite's import protection; it holds the
    // service-role client and must never reach the browser bundle. Access is
    // centralized behind the reviewed adminDb() escape.
    expect(worker).toMatch(/import \{ adminDb \} from "@\/integrations\/supabase\/client\.server"/);
    expect(worker).toMatch(/rankForYou\(supabase, viewerId, \{/);
    expect(worker).toMatch(/from\("timeline_items"\)\.insert\(/);
    expect(worker).toMatch(/from\("feed_rank_jobs"\)[\s\S]*?\.lte\("due_at"/);
  });

  it("bounds per-tick work and yields so HTML serving never starves", () => {
    expect(worker).toMatch(/const VIEWERS_PER_TICK = \d+/);
    expect(worker).toMatch(/if \(ticking\) return;/);
    expect(worker).toMatch(/setImmediate\(resolve\)/);
    // A single timer that cannot keep the process alive on its own.
    expect(worker).toMatch(/setInterval\(/);
    expect(worker).toMatch(/\.unref\?\.\(\)/);
  });
});

describe("initial load is de-risked for returning users", () => {
  const server = read("src", "server.ts");

  it("starts the feed worker exactly once from the server entry", () => {
    expect(server).toMatch(/import \{ startFeedWorker \} from "\.\/lib\/feed-worker\.server"/);
    expect(server).toMatch(/^startFeedWorker\(\);/m);
  });

  it("skips the landing→hydrate→navigate hop for a cookie-hinted signed-in GET /", () => {
    expect(server).toMatch(/function hasAuthCookie\(request: Request\)/);
    expect(server).toMatch(/name\.startsWith\("sb-"\) && name\.includes\("auth-token"\)/);
    expect(server).toMatch(/url\.pathname === "\/" && hasAuthCookie\(request\)/);
    expect(server).toMatch(/status: 302, headers: \{ location: "\/feed" \}/);
  });
});

describe("the request path has no artificial budget blocker", () => {
  const client = read("src", "lib", "api-client.ts");

  it("drops the 9s ranker budget now that serving is a bounded read", () => {
    // Ranking never happens inside getPostsPage anymore, so there is nothing to
    // time-box: withBudget + RANKER_BUDGET_MS are gone, and the feed call is a
    // plain await that can only fail into the recency fallback.
    expect(client).not.toMatch(/RANKER_BUDGET_MS/);
    expect(client).not.toMatch(/withBudget\(/);
    expect(client).toMatch(/await getForYouPosts\(\{/);
  });
});

describe("feed quality & paid reach are preserved on the serve path", () => {
  const core = read("src", "lib", "feed-rank-core.ts");
  const reader = read("src", "lib", "recommendations.functions.ts");

  it("never serves a stale/deleted post as an empty (media-less) card", () => {
    // Hydration drops rows that no longer hydrate to a visible post instead of
    // falling back to the slim stub (no content/media -> a broken image/video).
    expect(core).toMatch(/\.filter\(\(row\): row is any => Boolean\(row\)\)/);
    expect(core).not.toMatch(/full\.get\(s\?\.id\) \?\? s/);
  });

  it("boosts Pro/Plus and workspaces so paid content gets the most reach", () => {
    expect(core).toMatch(/plan === "pro" \? 1\.55 : plan === "plus" \? 1\.3 : 1/);
    // Pull-merged fresh posts inherit the same plan boost (not scored blind).
    expect(reader).toMatch(/author_plan: authorPlan\.get/);
    expect(reader).toMatch(/workspace_plan: p\.workspace_id/);
  });
});
