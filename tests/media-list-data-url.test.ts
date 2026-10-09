import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { splitMediaList, joinMediaList, firstMedia } from "@/lib/media-list";
import { firstMediaUrl } from "@/lib/utils";

/**
 * A media column stores any number of attachments comma-joined in ONE text cell
 * (the composer sends `a.jpg,b.jpg`). When an upload falls back to an inline
 * `data:<mime>;base64,<payload>` url, that value carries a comma of its own, so
 * the naive `.split(",")` every surface used shattered each base64 attachment
 * into a header with no body plus an orphaned blob — the "many broken image
 * glyphs in a multi-attachment post" the user reported. The canonical splitter
 * re-joins a `data:` url so the round-trip is lossless.
 */

describe("splitMediaList is data-URL-aware", () => {
  it("splits ordinary comma-joined proxy urls", () => {
    expect(
      splitMediaList("/api/public/media/posts/p1/a.jpg,/api/public/media/posts/p1/b.jpg"),
    ).toEqual(["/api/public/media/posts/p1/a.jpg", "/api/public/media/posts/p1/b.jpg"]);
  });

  it("keeps a lone data URL whole instead of cutting it in half", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANS";
    expect(splitMediaList(dataUrl)).toEqual([dataUrl]);
  });

  it("reassembles a data URL that sits between two proxy urls", () => {
    const joined = [
      "/api/public/media/posts/p1/a.jpg",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg",
      "/api/public/media/posts/p1/b.jpg",
    ].join(",");
    expect(splitMediaList(joined)).toEqual([
      "/api/public/media/posts/p1/a.jpg",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg",
      "/api/public/media/posts/p1/b.jpg",
    ]);
  });

  it("handles two back-to-back data URLs", () => {
    const joined = "data:image/png;base64,AAA,data:image/gif;base64,BBB";
    expect(splitMediaList(joined)).toEqual([
      "data:image/png;base64,AAA",
      "data:image/gif;base64,BBB",
    ]);
  });

  it("drops empty segments and non-strings", () => {
    expect(splitMediaList("a.jpg,,b.jpg")).toEqual(["a.jpg", "b.jpg"]);
    expect(splitMediaList(null)).toEqual([]);
    expect(splitMediaList(undefined)).toEqual([]);
    expect(splitMediaList(123 as unknown as string)).toEqual([]);
  });

  it("a data URL never yields a shattering 'base64' stub token", () => {
    const parts = splitMediaList("data:image/png;base64,AAAA");
    expect(parts).not.toContain("data:image/png;base64");
    expect(parts).not.toContain("AAAA");
  });
});

describe("joinMediaList + firstMedia", () => {
  it("round-trips attachments through join then split", () => {
    const urls = ["/api/public/media/posts/p1/a.jpg", "data:image/png;base64,AAAA", "b.jpg"];
    expect(splitMediaList(joinMediaList(urls))).toEqual(urls);
  });

  it("firstMedia returns the whole first attachment, data URL included", () => {
    expect(firstMedia("data:image/png;base64,AAAA,/next.jpg")).toBe("data:image/png;base64,AAAA");
    expect(firstMedia("/a.jpg,/b.jpg")).toBe("/a.jpg");
    expect(firstMedia("")).toBeNull();
    expect(firstMedia(null)).toBeNull();
  });

  it("firstMediaUrl (explore/thumb helper) no longer shatters a data attachment", () => {
    // The old inline `.split(",")[0]` returned `data:image/png;base64` — a header
    // with no payload — so every thumbnail of a base64 post broke. It must now
    // delegate to the canonical splitter.
    expect(firstMediaUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    const utils = readFileSync(join(process.cwd(), "src", "lib", "utils.ts"), "utf8");
    expect(utils).toMatch(/function firstMediaUrl[\s\S]*?return firstMedia\(raw\);/);
  });
});

describe("every media-column reader goes through the canonical splitter", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");

  it("no surface still hand-splits a media column on the raw comma", () => {
    // These files used `.split(",")` directly on media values; each must now be
    // delegated to @/lib/media-list so a `data:` attachment stays intact.
    const files = [
      "lib/api-client.ts",
      "components/admin/AdminContentTab.tsx",
      "lib/story-viewer.ts",
      "components/admin/ReportTargetModal.tsx",
      "lib/media-cleanup.server.ts",
    ];
    for (const f of files) {
      expect(read(f), f).toContain("media-list");
    }
  });

  it("the feed card flattens attachments through splitMediaList", () => {
    const card = read("components/social/PostCard.tsx");
    expect(card).toContain("splitMediaList");
    // The fragile `src.includes(",")` branch that shattered base64 is gone.
    expect(card).not.toMatch(
      /if \(src\.includes\(","\)\)\s*\{\s*candidateUrls\.push\(\.\.\.src\.split/,
    );
  });

  it("the media key extractor never fabricates a bucket key from a data URL", async () => {
    const { mediaKeyFromUrl } = await import("@/lib/storage/provider.server");
    expect(mediaKeyFromUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(mediaKeyFromUrl("/api/public/media/posts/p1/a.jpg")).toBe("posts/p1/a.jpg");
  });
});
