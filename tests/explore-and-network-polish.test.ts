// @vitest-environment node
/**
 * Contracts for Explore/Feed/Profile polish and the code-wide fetch/perf audit.
 *
 *  Explore topics:
 *   The trending sample used to swing between two extremes — a 300-row window
 *   capped to 8, then an uncapped 2,000-row scan returned in full. The audit
 *   lands it on a bounded middle ground: a fixed 600-row sample, a hard 80-tag
 *   ceiling, and offset pagination so explore fetches topics in batches with a
 *   "Load more" affordance instead of pulling everything at once.
 *
 *  Explore media:
 *   Video cards must preview automatically (autoplay + viewport-gated), not just
 *   paint a static first frame, and the trends rail is capped to 10 with a
 *   "View more topics" link rather than dumping every tag.
 *
 *  Boot / network load:
 *   preloadFeedBundle must not fetch the same for-you page twice, feed must skip
 *   a duplicate fetch when it hydrates a warm cache, profile must re-resolve when
 *   the signed-in viewer becomes known (the "posts disappear after login" race),
 *   and the analytics reads must bound their row scans with exact head counts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const api = read("../src/lib/api-client.ts");

describe("explore topics are bounded and paginated", () => {
  it("samples a bounded window and caps the distinct tag set", () => {
    const region = between(
      api,
      "export async function getTrendingTags",
      "export async function generateAIDraft",
    );
    expect(region).toContain(".limit(600)");
    expect(region).toContain(".slice(0, 80)");
    // Paginates for the caller rather than returning everything in one blob.
    expect(region).toContain("options?.offset");
    expect(region).toContain("options?.limit");
    expect(region).toContain(".slice(offset, offset + limit)");
  });

  it("reshapes trending tags into topics the caller can page through", () => {
    const region = between(api, "export async function getTopics", "const TOPIC_GRADIENTS");
    expect(region).toContain("options?.offset");
    expect(region).toContain("trendingTags.slice(offset, offset + limit)");
    expect(region).toContain("total: trendingTags.length");
  });
});

describe("explore media cards preview video automatically", () => {
  const page = read("../src/routes/explore.tsx");

  it("detects a video url and mounts an autoplaying, viewport-gated preview", () => {
    expect(page).toContain("isVideoUrl");
    expect(page).toContain("function VideoPreviewTile");
    expect(page).toContain("<video");
    expect(page).toContain("autoPlay");
    expect(page).toContain("playsInline");
    expect(page).toContain("IntersectionObserver");
    expect(page).toContain("<VideoPreviewTile src={thumbSrc} />");
    expect(page).toContain("isVideo ?");
  });

  it("keeps one shared video-detection helper instead of per-file copies", () => {
    const utils = read("../src/lib/utils.ts");
    const postCard = read("../src/components/social/PostCard.tsx");
    expect(utils).toContain("export function isVideoUrl");
    // Both consumers import it rather than re-declaring the signature check.
    expect(page).not.toContain("function isVideoUrl");
    expect(postCard).not.toContain("function isMediaVideo");
    expect(postCard).toContain("isVideoUrl");
  });

  it("reuses the complete home right rail instead of a bespoke trends panel", () => {
    // Explore now renders the same shared DefaultRail as home (Trending +
    // Live Spaces + Who to follow) rather than its own trends-only panel.
    expect(page).toContain("right={<DefaultRail />}");
    expect(page).toContain(
      'import { FollowButton, DefaultRail } from "@/components/social/RightRail"',
    );
    expect(page).not.toContain("tagsList");
    expect(page).not.toContain("RailFooter");
  });

  it("batches the Topics tab with a Load more control", () => {
    expect(page).toContain("const TOPICS_STEP = 12");
    expect(page).toContain("async function loadMoreTopics");
    expect(page).toContain("getTopics({ limit: TOPICS_STEP, offset: topicList.length })");
    expect(page).toContain("Load more topics");
  });

  it("shows a plain View all affordance with no count", () => {
    expect(page).toContain("View all");
    expect(page).not.toContain("View all ({topicList.length})");
  });
});

describe("boot and preload de-duplication", () => {
  it("no longer fetches the for-you page twice in the preload bundle", () => {
    const region = between(
      api,
      "export async function preloadFeedBundle",
      "export async function getCurrentUser",
    );
    expect(occurrences(region, "getPosts({ limit: 15 })")).toBe(1);
    // Following is fetched on tab-switch, not eagerly.
    expect(region).toContain("following: []");
    // Spaces is no longer fetched at boot: the bundle never rendered it and the
    // read was an unbounded full-table scan. (Comments may still mention
    // getSpaces, so assert on the removed call/field, not the bare word.)
    expect(region).not.toContain("r.spaces");
    expect(region).not.toContain("spaces:");
  });

  it("bounds the spaces read and filters live rooms server-side", () => {
    const region = between(
      api,
      "export async function getSpaces",
      "export async function createSpace",
    );
    expect(region).toContain("options.limit ?? 200");
    expect(region).toContain(".limit(limit)");
    expect(region).toContain('query.eq("live", true)');
    const rail = read("../src/components/social/RightRail.tsx");
    expect(rail).toContain("getSpaces({ liveOnly: true })");
    expect(rail).not.toContain(".filter((s) => s.live)");
  });

  it("feed skips a duplicate fetch when it hydrates a warm cache", () => {
    const feed = read("../src/routes/feed.tsx");
    expect(feed).toContain("const didInitialLoad = useRef(false)");
    expect(feed).toContain("initialCache.isFresh && initialCache.hasData");
  });

  it("bounds the boot-path stories read", () => {
    const region = between(
      api,
      "export async function getStories",
      "async function hydrateStoryLikes",
    );
    expect(region).toContain(".limit(300)");
  });
});

describe("right rail trends reused and capped to 4", () => {
  it("shares one rail limit and renders only that many trending tags", () => {
    const rail = read("../src/components/social/RightRail.tsx");
    // One shared constant drives both the fetch and the render, so the teaser
    // list can't drift between the feed rail and explore.
    expect(rail).toContain("export const TRENDING_RAIL_LIMIT = 4");
    expect(rail).toContain("getTrendingTags({ limit: TRENDING_RAIL_LIMIT })");
    expect(rail).toContain("tags.slice(0, TRENDING_RAIL_LIMIT)");
    // Explore reuses the whole shared rail (which internally honours this
    // constant) instead of declaring its own trending fetch.
    const explore = read("../src/routes/explore.tsx");
    expect(explore).toContain("right={<DefaultRail />}");
    expect(explore).not.toContain("getTrendingTags");
    expect(explore).not.toContain("TRENDS_RAIL_LIMIT");
  });
});

describe("profile re-resolves when the signed-in viewer becomes known", () => {
  it("gates the resolve effect on viewerId so posts land after a fresh login", () => {
    const page = read("../src/routes/profile.tsx");
    expect(page).toContain("const viewerId = useCurrentUserId()");
    expect(page).toContain("[isMe, targetId, viewerId]");
  });
});

describe("analytics bounds its row scans", () => {
  it("replaces the 5,000-row scans with exact counts plus a small sample", () => {
    expect(api).toContain("const IMPRESSION_SAMPLE = 500");
    expect(api).toContain("const FOLLOWER_SAMPLE = 1000");
    expect(api).toContain('{ count: "exact", head: true }');
    expect(api).not.toContain(".limit(5000)");
    // Headline numbers come from the accurate count, not the sample length.
    expect(api).toContain("followers: followersCount");
    expect(api).toContain("Math.max(totalViews, impressionCount)");
  });
});

describe("media proxy sets cache-control for repeat views", () => {
  const media = read("../src/routes/api/public/media/$.ts");

  it("caches public inline-safe objects immutably and refuses to cache private ones", () => {
    expect(media).toContain('"public, max-age=31536000, immutable"');
    expect(media).toContain("no-store");
    expect(media).toContain('"Cache-Control": cacheControl');
  });
});

describe("profile network reflects follows immediately", () => {
  const page = read("../src/routes/profile.tsx");

  it("exposes a roster fetch for both sides of the follow graph", () => {
    expect(api).toContain("export async function getProfileNetwork");
    expect(api).toContain('.eq("target_id", profileId)');
    expect(api).toContain('.eq("follower_id", profileId)');
  });

  it("carries the follower id so a remote follow can light up the target", () => {
    expect(api).toContain("followerId: userId");
  });

  it("adds a real Network tab that lists followers/following", () => {
    expect(page).toContain('"Network"');
    expect(page).toContain("getProfileNetwork");
    expect(page).toContain('tab === "Network"');
    expect(page).toContain("network[networkView]");
    expect(page).toContain("<FollowButton");
  });

  it("re-reads counts and the roster when a follow event arrives", () => {
    expect(page).toContain('"follow_updated"');
    expect(page).toContain("setCountsNonce");
    const handler = between(
      page,
      "async function handleToggleFollow",
      "function handleShareProfile",
    );
    expect(handler).toContain("setCountsNonce((n) => n + 1)");
  });

  it("makes the follower/following stats open the Network tab", () => {
    expect(page).toContain('setTab("Network")');
  });
});
