// @vitest-environment node
/**
 * Polish contracts for viewing a single post:
 *
 *  1. /post/$id used to flip straight to "This post isn't available" (or a
 *     stale static panel) while the interactive card was still loading. It
 *     must render a skeleton while the full post — or the share loader — is
 *     in flight, then fade the real card in.
 *  2. Analytics "Top Performing Posts" (and the Growth Advisor's best post)
 *     must be links into /post/$id, so a creator can tap a number and land on
 *     the post itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** Text between two markers, so an assertion can be about one region only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe("the post page loads with a skeleton", () => {
  const page = read("../src/routes/post.$id.tsx");

  it("tracks the interactive-card fetch and shows a skeleton while pending", () => {
    const effect = between(page, "useEffect(() => {", "return () => {");
    expect(effect).toContain("setLoadingFull(true)");
    expect(effect).toContain("setLoadingFull(false)");
    expect(page).toContain("<PostDetailSkeleton");
  });

  it("answers with the skeleton BEFORE declaring the post unavailable", () => {
    const branches = between(page, "{fullPost ? (", "<Panel");
    expect(branches).toContain("loadingFull ?");
    // The skeleton branch must sit between the card and the !post fallback.
    const skeletonIdx = branches.indexOf("loadingFull ?");
    const unavailableIdx = branches.indexOf("!post ?");
    expect(skeletonIdx).toBeGreaterThanOrEqual(0);
    expect(unavailableIdx).toBeGreaterThan(skeletonIdx);
  });

  it("gives the route loader itself a pending skeleton too", () => {
    expect(page).toContain("pendingComponent: PostPagePending");
    const pending = between(page, "function PostPagePending()", "function PostPage()");
    expect(pending).toContain("<PostDetailSkeleton");
  });

  it("fades the real card in instead of popping", () => {
    const branches = between(page, "{fullPost ? (", ") : loadingFull");
    expect(branches).toContain("animate-in fade-in");
  });
});

describe("the detail skeleton mirrors the real layout", () => {
  const skeleton = read("../src/components/social/PostSkeleton.tsx");
  const detail = between(skeleton, "export function PostDetailSkeleton", "\n}".concat("\n"));

  it("declares itself a loading region for assistive tech", () => {
    expect(skeleton).toContain("export function PostDetailSkeleton");
    expect(detail).toContain('aria-busy="true"');
    expect(detail).toContain("<PostSkeleton />");
  });

  it("only shows a media block when the post actually has media", () => {
    expect(detail).toContain("{hasMedia &&");
    const page = read("../src/routes/post.$id.tsx");
    expect(page).toContain("hasMedia={Boolean(post?.mediaUrl || post?.gradient)}");
  });
});

describe("analytics top posts open the post they measure", () => {
  const dash = read("../src/components/social/AnalyticsDashboard.tsx");

  it("imports the router Link", () => {
    expect(dash).toContain('import { Link } from "@tanstack/react-router"');
  });

  it("renders each Top Performing Post as a /post/$id link", () => {
    const grid = between(dash, "Top Performing Posts", "Show all");
    expect(grid).toContain('to="/post/$id"');
    expect(grid).toContain("params={{ id: post.id }}");
    expect(grid).toContain("<Link");
    // Hover affordance so the card reads as clickable.
    expect(grid).toContain("group-hover:text-brand");
  });

  it("links the Growth Advisor's best post as well", () => {
    const advisor = between(dash, "Your strongest post so far", "Best time to publish");
    expect(advisor).toContain('to="/post/$id"');
    expect(advisor).toContain("params={{ id: bestPost.id }}");
  });
});
