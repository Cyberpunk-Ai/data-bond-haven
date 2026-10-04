// @vitest-environment node
/**
 * "For you" must be personalised WITHOUT being frozen, and must never let one
 * author flood a screenful.
 *
 * The redesign made the feed epoch-stable (one ranked snapshot per viewer per
 * 10 minutes) so a scroll and a reload never reshuffle under the reader. The
 * cost of that stability was a feed that felt static: pressing Refresh handed
 * back the identical stored order (the serve path only kicked a background
 * rebuild, and the rebuild re-ran the SAME frozen-epoch formulas), and the
 * diversity cap lived only inside the worker's `rankForYou` — so the cold
 * recency seed and any serve-time reorder were never capped.
 *
 * These tests pin the fix, in the house source-contract style:
 *   1. the diversity cap is an exported, reusable step (window math preserved);
 *   2. a refresh rotation re-orders the stored list around a per-(viewer,post,
 *      rotation) hash WITHOUT touching scores, then re-caps;
 *   3. the rotation seed rides inside the (score,id) cursor, so every page of a
 *      scroll reproduces the same arrangement (no mid-scroll reshuffle) while a
 *      refresh's random seed yields a genuinely different head;
 *   4. the serve path picks the seed (random on refresh / epoch otherwise / from
 *      the cursor when paging) and never re-ranks in the request;
 *   5. polls show percentages that sum to 100, a front-runner highlight, and a
 *      closed poll that reads as closed and can't be voted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const between = (src: string, from: string, to: string) =>
  src.slice(src.indexOf(from), src.indexOf(to));

describe("diversity cap is a reusable, exported step", () => {
  const core = read("src", "lib", "feed-rank-core.ts");

  it("is exported so the serve path can re-honour it, not just the ranker", () => {
    expect(core).toMatch(/export function applyDiversityCap\(/);
    // The window math is preserved verbatim: at most 2 per author in a 10-slot
    // sliding window, deferred (never dropped), with a stall-break that places
    // the single best leftover when the window is genuinely saturated.
    expect(between(core, "export function applyDiversityCap(", "return ranked;")).toContain(
      "for (let i = Math.max(0, total - 9); i < total; i++)",
    );
    expect(core).toContain("(inWindow >= 2 ? deferred : placed).push(item)");
    expect(core).toContain("while (pending.length)");
    expect(core).toContain("placed.push(pending[0]);");
  });

  it("rankForYou delegates to it for the personalised tail AND the recency tail", () => {
    expect(core).toContain("const ranked = applyDiversityCap(queue);");
    // A brand-new viewer (the `!personalised` branch) is capped too, so no one
    // stares at a single author's backlog on their very first page.
    expect(core).toContain("entries: applyDiversityCap(sorted.map(");
  });
});

describe("a refresh rotation re-weaves the feed without breaking pagination", () => {
  const core = read("src", "lib", "feed-rank-core.ts");

  it("re-sorts around a per-(viewer,post,rotation) hash with a bounded spread", () => {
    const rotate = between(
      core,
      "export function rotateRankedEntries(",
      "return applyDiversityCap",
    );
    expect(rotate).toContain("jitter01(`${viewer}:${e.row.id}:${rotation}`)");
    // The offset is measured in RANKS (list positions), not raw scores, so a
    // top-relevant post can never be flung to the bottom by a refresh.
    expect(rotate).toContain("ROTATE_SPREAD");
    expect(core).toContain("export const ROTATE_SPREAD = ");
    // ...and it re-caps the rotated order, because the shuffle can pull two
    // same-author posts adjacent.
    expect(core).toContain("return applyDiversityCap(keyed.map((k) => k.e));");
  });

  it("keeps each entry's score so the (score, id) cursor still resolves", () => {
    // It only reorders `entries`; the { row, score } pairs are carried through
    // unchanged (the body maps to `{ e, key }` and returns the originals, and it
    // introduces no new `score:` field anywhere in the reorder).
    const body = between(
      core,
      "if (entries.length === 0) return entries;",
      "return applyDiversityCap",
    );
    expect(body).not.toMatch(/score:/);
    expect(body).toContain("keyed.sort((a, b) => a.key - b.key");
  });

  it("carries the rotation seed inside the cursor (backward compatible)", () => {
    const enc = between(core, "export function encodeCursor(", "}\nexport function decodeCursor");
    expect(enc).toContain("{ rank, id, rot }");
    expect(enc).toContain("rot === undefined ? { rank, id }");
    const dec = between(core, "export function decodeCursor(", "/* ignore malformed cursor */");
    expect(dec).toContain('typeof obj.rot === "number" ? obj.rot : undefined');
    // pageFromSnapshot echoes the seed forward only for personalised sessions.
    const page = between(core, "export function pageFromSnapshot(", "return {\n    posts:");
    expect(page).toContain("const nextRot = decoded?.rot ?? rot;");
  });
});

describe("the serve path mints the seed; it never re-ranks in the request", () => {
  const reader = read("src", "lib", "recommendations.functions.ts");

  it("chooses: cursor seed when paging, random on refresh, epoch otherwise", () => {
    expect(reader).toMatch(
      /rotation = decoded\?\.rot \?\? \(data\.refresh \? randomRotation\(\) : epochBucket\)/,
    );
    expect(reader).toMatch(/function randomRotation\(\) \{/);
  });

  it("rotates a personalised timeline but only caps a cold recency seed", () => {
    expect(reader).toContain("entries = rotateRankedEntries(entries, myId, rotation);");
    expect(reader).toContain("entries = applyDiversityCap(entries);");
    // Paging the scroll reproduces the SAME arrangement (seed from the cursor)
    // and stamps it into the returned page's cursor.
    expect(reader).toMatch(
      /pageFromSnapshot\(entries, personalised, data\.cursor, data\.limit, rotation\)/,
    );
  });

  it("still never runs the ranker or the retrieval RPCs on the request path", () => {
    expect(reader).not.toMatch(/rankForYou\(/);
    expect(reader).not.toMatch(/rpc\("for_you_candidates"/);
    expect(reader).not.toMatch(/rpc\("for_you_signals"/);
  });
});

describe("poll polish (PostCard)", () => {
  const card = read("src", "components", "social", "PostCard.tsx");

  it("rounds percentages with the largest-remainder method (bars sum to 100)", () => {
    expect(card).toMatch(/function pollPercents\(/);
    expect(card).toContain("100 - out.reduce((s, x) => s + x, 0)");
    // The bar width now uses the reconciled integer, not an independent round.
    expect(card).toContain("const percents = pollPercents(");
    expect(card).not.toMatch(/Math\.round\(\(opt\.votes \/ poll\.totalVotes\) \* 100\)/);
  });

  it("highlights the front-runner and reads a closed poll as closed", () => {
    expect(card).toContain(
      "const isLeader = showResults && total > 0 && opt.votes === leaderVotes;",
    );
    // A closed poll shows results, is disabled, and can't be voted.
    expect(card).toContain("const voted = hasVotedInPoll || poll.closed === true;");
    expect(card).toContain("disabled={voted}");
    expect(card).toContain("if (!poll || hasVotedInPoll || poll.closed) return;");
    expect(card).toContain('? "Final results"');
  });
});
