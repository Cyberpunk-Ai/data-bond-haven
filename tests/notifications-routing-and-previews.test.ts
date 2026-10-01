// @vitest-environment node
/**
 * Three report-driven fixes pinned as source contracts:
 *
 *  1. No more toast pop-ups for notifications: the realtime toast hook is gone
 *     and paged lists fail silently (retryable button, console warn only).
 *  2. Clicking a notification must land on the right page: DMs open the
 *     thread, tips on a post open the post (which needs the DB to stamp
 *     post_id on tip notifications), and everything person-shaped opens the
 *     actor's profile.
 *  3. Shared links previewed with a blurry scraped favicon because the site
 *     declared no og:image; the 512px brand icon must be pinned with real
 *     dimensions, as an absolute URL.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

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

describe("notification toasts are gone for good", () => {
  it("the realtime toast hook no longer exists or is mounted", () => {
    expect(existsSync(new URL("../src/hooks/useNotificationToasts.ts", import.meta.url))).toBe(
      false,
    );
    const shell = read("../src/components/social/AppShell.tsx");
    expect(shell).not.toContain("useNotificationToasts");
  });

  it("Explore pages on without an error toast", () => {
    const explore = read("../src/routes/explore.tsx");
    const creators = between(
      explore,
      "async function loadMoreCreators()",
      "useEffect(() => {\n    // No post fetch",
    );
    const posts = between(
      explore,
      "async function loadMoreTopPosts()",
      "// Client-side quick filter",
    );
    expect(creators).not.toContain("toast");
    expect(posts).not.toContain("toast");
    // And its catch blocks stay silent-but-retryable.
    expect(between(posts, "} catch (err) {", "} finally {")).toContain("console.warn");
  });
});

describe("clicking a notification opens the right page", () => {
  const route = read("../src/routes/notifications.tsx");
  const open = between(
    route,
    "function handleOpen(n: Notification)",
    "async function handleDelete",
  );

  it("routes DM alerts into the inbox thread, not the sender's profile", () => {
    expect(open).toContain('"message"');
    expect(open).toContain('to: "/messages"');
    expect(open).toContain("search: { user: n.actor_id }");
  });

  it("opens the post for post-backed engagement, tips included", () => {
    expect(open).toContain('["like", "comment", "reply", "repost", "mention", "tip"]');
    expect(open).toContain('to: "/post/$id"');
    // …and the post check runs BEFORE the tip→hub fallback, or a tip on a
    // post would still land in Monetization.
    const postIdx = open.indexOf('to: "/post/$id"');
    const hubIdx = open.indexOf('section: "monetization"');
    expect(postIdx).toBeLessThan(hubIdx);
  });

  it("falls back: tips without a post go to the hub, people to profiles", () => {
    expect(open).toContain('if (n.type === "tip" || (n.type as string) === "payout")');
    expect(open).toContain('to: "/profile"');
  });

  it("the DB stamps tip notifications with the post id", () => {
    const sql = read("../db/migrations/20261001000098_tip_notification_post_id.sql");
    expect(sql).toContain("create or replace function public.t_tips_after()");
    expect(sql).toContain("new.post_id);");
    // Rows delivered before the stamp must not stay dead links.
    expect(sql).toContain("set post_id = t.post_id");
  });
});

describe("link previews carry a sharp logo", () => {
  it("the root head pins og:image with declared size", () => {
    const root = read("../src/routes/__root.tsx");
    const head = between(root, "meta: [", "links: [");
    expect(head).toContain("...OG_IMAGE_META");
    expect(head).toContain('property: "og:site_name"');
  });

  it("the url is absolute — scrapers ignore relative og:image", () => {
    const og = read("../src/lib/og-meta.ts");
    expect(og).toContain("window.location.origin");
    expect(og).toContain("https://spaces1.com");
    expect(og).toContain('OG_IMAGE_PATH = "/icon-512.png"');
    expect(og).toContain('property: "og:image:width"');
    expect(og).toContain('property: "og:image:height"');
    expect(og).toContain('name: "twitter:image"');
  });
});
