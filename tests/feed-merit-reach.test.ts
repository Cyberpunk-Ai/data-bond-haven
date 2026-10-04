// @vitest-environment node
/**
 * Merit reach: paid plans AND organic value both lift a post.
 *
 * The plan boost (Pro/Plus/paid workspaces) already existed, but it was the ONLY
 * reach lever — a free account making genuinely valuable content (lots of views,
 * a real following) had no way to get lifted. The user's rule: "an account can be
 * boosted no matter free or paid, because it means that content has value."
 *
 * The shape we locked in:
 *   1. for_you_candidates pre-joins the author's follower count so the ranker can
 *      score on it without an extra per-viewer read;
 *   2. reachFactor(row) = planFactor(effective plan) × meritFactor(row) — the two
 *      compose, so a Pro post with value gets both and a free post with value
 *      still gets a real lift. meritFactor is log-scaled and HARD-CAPPED at +0.3
 *      so a huge account can never swallow the feed on audience alone;
 *   3. every personalised surface routes through reachFactor (rankForYou scoring +
 *      the pull-merged scoreFreshRow), not the bare plan factor;
 *   4. the recency-led surfaces (the `!personalised` branch AND the cold seed that
 *      new/guest viewers live on) get a GENTLE, near-chronological lift — merit is
 *      worth a bounded number of milliseconds on the recency timestamp, never a
 *      full re-rank;
 *   5. the LATEST tab stays strictly chronological by design (the user chose the
 *      gentle-lift path) — merit belongs to For-you surfaces only.
 *
 * House source-contract style (assert short, wrap-proof substrings).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

describe("the candidate pool ships the author's audience", () => {
  const mig = read("db", "migrations", "20261005000001_for_you_candidates_followers.sql");

  it("re-defines for_you_candidates with ap.followers as author_followers", () => {
    expect(mig).toMatch(/create or replace function public\.for_you_candidates\(p_limit integer\)/);
    expect(mig).toMatch(/ap\.followers as author_followers/);
    // The `ap` profiles join already existed, so no new scan is introduced.
    expect(mig).toMatch(/left join public\.profiles ap on ap\.id = p\.user_id/);
    // ...and every prior projection is preserved (byte-for-byte re-definition).
    expect(mig).toMatch(/coalesce\(nullif\(w\.plan, 'free'\), op\.plan\) as workspace_plan/);
  });
});

describe("reach composes the plan boost WITH an organic-merit boost", () => {
  const core = read("src", "lib", "feed-rank-core.ts");

  it("keeps the paid-plan multiplier intact", () => {
    expect(core).toMatch(/plan === "pro" \? 1\.55 : plan === "plus" \? 1\.3 : 1/);
  });

  it("meritFactor reads impressions + followers, log-scaled and capped at +0.3", () => {
    expect(core).toMatch(/export const meritFactor = /);
    expect(core).toMatch(/Math\.log1p\(views\) \* 0\.02 \+ Math\.log1p\(followers\) \* 0\.03/);
    // Hard ceiling so audience alone can never dominate the feed.
    expect(core).toMatch(/1 \+ Math\.min\(0\.3, lift\)/);
    // A missing signal (pre-migration / absent author_followers) is 0 → a neutral
    // 1.0, so nothing breaks before the migration lands.
    expect(core).toMatch(/row\?\.author_followers \?\? 0/);
  });

  it("reachFactor multiplies the plan factor by the merit factor", () => {
    expect(core).toMatch(
      /export const reachFactor = \(row: any\): number => planFactor\(effectivePlan\(row\)\) \* meritFactor\(row\)/,
    );
  });

  it("personalised scoring routes through reachFactor, not the bare plan factor", () => {
    expect(core).toContain("const reachBoost = reachFactor(row);");
    // The old effPlan/planFactor-only line is gone everywhere in the scoring path.
    expect(core).not.toMatch(/const reachBoost = planFactor\(effPlan\);/);
  });

  it("pull-merged fresh posts get the same composed reach", () => {
    // scoreFreshRow (used by mergeFreshFollowedPosts) no longer scores blind to merit.
    const fresh = core.slice(
      core.indexOf("export function scoreFreshRow"),
      core.indexOf("}", core.indexOf("scoreFreshRow")),
    );
    expect(fresh).toContain("const reachBoost = reachFactor(row);");
  });
});

describe("recency-led surfaces get a gentle, near-chronological lift", () => {
  const core = read("src", "lib", "feed-rank-core.ts");
  const reader = read("src", "lib", "recommendations.functions.ts");

  it("the brand-new-viewer branch nudges recency by merit (bounded ms), never a re-rank", () => {
    expect(core).toMatch(/export const MERIT_LIFT_MS = /);
    expect(core).toContain("(meritFactor(r) - 1) * MERIT_LIFT_MS");
    // It still returns score-0 entries (personalised=false), so the shape and the
    // id-paging are untouched — only the ORDER gains a small merit tilt.
    expect(core).toMatch(
      /entries: applyDiversityCap\(sorted\.map\(\(row: any\) => \(\{ row, score: 0 \}\)\)\)/,
    );
  });

  it("the cold seed (new/guest persistent feed) lifts on impressions + followers too", () => {
    // Pull view_count with the seed and fetch the small author set's follower
    // counts, then sort by recency nudged by meritFactor — the same gentle lift.
    expect(reader).toMatch(/\.select\("id,user_id,created_at,tags,view_count"\)/);
    expect(reader).toMatch(/\.select\("id,followers"\)/);
    expect(reader).toContain(
      "(meritFactor({ ...row, author_followers: followerMap.get(row.user_id) }) - 1) *",
    );
    expect(reader).toContain("lifted.sort((a, b) => b.at - a.at);");
    // Still score-0 (personalised=false): the request never ranks and never touches
    // the retrieval RPCs — the pool transfer stays off the request path.
    expect(reader).toMatch(/\{ row, score: 0 \}/);
    expect(reader).not.toMatch(/rpc\("for_you_candidates"/);
    expect(reader).not.toMatch(/rankForYou\(/);
  });
});

describe("the Latest tab stays strictly chronological (no merit re-order)", () => {
  const client = read("src", "lib", "api-client.ts");

  it("only the foryou branch re-orders; latest/following page by created_at", () => {
    // The engagement sort is gated to the client-side foryou fallback (the
    // `... !options.tag) {` gate, not the server-fn one). "latest" never takes it,
    // honouring the user's "stay near-chronological" pick.
    const gate = client.indexOf(
      'options.filter === "foryou" && !options.userId && !options.tag) {',
    );
    expect(gate).toBeGreaterThan(-1);
    const sortAt = client.indexOf("posts = [...posts].sort((a, b) => score(b) - score(a));");
    expect(sortAt).toBeGreaterThan(gate);
    expect(sortAt - gate).toBeLessThan(160);
  });
});
