// @vitest-environment node
/**
 * Two share-and-browse bugs pinned as source contracts:
 *
 *  1. A copied profile link (/u/<username>) opened a teaser that never led to
 *     the real profile: the "Open full profile" query hit PostgREST's
 *     `id.eq.<username>` against a uuid column, the whole or-filter was rejected
 *     with invalid-uuid syntax, and the page kept a username placeholder.
 *     Only UUIDs may touch the id column, and /u must forward visitors to the
 *     full profile while crawlers keep the SSR meta shell.
 *  2. The post card's three-dots menu was absolutely positioned inside an
 *     overflow-hidden <article> — a short post clipped the dropdown at the
 *     card's bottom edge. It must render through a portal instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

describe("profile links open the full profile", () => {
  it("getUserProfile only matches the uuid column with a uuid", () => {
    const client = read("../src/lib/api-client.ts");
    const fn = between(
      client,
      "export async function getUserProfile",
      "export async function getBookmarks",
    );
    expect(fn).toContain("isUuid");
    // The or-filter may name id.eq only when the handle is a valid uuid.
    expect(fn).toContain("id.eq.${handle},username.eq.${handle}` : `username.eq.${handle}");
  });

  it("fetchProfile applies the same uuid guard", () => {
    const svc = read("../src/lib/profile-service.ts");
    const fn = between(svc, "export async function fetchProfile", "export function useProfile");
    expect(fn).toContain("isUuid");
    expect(fn).toContain("username.eq.${id}");
  });

  it("/u/<username> forwards the visitor to /profile", () => {
    const route = read("../src/routes/u.$username.tsx");
    expect(route).toContain(
      'navigate({ to: "/profile", search: { user: profile.username }, replace: true })',
    );
    // …but the SSR page keeps its meta shell for link previews (the effect, not
    // a server redirect, is what forwards humans).
    expect(route).toContain("useEffect");
    expect(route).toContain('property: "og:type", content: "profile"');
  });

  it("the hand-off renders a spinner, never the profile teaser", () => {
    const route = read("../src/routes/u.$username.tsx");
    // The stub card that used to flash before the redirect is gone entirely.
    expect(route).not.toContain("Open full profile");
    expect(route).not.toContain("followers");
    expect(route).not.toContain("profile.posts.map");
    // Both the loader round-trip and the redirect show the same quiet state.
    expect(route).toContain("pendingComponent: ProfileHandoff");
    expect(route).toContain("animate-spin");
  });
});

describe("the post-card more menu escapes the clipped card", () => {
  const card = read("../src/components/social/PostCard.tsx");

  it("renders the dropdown through a portal, not inside the article", () => {
    // The card <article> is overflow-hidden by design (media clips to radius);
    // the menu must not live inside it.
    expect(card).toContain("overflow-hidden min-w-0 max-w-full");
    const menu = between(card, "{showMenu &&", "</header>");
    expect(menu).toContain("createPortal(");
    expect(menu).toContain("document.body");
    expect(menu).not.toContain('className="absolute right-0 top-8');
  });

  it("flips up when the viewport bottom has no room", () => {
    const effect = between(card, "if (!showMenu) {", "// Autoplay/Pause video");
    expect(effect).toContain("openUp");
    expect(effect).toContain("getBoundingClientRect()");
  });
});

/** Text between two markers, so an assertion can be about one function only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}
