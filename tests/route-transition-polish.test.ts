// @vitest-environment node
/**
 * Platform transition polish (incremental, no route renames).
 *
 * Every app page wraps its own <AppShell>, so an SPA navigation remounts the
 * whole shell. Before this work that meant: a hard content cut with no
 * transition, the lg+ scroller (#app-main) snapping to the top (the router's
 * scrollRestoration only drives `window`), and the shell re-running its
 * useMounted false→true flip on every page so avatars/names re-painted a
 * placeholder — the "flicker / irrelevant things" readers feel between pages.
 *
 * The contract that fixes it, without turning the shell into a layout route:
 *   • a keyed `.route-enter` wrapper fades the incoming page in (banners sit
 *     outside the key so they never re-animate);
 *   • `lastScrollByPath` records each route's #app-main offset as you scroll and
 *     resumes it on re-entry, skipping /feed (which restores its own snapshot);
 *   • the persistent chrome is memoized and reads a session-latched
 *     `useMountedStable`, so navigating never repaints the placeholder;
 *   • shared skeletons fade in instead of popping;
 *   • everything is motion-safe / reduced-motion opt-out.
 *
 * Component/JSX a node test cannot stand up is read out of source, matching the
 * rest of the suite. Assert short, wrap-proof fragments — prettier reflows
 * long lines at 100 cols.
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

describe("route-enter fade utility", () => {
  const css = src("styles.css");

  it("defines the keyframes, the utility, and a reduced-motion opt-out", () => {
    expect(css).toContain("@keyframes route-enter");
    expect(css).toContain(".route-enter {");
    expect(css).toContain("animation: route-enter 170ms ease-out");
    // Motion is a courtesy, not a demand: readers who opt out get none of it.
    const block = between(css, "@media (prefers-reduced-motion: reduce)", "animation: none;");
    expect(block).toContain(".route-enter");
  });

  it("settles in calm — the keyframe never starts fully transparent", () => {
    // A fade up from opacity 0 is exactly the blank FLASH the user rejected: for
    // the first frames the page is invisible and the ambient background shows
    // through. The entrance must start ALMOST opaque (and only nudge a few px).
    const kf = between(css, "@keyframes route-enter", ".route-enter {");
    const from = between(kf, "from {", "to {");
    expect(from).not.toMatch(/opacity:\s*0(?![.\d])/);
    expect(from).toMatch(/opacity:\s*0\.[2-9]/);
    expect(from).toContain("translateY(4px)");
  });
});

describe("AppShell page-swap transition + scroll memory", () => {
  const shell = src("components/social/AppShell.tsx");

  it("fades the incoming page with a route-keyed wrapper", () => {
    expect(shell).toContain('<div key={pathname} className="route-enter">');
  });

  it("records #app-main scroll per route and resumes it on re-entry", () => {
    expect(shell).toContain("const lastScrollByPath = new Map<string, number>();");
    // Written from the (stable) scroll handler via a live-pathname ref.
    expect(shell).toContain("lastScrollByPath.set(pathnameRef.current, currentY)");
    expect(shell).toContain("const saved = lastScrollByPath.get(pathname) ?? 0");
    // Restored on the real desktop scroller, after the page has laid out.
    const restore = between(
      shell,
      "const saved = lastScrollByPath.get(pathname)",
      "}, [pathname]);",
    );
    expect(restore).toContain("getScrollContainer()");
    expect(restore).toContain("el.scrollTop = saved");
    expect(restore).toContain("requestAnimationFrame");
  });

  it("defers to the feed's own snapshot restore instead of fighting it", () => {
    expect(shell).toContain('pathname === "/feed"');
  });
});

describe("persistent shell chrome is stable across navigations", () => {
  const shell = src("components/social/AppShell.tsx");
  const rail = src("components/social/RightRail.tsx");
  const mounted = src("hooks/use-mounted.ts");

  it("memoizes the sidebar, the workspace switcher and the right rail", () => {
    expect(shell).toContain("const Sidebar = memo(function Sidebar(");
    expect(shell).toContain("const WorkspaceSwitcher = memo(function WorkspaceSwitcher(");
    expect(rail).toContain("export const DefaultRail = memo(function DefaultRail(");
  });

  it("the shell chrome reads a session-latched mount flag", () => {
    expect(shell).toContain("useMountedStable");
    expect(shell).not.toContain("useMounted()");
  });

  it("useMountedStable latches once painted, while useMounted stays hydration-safe", () => {
    expect(mounted).toContain("let hasPaintedOnce = false;");
    expect(mounted).toContain("useState(hasPaintedOnce)");
    expect(mounted).toContain("hasPaintedOnce = true;");
    // The original reload-auth gate is untouched: still starts false every load.
    const base = between(
      mounted,
      "export function useMounted()",
      "export function useMountedStable",
    );
    expect(base).toContain("useState(false)");
  });
});

describe("shared skeletons fade in rather than pop", () => {
  it("FeedSkeleton and SpacesSkeleton use a motion-safe fade", () => {
    const postSkel = src("components/social/PostSkeleton.tsx");
    const feed = between(
      postSkel,
      "export function FeedSkeleton()",
      "export function PostDetailSkeleton",
    );
    expect(feed).toContain("motion-safe:animate-in");
    expect(feed).toContain("motion-safe:fade-in");

    const spaces = src("routes/spaces.tsx");
    expect(spaces).toContain("function SpacesSkeleton()");
    // Assert directly: the fade utility class string is unique to the skeleton
    // root and stays put whether prettier wraps the JSX attribute list or not.
    expect(spaces).toContain("motion-safe:animate-in");
    expect(spaces).toContain("motion-safe:fade-in");
    expect(spaces).toContain('aria-busy="true"');
  });
});
