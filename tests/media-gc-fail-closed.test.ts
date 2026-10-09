import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The nightly media GC is the only automated thing that deletes stored bytes,
 * so a bug here silently destroys live photos/videos. These tests pin the
 * guarantees that stop "media that used to work is now gone":
 *
 *   1. PERMANENT feed media (posts/ and the legacy media/ folder) is NEVER
 *      reclaimed by the GC — even when it looks unreferenced — so a post's
 *      images/videos survive for decades regardless of the scan.
 *   2. Fail CLOSED — an incomplete reference scan (any read error) reclaims
 *      nothing, so a transient blip can't wipe a table's media.
 *   3. PAGED — references beyond the first page still count as live, so a
 *      growing table can't have its older rows treated as unreferenced.
 *   4. Replaceable/expiring folders (avatars, stories, messages) DO get
 *      reclaimed when genuinely orphaned — permanence is scoped to the feed.
 */

// A storage key is the tail of the /api/public/media/<key> url the app stores.
function keyFromUrl(url: string): string | null {
  const m = /^\/api\/public\/media\/(.+)$/.exec(url.trim());
  return m ? m[1] : null;
}

interface ScanScript {
  [table: string]: Array<Record<string, unknown>>;
}

function makeDb(objects: Array<{ path: string }>, scans: ScanScript, failTables: string[] = []) {
  const rangeCalls: Array<[string, number, number]> = [];
  const db = {
    from(table: string) {
      if (table === "media_objects") {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.lt = () => Promise.resolve({ data: objects, error: null });
        b.delete = () => ({ in: () => Promise.resolve({ error: null }) });
        return b;
      }
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.not = chain;
      builder.order = chain;
      builder.range = (from: number, to: number) => {
        rangeCalls.push([table, from, to]);
        if (failTables.includes(table)) {
          return Promise.resolve({ data: null, error: { message: "read failed" } });
        }
        const all = scans[table] ?? [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      };
      return builder;
    },
    rpc: () => Promise.resolve({ error: null }),
  };
  return { db, rangeCalls };
}

async function loadGc(objects: Array<{ path: string }>, scans: ScanScript, failTables: string[]) {
  const removed: string[][] = [];
  vi.doMock("@/lib/storage/index.server", () => ({
    getStorageProvider: () => ({
      delete: async (keys: string[]) => {
        removed.push(keys);
        return keys;
      },
    }),
    mediaKeyFromUrl: (u?: string) => (u ? keyFromUrl(u) : null),
  }));
  const { db, rangeCalls } = makeDb(objects, scans, failTables);
  vi.doMock("@/integrations/supabase/client.server", () => ({ adminDb: () => db }));

  const { runMediaGarbageCollection } = await import("@/lib/media-cleanup.server");
  const result = await runMediaGarbageCollection(3600);
  return { result, removed, rangeCalls };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/storage/index.server");
  vi.doUnmock("@/integrations/supabase/client.server");
});

describe("permanent feed media is never reclaimed", () => {
  it("skips posts/ and legacy media/ even when nothing references them, but still reclaims an orphaned avatar", async () => {
    const { result, removed } = await loadGc(
      [
        { path: "posts/p1/forever.jpg" }, // permanent feed media
        { path: "posts/p1/video.mp4" }, // permanent feed media (video)
        { path: "media/p1/legacy.jpg" }, // permanent (pre-split) feed media
        { path: "avatars/w1/old.png" }, // replaceable → reclaimable
      ],
      {}, // no references anywhere
      [],
    );

    // Only the avatar is eligible; posts/ and media/ are structurally exempt.
    expect(removed.flat()).toEqual(["avatars/w1/old.png"]);
    expect(removed.flat()).not.toContain("posts/p1/forever.jpg");
    expect(removed.flat()).not.toContain("posts/p1/video.mp4");
    expect(removed.flat()).not.toContain("media/p1/legacy.jpg");
    expect(result.deleted).toBe(1);
  });

  it("reclaims NOTHING when the only tracked objects are permanent feed media", async () => {
    const { result, removed } = await loadGc(
      [{ path: "posts/p1/a.jpg" }, { path: "media/p1/b.mp4" }],
      {},
      [],
    );
    expect(removed).toEqual([]);
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe("media GC fails closed on an incomplete reference scan", () => {
  it("reclaims NOTHING when a reclaimable column read errors, protecting live media", async () => {
    const { result, removed } = await loadGc(
      [{ path: "messages/p1/live.jpg" }],
      // messages DOES reference it, but the read is forced to fail.
      { messages: [{ media_url: "/api/public/media/messages/p1/live.jpg" }] },
      ["messages"],
    );

    expect(removed).toEqual([]); // never even called provider.delete
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("deletes only a genuinely unreferenced reclaimable object when scans succeed", async () => {
    const { result, removed } = await loadGc(
      [{ path: "messages/p1/live.jpg" }, { path: "messages/p1/orphan.jpg" }],
      { messages: [{ media_url: "/api/public/media/messages/p1/live.jpg" }] },
      [],
    );

    expect(removed.flat()).toEqual(["messages/p1/orphan.jpg"]);
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
  });
});

describe("media GC pages its reference scan", () => {
  it("reads beyond the first 1000 rows so older references stay protected", async () => {
    // 1000 referenced stories on page one, 3 more on page two, plus one orphan.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      media_url: `/api/public/media/stories/p1/a${i}.jpg`,
    }));
    const page2 = Array.from({ length: 3 }, (_, i) => ({
      media_url: `/api/public/media/stories/p1/b${i}.jpg`,
    }));
    const objects = [
      ...page1.map((r) => ({ path: keyFromUrl(r.media_url)! })),
      ...page2.map((r) => ({ path: keyFromUrl(r.media_url)! })),
      { path: "stories/p1/orphan.jpg" },
    ];

    const { result, removed, rangeCalls } = await loadGc(
      objects,
      { stories: [...page1, ...page2] },
      [],
    );

    // The second page was actually requested (offset 1000) — without paging
    // those 3 live stories would have been reclaimed.
    expect(rangeCalls.some(([t, from]) => t === "stories" && from === 1000)).toBe(true);
    expect(removed.flat()).toEqual(["stories/p1/orphan.jpg"]);
    expect(result.deleted).toBe(1);
  });
});

describe("media GC understands every media column", () => {
  it("protects a workspace logo referenced only by workspaces.avatar_url", async () => {
    const { result, removed } = await loadGc(
      [{ path: "avatars/w1/logo.png" }],
      { workspaces: [{ avatar_url: "/api/public/media/avatars/w1/logo.png" }] },
      [],
    );

    expect(removed).toEqual([]);
    expect(result.deleted).toBe(0);
  });
});
