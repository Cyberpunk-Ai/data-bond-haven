/**
 * Two feed artifacts, both invisible until somebody looks:
 *
 * 1. A poll row whose `options` array is empty (legacy / bad write) used to
 *    still mount the bordered `bg-foreground/[0.03]` container. Three percent
 *    foreground on a light card is essentially nothing — so the feed showed a
 *    floating transparent rectangle where a poll should have been.
 *
 * 2. A post whose `image_gradient` string is stale (a preset we removed from
 *    Composer, a copy-paste from an older taxonomy) still triggered the
 *    16/10 `bg-gradient-to-br` tile, but with no Tailwind color stop the
 *    gradient resolves transparent-to-transparent. Same floating rectangle,
 *    different cause.
 *
 * The picker-ring test lives here too because the fix is in the same commit:
 * the settings/top-bar accent swatches used to lag one paint behind reload
 * because useTheme synced localStorage in a plain `useEffect`, which React
 * runs AFTER paint. It now uses `useLayoutEffect` on the client so the ring
 * lands on the correct accent on the very first frame the browser paints.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const CARD = src("../src/components/social/PostCard.tsx");
const THEME = src("../src/lib/theme-state.ts");

describe("PostCard skips media/poll containers that would paint nothing", () => {
  it("does not render the poll frame when there are no options", () => {
    // The guard must be on the JSX expression, not inside the block: an
    // outer div that mounts and then finds no children is exactly the bug.
    expect(CARD).toContain("poll && poll.options && poll.options.length > 0 &&");
    // Belt: the container itself remains a bordered, subtly tinted card, so
    // a real poll with options still looks like a poll.
    expect(CARD).toContain(
      '<div className="mt-4 rounded-2xl border border-border/80 bg-foreground/[0.03] p-4 space-y-2.5">',
    );
  });

  it("requires a real Tailwind color stop before drawing the gradient tile", () => {
    // Any of `from-*`, `via-*`, `to-*` counts. A string that only carries
    // arbitrary tokens (or is empty) would produce a transparent rectangle.
    expect(CARD).toMatch(/\\b\(\?:from\|via\|to\)-\/\.test\(post\.image_gradient\)/);
    expect(CARD).toContain("aspect-[16/10] w-full bg-gradient-to-br");
  });
});

describe("The chosen accent's selection ring does not shift on reload", () => {
  it("reads localStorage before the browser paints (useLayoutEffect on the client)", () => {
    // An isomorphic alias so SSR still uses `useEffect` (React warns about
    // useLayoutEffect on the server). Client uses `useLayoutEffect`, which
    // commits synchronously after mount and before paint — the ring is on
    // the correct swatch in the very first painted frame.
    expect(THEME).toContain("useLayoutEffect");
    expect(THEME).toMatch(
      /const useIsomorphicLayoutEffect = typeof window !== "undefined" \? useLayoutEffect : useEffect;/,
    );
    // Both state-adopting effects must use it: the localStorage read AND the
    // preferences-ready adopt, otherwise either one can still cause a beat
    // of the wrong selection.
    const syncEffectIdx = THEME.indexOf("setSettings(getStoredThemeSettings());");
    const adoptEffectIdx = THEME.indexOf("const adopt = () =>");
    const layoutOpenIdx = THEME.lastIndexOf("useIsomorphicLayoutEffect(", syncEffectIdx);
    const adoptOpenIdx = THEME.lastIndexOf("useIsomorphicLayoutEffect(", adoptEffectIdx);
    expect(layoutOpenIdx).toBeGreaterThan(-1);
    expect(adoptOpenIdx).toBeGreaterThan(-1);
  });

  it("still keeps the guest guard on the preferences adopt path", () => {
    // Signed-out users have no account copy; without this guard the very
    // first tick overwrites localStorage with DEFAULTS (violet), the bug we
    // fixed earlier. Nothing here should undo that.
    expect(THEME).toContain("if (!signedInProfileId()) return;");
  });
});
