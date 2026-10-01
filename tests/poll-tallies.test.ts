// @vitest-environment node
/**
 * A poll result is a count, not a list of voters.
 *
 * `hydratePolls` used to download every row of `poll_votes` for the posts on a
 * page and count them in the browser, because `poll votes public read ... using
 * (true)` made each ballot world-readable: post id, option id and *voter profile
 * id*. That leaked who answered what on every "which should we pick?" poll, and
 * cost one row per vote per viewer per page. Migration 20260925000010 flagged the
 * policy as still open and deferred it until an aggregate path existed; this is
 * the pair of tests that keeps the two halves together.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(
  new URL("../db/migrations/20261001000096_poll_tallies_rpc.sql", import.meta.url),
  "utf8",
);
const CLIENT = readFileSync("src/lib/api-client.ts", "utf8");
const CARD = readFileSync("src/components/social/PostCard.tsx", "utf8");

const between = (source: string, from: string, to: string) =>
  source.slice(source.indexOf(from), source.indexOf(to));

describe("poll_tallies()", () => {
  it("is defined, security-definer, with a pinned search path", () => {
    expect(MIGRATION).toContain("create or replace function public.poll_tallies(_post_ids uuid[])");
    expect(MIGRATION).toContain("security definer");
    expect(MIGRATION).toContain("set search_path = public, pg_temp");
  });

  it("returns counts and the viewer's own choice — and never a voter id", () => {
    const signature = between(MIGRATION, "returns table (", "language plpgsql");
    expect(signature).toContain("votes bigint");
    expect(signature).toContain("voted_by_me boolean");
    expect(signature).not.toMatch(/\buser_id\b/);
    // The one place user_id appears in the body is the boolean test for *me*.
    expect(MIGRATION).toContain("bool_or(v.user_id = viewer)");
  });

  it("derives the viewer from the session instead of trusting an argument", () => {
    expect(MIGRATION).toContain("viewer := public.current_profile_id();");
    // No `_viewer` parameter a caller could point at somebody else's ballot.
    expect(MIGRATION).not.toContain("_viewer");
  });

  it("bounds the batch so one page cannot aggregate the whole table", () => {
    expect(MIGRATION).toMatch(/array_length\(_post_ids, 1\), 0\) > 200/);
    expect(MIGRATION).toMatch(/raise exception/);
  });

  it("is callable by readers who never sign in, since posts are public", () => {
    expect(MIGRATION).toContain("revoke all on function public.poll_tallies(uuid[]) from public;");
    expect(MIGRATION).toContain(
      "grant execute on function public.poll_tallies(uuid[]) to anon, authenticated, service_role;",
    );
  });

  it("withdraws the world-readable ballot policy and replaces it with an owner read", () => {
    expect(MIGRATION).toContain(
      'drop policy if exists "poll votes public read" on public.poll_votes;',
    );
    expect(MIGRATION).toContain('create policy "poll votes owner read" on public.poll_votes');
    expect(MIGRATION).toContain(
      "for select to authenticated using (public.owns_profile(user_id));",
    );
  });
});

describe("the client asks for tallies, never ballots", () => {
  it("hydratePolls reads counts through the RPC", () => {
    const hydrate = between(CLIENT, "async function hydratePolls", "/** Stamp each post");
    expect(hydrate).toContain('db.rpc("poll_tallies"');
    expect(hydrate).not.toContain('.from("poll_votes")');
    // Percentages and totals are summed from the aggregate, not row counts.
    expect(hydrate).toContain("poll.totalVotes = tallies.reduce");
  });

  it("a failed tally read is marked, not silently zeroed", () => {
    const hydrate = between(CLIENT, "async function hydratePolls", "/** Stamp each post");
    expect(hydrate).toContain("poll.resultsUnavailable = false;");
    expect(hydrate).toMatch(/if \(error\) \{[\s\S]*resultsUnavailable = true;[\s\S]*return;/);
    const vote = between(
      CLIENT,
      "export async function votePoll",
      "export async function recordPostImpression",
    );
    expect(vote).toContain("poll.resultsUnavailable = true;");
  });

  it("the card refuses to display counts it does not have", () => {
    expect(CARD).toContain("const resultsUnknown = poll?.resultsUnavailable === true;");
    expect(CARD).toContain("Vote counts aren't loading right now.");
    // Both the bar and the per-option percentage wait for real numbers.
    expect(CARD).toContain("const showResults = Boolean(hasVotedInPoll) && !resultsUnknown;");
    expect(CARD).toContain("{showResults && (");
  });

  it("only the viewer's own ballot stays readable", () => {
    const vote = between(
      CLIENT,
      "export async function votePoll",
      "export async function recordPostImpression",
    );
    // Whitespace-insensitive: this file is prettier-formatted, and the call
    // wraps onto a second line at 100 columns.
    expect(vote.replace(/\s+/g, " ")).toContain('db.rpc("poll_tallies", { _post_ids: [postId]');
    // The one table read left is the pre-check on the viewer's own row.
    const prior = between(vote, '.from("poll_votes")', ".maybeSingle()");
    expect(prior).toContain('.eq("user_id", userId)');
    expect(vote).not.toMatch(/\.from\("poll_votes"\)\s*\n\s*\.select\("option_id, user_id"\)/);
  });

  it("a rejected vote does not keep its optimistic count", () => {
    const handler = between(CARD, "async function handleVote", "const mediaSrc");
    expect(handler).toContain("const before = poll;");
    expect(handler).toMatch(/catch \{[\s\S]*setPoll\(before\);[\s\S]*\}/);
  });
});
