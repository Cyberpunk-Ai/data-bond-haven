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

describe("the other paged lists honour the same contract", () => {
  it("keeps the profile tab cursor on a failed page", () => {
    const profile = read("../src/routes/profile.tsx");
    const loadMore = between(profile, "async function loadMoreTabPosts()", '// The "Replies" tab');
    expect(loadMore).toContain("withTimeout(");
    const catchBlock = between(loadMore, "} catch (err) {", "} finally {");
    expect(catchBlock).not.toContain("setTabCursor(null)");
    expect(catchBlock).toContain("toast.error");
  });

  it("keeps notifications paging after one error", () => {
    const route = read("../src/routes/notifications.tsx");
    const loadMore = between(route, "async function loadMore()", "// Belt to the realtime braces");
    expect(loadMore).toContain("withTimeout(");
    const catchBlock = between(loadMore, "} catch (err) {", "} finally {");
    expect(catchBlock).not.toContain("setHasMore(false)");
    expect(catchBlock).toContain("toast.error");
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
