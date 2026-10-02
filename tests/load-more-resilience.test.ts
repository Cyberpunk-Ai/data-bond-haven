// @vitest-environment node
/**
 * "It gets stuck loading more posts" was three bugs wearing one coat:
 *
 *  1. a page fetch with no ceiling — a hung request keeps the spinner up
 *     forever because the await never settles;
 *  2. a catch that *retired* the pagination state (`setHasMore(false)`,
 *     `setTabCursor(null)`) — one blip silently ended the whole list with no
 *     error shown and no way to retry;
 *  3. an IntersectionObserver reading stale `loadingMore` state — two
 *     overlapping fetches for the same cursor.
 *
 * The timeout is tested for real behaviour; the retirement fixes are pinned as
 * source contracts because observing them needs a live browser scroll.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { withTimeout, PAGE_REQUEST_TIMEOUT_MS } from "@/lib/utils";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** Text between two markers, so an assertion can be about one function only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe("withTimeout", () => {
  it("passes a fast promise through untouched", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
  });

  it("rejects a promise that never settles", async () => {
    const hung = new Promise(() => {});
    await expect(withTimeout(hung, 5)).rejects.toThrow(/timed out/);
  });

  it("forwards a real rejection without waiting for the clock", async () => {
    const boom = Promise.reject(new Error("network"));
    await expect(withTimeout(boom, 60_000)).rejects.toThrow("network");
  });

  it("has a bounded ceiling every list shares", () => {
    expect(PAGE_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PAGE_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("the feed cannot hang or silently stop", () => {
  const feed = read("../src/routes/feed.tsx");

  it("caps both feed fetches with the shared timeout", () => {
    const loadMore = between(feed, "async function loadMorePosts()", "async function fetchStories");
    expect(loadMore).toContain("withTimeout(");
    expect(loadMore).toContain("PAGE_REQUEST_TIMEOUT_MS");
    const fetchFeed = between(feed, "async function fetchFeed(", "async function loadMorePosts");
    expect(fetchFeed).toContain("withTimeout(");
  });

  it("guards the observer with a synchronous ref, not just state", () => {
    const loadMore = between(feed, "async function loadMorePosts()", "async function fetchStories");
    expect(loadMore).toContain("loadingMoreRef.current");
    // ...and clears it on every path, or the feed sticks after one page.
    expect(loadMore).toContain("finally");
    expect(loadMore).toContain("loadingMoreRef.current = false");
  });

  it("does not retire the feed when one page fails", () => {
    const loadMore = between(feed, "async function loadMorePosts()", "async function fetchStories");
    const catchBlock = between(loadMore, "} catch (err) {", "} finally {");
    expect(catchBlock).not.toContain("setHasMore(false)");
    expect(catchBlock).toContain("setLoadMoreError(true)");
    // and the UI offers a way back out of that error
    expect(feed).toContain("Try again");
  });
});

describe("the end of the ranked feed is terminal, not a loop", () => {
  const client = read("../src/lib/api-client.ts");

  it("an exhausted ranker page ends the walk instead of re-serving the top", () => {
    const foryou = between(
      client,
      'if (options.filter === "foryou" && !options.userId',
      'if (options.filter === "following")',
    );
    // Both the empty-success and the failure path of a *paged* request must
    // hand back a terminal page. Falling through to the recency query (which
    // cannot continue from a ranked cursor) re-served the newest page, every
    // row was deduped away, and the spinner looped at the end of all posts.
    const terminals = foryou.match(
      /if \(options\.cursor\) return \{ posts: \[\], nextCursor: null \};/g,
    );
    expect(terminals, "empty ranker page must end the walk").toHaveLength(2);
  });

  it("the feed retires hasMore on an empty page, even one with a cursor", () => {
    const feed = read("../src/routes/feed.tsx");
    const loadMore = between(feed, "async function loadMorePosts()", "async function fetchStories");
    const guard = between(loadMore, "if (page.posts.length === 0) {", "setPosts((prev)");
    expect(guard).toContain("setHasMore(false)");
    expect(guard).toContain("cursorRef.current = null");
  });
});

describe("the other paged lists honour the same contract", () => {
  it("keeps the profile tab cursor on a failed page", () => {
    const profile = read("../src/routes/profile.tsx");
    const loadMore = between(profile, "async function loadMoreTabPosts()", '// The "Replies" tab');
    expect(loadMore).toContain("withTimeout(");
    const catchBlock = between(loadMore, "} catch (err) {", "} finally {");
    expect(catchBlock).not.toContain("setTabCursor(null)");
    // Silent + retryable: the button stays put, no error toast pops (users
    // asked for no toasts for this; a warn in the console is enough).
    expect(catchBlock).not.toContain("toast");
    expect(catchBlock).toContain("console.warn");
  });

  it("keeps notifications paging after one error", () => {
    const route = read("../src/routes/notifications.tsx");
    const loadMore = between(route, "async function loadMore()", "// Belt to the realtime braces");
    expect(loadMore).toContain("withTimeout(");
    const catchBlock = between(loadMore, "} catch (err) {", "} finally {");
    expect(catchBlock).not.toContain("setHasMore(false)");
    expect(catchBlock).not.toContain("toast");
    expect(catchBlock).toContain("console.warn");
  });

  it("does not mark Explore exhausted on a failed walk", () => {
    const explore = read("../src/routes/explore.tsx");
    const creators = between(
      explore,
      "async function loadMoreCreators()",
      "useEffect(() => {\n    // No post fetch",
    );
    expect(creators).toContain("withTimeout(");
    const creatorsCatch = between(creators, "} catch (err) {", "} finally {");
    expect(creatorsCatch).not.toContain("setPeopleExhausted(true)");

    const topPosts = between(
      explore,
      "async function loadMoreTopPosts()",
      "// Client-side quick filter",
    );
    expect(topPosts).toContain("withTimeout(");
    const topCatch = between(topPosts, "} catch (err) {", "} finally {");
    expect(topCatch).not.toContain("setPostsCursor(null)");
  });

  it("clears its timer even on the settled paths (no fake-tick leak)", async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(globalThis, "clearTimeout");
      await withTimeout(Promise.resolve("ok"), 5_000);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the for-you ranker is bounded inside getPostsPage", () => {
  const client = read("../src/lib/api-client.ts");

  it("caps the ranker below the shared page timeout and degrades to recency", () => {
    // A slow ranker cold path used to blow the 15s client guard and reject the
    // whole feed ("Feed fetch failed / Load more failed: timed out after
    // 15000ms"). It is now bounded so over-budget rejects into the recency
    // catch instead — the feed always paints.
    const match = client.match(/const RANKER_BUDGET_MS = ([\d_]+);/);
    expect(match, "RANKER_BUDGET_MS must be defined").not.toBeNull();
    expect(Number(match![1].replace(/_/g, ""))).toBeGreaterThan(0);
    expect(Number(match![1].replace(/_/g, ""))).toBeLessThan(PAGE_REQUEST_TIMEOUT_MS);
    // ...and the ranker call actually runs through that budget.
    expect(client).toMatch(/withBudget\(\s*getForYouPosts\(/);
  });

  it("retrieves via two concurrent Postgres RPCs (no ~13-query cold path)", () => {
    // The pure ranking pipeline now lives in feed-rank-core (shared by the
    // background materializer and the server-fn cold miss). The old fan-out of
    // behaviour + graph + pool + plan queries is gone: it fires the shared pool
    // and the viewer signals concurrently, so a cold epoch is two round trips
    // rather than a dozen across many waves.
    const recs = read("../src/lib/feed-rank-core.ts");
    expect(recs).toMatch(/const \[pool, signals\] = await Promise\.all\(\[/);
    expect(recs).toMatch(/getSharedPool\(supabase, epochBucket\)/);
    expect(recs).toMatch(/fetchViewerSignals\(supabase, myId\)/);
    // ...backed by the two RPCs.
    expect(recs).toMatch(/rpc\("for_you_candidates"/);
    expect(recs).toMatch(/rpc\("for_you_signals"/);
  });
});
