// @vitest-environment node
/**
 * Two feed-navigability regressions that lived in the scroll plumbing:
 *
 *   1. The sticky "For you / Following / Latest" header (with the refresh
 *      button) stopped auto-hiding on scroll-down and revealing on scroll-up —
 *      and it was worst on DESKTOP. On lg+ the AppShell <main id="app-main"> is
 *      the real scroller (the outer shell is `lg:overflow-hidden`, so `window`
 *      never scrolls). `onAppScroll` used to resolve the scroll node with the
 *      OVERFLOW-AWARE `getScrollContainer()`, which returns null while <main>
 *      is still short — true the instant the reveal effect first runs on a cold
 *      feed. So the listener bound only to `window`, never fired on desktop, and
 *      the header stopped reacting. The fix subscribes to the persistent node.
 *
 *   2. Clicking "Home" while already on /feed did nothing: a Link to the
 *      current route is a router no-op. It should behave like X/Twitter — scroll
 *      to top + quietly re-pull. AppShell now signals `spaces:home-tapped` and
 *      the feed acts on it.
 *
 * Store/JSX effects a node test cannot stand up are read out of source, matching
 * the rest of this suite (assert short, wrap-proof fragments — prettier reflows
 * long lines).
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

describe("scroll subscriptions bind to the persistent desktop scroller", () => {
  const utils = src("lib/utils.ts");

  it("reads the AppShell <main> node by id for subscribing, independent of overflow", () => {
    expect(utils).toContain("function getScrollMain()");
    expect(utils).toContain('document.getElementById("app-main")');
  });

  it("onAppScroll attaches to getScrollMain(), not the overflow-aware getScrollContainer()", () => {
    const sub = between(utils, "export function onAppScroll", "window.addEventListener");
    expect(sub).toContain("getScrollMain()");
    expect(sub).not.toContain("getScrollContainer()");
  });

  it("still keeps the overflow-aware reader for getScrollY (correct offset at the top)", () => {
    const read = between(utils, "export function getScrollY", "export function scrollToTop");
    expect(read).toContain("getScrollContainer()");
  });
});

describe("tapping Home while already on the feed", () => {
  const shell = src("components/social/AppShell.tsx");

  it("signals a home tap with a window event instead of a dead no-op navigation", () => {
    expect(shell).toContain('const HOME_TAP_EVENT = "spaces:home-tapped"');
    expect(shell).toContain('to === "/feed"');
    expect(shell).toContain("window.dispatchEvent(new CustomEvent(HOME_TAP_EVENT))");
  });

  it("both the sidebar link and the mobile tab route the active-Home tap through the signal", () => {
    const nav = between(shell, "function NavLink", "className={cn(");
    expect(nav).toContain("maybeHomeTap(item.to, active)");
    expect(nav).toContain("e.preventDefault()");
    const mobile = between(shell, "function MobileTab", "className={cn(");
    expect(mobile).toContain("maybeHomeTap(item.to, active)");
  });

  it("the feed answers the signal: scroll to top + silent re-pull (never the skeleton)", () => {
    const feed = src("routes/feed.tsx");
    // The listener subscribes and cleans up on unmount.
    expect(feed).toContain('window.addEventListener("spaces:home-tapped"');
    expect(feed).toContain('window.removeEventListener("spaces:home-tapped"');
    const body = between(feed, "const onHomeTapped = () => {", "window.addEventListener");
    expect(body).toContain("scrollToTop()");
    // silent (true) + refresh (true) — a hard reload would flash the skeleton.
    expect(body).toContain("fetchFeed(true, true)");
  });
});
