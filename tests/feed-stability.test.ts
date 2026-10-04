// @vitest-environment node
/**
 * Feed stability across a hard reload and when new content arrives.
 *
 * "For you" is already epoch-stable on the SERVER (one ranked snapshot per
 * viewer per 10-minute epoch, served as a read of `timeline_items`). The
 * breakage was entirely on the client:
 *   • the feed cache is in-memory, so a reload (F5) wiped it → a skeleton flash
 *     and a fresh fetch whose order could differ — and, worse, a fetch that ran
 *     BEFORE the viewer id resolved served a guest chronological page that then
 *     reshuffled to the ranked list the instant the id landed;
 *   • a background reconcile replaced the whole list (`setPosts(page.posts)`),
 *     so any new post could jump the cards you were reading.
 *
 * The contract that fixes it:
 *   • the rendered view (list + cursor + reveal count + scroll) is persisted to
 *     sessionStorage keyed by viewer id and the epoch, and restored on reload so
 *     the exact same feed paints instantly;
 *   • the For-you fetch WAITS for the viewer id, so we never paint-then-reshuffle;
 *   • a silent background refresh merges IN PLACE — existing order is preserved,
 *     only metadata refreshes, and genuinely-new posts go through the pill (or
 *     the top only when already at the top) rather than reordering the feed;
 *   • a restored deep cursor is never clobbered by the head-page reconcile.
 *
 * Store/JSX code a node test cannot stand up is read out of source, matching the
 * rest of this suite.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const src = (rel: string) => read(`../src/${rel}`);

/** Text between two markers, so an assertion is about one region only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe("the feed snapshot survives a reload", () => {
  const cache = src("lib/feed-cache.ts");

  it("persists and reads the rendered view from sessionStorage", () => {
    expect(cache).toContain("export function readFeedSnapshot(viewerId: string)");
    expect(cache).toContain("export function writeFeedSnapshot(snapshot: FeedSnapshot)");
    expect(cache).toContain("window.sessionStorage.getItem(SNAPSHOT_KEY)");
    expect(cache).toContain("window.sessionStorage.setItem(SNAPSHOT_KEY");
  });

  it("only restores a snapshot for the same viewer and within the epoch", () => {
    // A different account (or a stale past-epoch list) must never be restored.
    expect(cache).toContain("parsed.viewerId !== viewerId");
    expect(cache).toContain("> SNAPSHOT_MAX_AGE_MS");
    expect(cache).toContain("parsed.foryou.length === 0");
    // And never trusts a malformed payload it did not write.
    expect(
      between(cache, "export function readFeedSnapshot", "export function writeFeedSnapshot"),
    ).toContain("} catch {");
  });

  it("caps the stored list so a long scroll can't bloat storage", () => {
    expect(cache).toContain("snapshot.foryou.slice(0, SNAPSHOT_MAX_POSTS)");
  });
});

describe("the feed restores that snapshot instead of re-deriving it", () => {
  const feed = src("routes/feed.tsx");

  it("waits for the viewer id before fetching For you, so it never reshuffles after", () => {
    const load = between(
      feed,
      "const viewerId = useCurrentUserId();",
      "// Persist the exact rendered view",
    );
    expect(load).toContain("if (!viewerId) return;");
  });

  it("paints the stored list, cursor, reveal count and scroll, then reconciles quietly", () => {
    const restore = between(feed, "const snap = readFeedSnapshot(viewerId);", "fetchFeed();");
    expect(restore).toContain("setPosts(snap.foryou);");
    expect(restore).toContain("cursorRef.current = snap.cursor ?? null;");
    expect(restore).toContain(
      "setVisibleCount(snap.visibleCount > 0 ? snap.visibleCount : FEED_REVEAL_STEP);",
    );
    expect(restore).toContain("setLoading(false);");
    expect(restore).toContain("restoreScrollTo(snap.scrollY || 0);");
    // A silent reconcile (no flash, no reorder) runs on top of the restored paint.
    expect(restore).toContain("void fetchFeed(true);");
  });

  it("keeps the warm-cache skip path (no duplicate fetch on SPA navigation)", () => {
    expect(feed).toContain("const didInitialLoad = useRef(false)");
    expect(feed).toContain("initialCache.isFresh && initialCache.hasData");
  });

  it("persists the view on content changes and once more on pagehide", () => {
    expect(feed).toContain("setTimeout(() => writeFeedSnapshot(snapshot), 400)");
    expect(feed).toContain('window.addEventListener("pagehide", flush)');
  });
});

describe("new content arriving does not reorder the feed", () => {
  const feed = src("routes/feed.tsx");
  const fetchFeed = between(feed, "async function fetchFeed(", "async function loadMorePosts");

  it("only wholesale-replaces on a non-silent load", () => {
    expect(fetchFeed).toContain("const canMerge = silent && posts.length > 0;");
    expect(fetchFeed).toContain("if (!canMerge) {");
  });

  it("merges in place: same order, refreshed rows, new posts via the pill", () => {
    // Existing cards keep their position; only their data is swapped, built by
    // mapping over the CURRENT `posts` (not the fresh page) so order is stable.
    expect(fetchFeed).toContain("const kept = posts.map(");
    expect(fetchFeed).toContain("freshById.get(p.id)!");
    const keptRegion = between(fetchFeed, "const kept = posts.map(", "setPendingIncomingPosts");
    expect(keptRegion).toContain("const arrivals = page.posts.filter(");
    // Genuinely-new arrivals are not force-inserted mid-list — they queue behind
    // the "new posts" pill unless the reader is already at the top.
    expect(fetchFeed).toContain("} else if (getScrollY() < 200) {");
    expect(fetchFeed).toContain("setPendingIncomingPosts((pill) => {");
  });

  it("never clobbers a restored (deeper) cursor with the head-page cursor", () => {
    expect(fetchFeed).toContain("if (!cursorRef.current) {");
  });

  it("still bounds the fetch with the shared timeout (unchanged resilience)", () => {
    expect(fetchFeed).toContain("withTimeout(");
    expect(fetchFeed).toContain("PAGE_REQUEST_TIMEOUT_MS");
  });
});
