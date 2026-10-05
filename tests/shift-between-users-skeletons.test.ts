// @vitest-environment node
/**
 * "Shifting between users should feel smooth" — when a Spaces host or an Explore
 * topics/creators list is still arriving, the surface used to either paint a
 * raw-UUID pending profile (Spaces) or pop an empty grid into place (Explore).
 * These source contracts pin the calm-skeleton treatment that replaces the flash.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const src = (rel: string) => read(`../src/${rel}`);

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe("Spaces host card settles in instead of flashing a raw UUID", () => {
  const spaces = src("routes/spaces.tsx");

  it("reads the host profile loading flag from useProfile", () => {
    expect(spaces).toContain(
      "const { profile: hostProfile, loading: hostLoading } = useProfile(space.host_id);",
    );
  });

  it("paints a skeleton for the host row while that profile is in flight", () => {
    const card = between(spaces, "function SpaceCard(", "const tabs =");
    // Guarded on loading AND the absence of a resolved profile, so a cached host
    // never flashes the skeleton and an uncached one never shows the pending id.
    expect(card).toContain("hostLoading && !hostProfile");
    expect(card).toContain('<Skeleton className="h-10 w-10 shrink-0 rounded-full" />');
  });
});

describe("Explore shows skeletons while topics and creators arrive", () => {
  const explore = src("routes/explore.tsx");

  it("tracks both async lists with a loading state", () => {
    expect(explore).toContain("const [topicsLoading, setTopicsLoading] = useState(true);");
    expect(explore).toContain("const [peopleLoading, setPeopleLoading] = useState(true);");
  });

  it("renders a topics skeleton until the first page lands", () => {
    expect(explore).toContain("topicsLoading && topicList.length === 0");
    const fetch = between(explore, "getTopics({ limit: TOPICS_STEP, offset: 0 })", "}, []);");
    expect(fetch).toContain("setTopicsLoading(false)");
  });

  it("includes peopleLoading in the creators skeleton condition", () => {
    expect(explore).toContain("(loading || peopleLoading) && filteredCreators.length === 0");
  });

  it("loadPeople always clears its skeleton, even on a failed fetch", () => {
    const load = between(explore, "function loadPeople(", "// Walks the directory");
    expect(load).toContain("setPeopleLoading(true);");
    expect(load).toContain(".finally(clear);");
    expect(load).toContain("if (ok()) setPeopleLoading(false);");
  });
});
