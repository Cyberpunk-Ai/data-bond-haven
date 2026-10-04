import { describe, expect, it, vi } from "vitest";

import type { StorageInfo, StorageProvider } from "@/lib/storage/provider.server";
import { describeRelocate, relocateFrom } from "@/lib/storage/relocate.server";

/**
 * Relocation is tested against two in-memory stores: the whole point of the
 * feature is that keys survive the hop unchanged, and a Map proves that without
 * touching a bucket.
 */
const LEGACY: StorageInfo = { id: "supabase", label: "Supabase Storage", bucket: "media" };
const ACTIVE: StorageInfo = { id: "s3", label: "Cloudflare R2", bucket: "spaces" };

const BODY = new Uint8Array([1, 2, 3, 4]); // every fake object is 4 bytes

interface FakeOptions {
  /** Keys whose bytes cannot be read out of this store. */
  unreadable?: string[];
  /** Keys that land in the destination with the wrong size. */
  shortLanded?: string[];
  /** Keys one list() page returns. */
  pageSize?: number;
  /** Omit list() entirely, to cover a provider that cannot be enumerated. */
  listable?: boolean;
}

function fakeProvider(
  info: StorageInfo,
  entries: Record<string, string> = {},
  options: FakeOptions = {},
) {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  for (const [key, contentType] of Object.entries(entries)) {
    objects.set(key, { body: BODY, contentType });
  }
  const calls = { put: [] as string[], get: [] as string[], keys: [] as string[] };
  const sortedKeys = () => [...objects.keys()].sort();

  const provider: StorageProvider & { calls: typeof calls } = {
    info,
    calls,
    async put(key, body, contentType) {
      calls.put.push(key);
      objects.set(key, {
        body: options.shortLanded?.includes(key) ? new Uint8Array([1]) : new Uint8Array(body),
        contentType,
      });
      return { key };
    },
    async get(key) {
      calls.get.push(key);
      if (options.unreadable?.includes(key)) throw new Error("access denied");
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        body: hit.body,
        contentType: hit.contentType,
        totalSize: hit.body.byteLength,
        partial: false,
      };
    },
    async getRange(key) {
      return this.get(key);
    },
    async stat(key) {
      const hit = objects.get(key);
      return hit ? { size: hit.body.byteLength, contentType: hit.contentType } : null;
    },
    async delete(keys) {
      const removed: string[] = [];
      for (const key of keys) if (objects.delete(key)) removed.push(key);
      return removed;
    },
    async verifyAccess() {
      return { ok: true };
    },
  };

  if (options.listable !== false) {
    provider.list = async (cursor) => {
      const size = options.pageSize ?? 100;
      const start = cursor ? Number(cursor) : 0;
      const all = sortedKeys();
      const keys = all.slice(start, start + size);
      calls.keys.push(...keys);
      const next = start + size;
      return { keys, nextCursor: next < all.length ? String(next) : null };
    };
  }
  return provider;
}

describe("relocateFrom", () => {
  it("copies the objects the active bucket is missing, under the same key", async () => {
    const source = fakeProvider(LEGACY, {
      "avatars/1/old.png": "image/png",
      "posts/1/older.mp4": "video/mp4",
    });
    const target = fakeProvider(ACTIVE, { "posts/1/older.mp4": "video/mp4" });

    const report = await relocateFrom(source, target);
    expect(report.copied).toBe(1);
    expect(report.alreadyThere).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.exhausted).toBe(true);
    expect(target.calls.put).toEqual(["avatars/1/old.png"]);

    // The bytes landed unchanged and the content type travelled with them.
    const moved = await target.get("avatars/1/old.png");
    expect(moved?.body).toEqual(BODY);
    expect(moved?.contentType).toBe("image/png");
  });

  it("never overwrites an object that already exists in the active bucket", async () => {
    const source = fakeProvider(LEGACY, { "posts/1/a.png": "image/png" });
    const target = fakeProvider(ACTIVE, {});
    await target.put("posts/1/a.png", new Uint8Array([9, 9, 9]), "image/png");
    target.calls.put = [];

    const report = await relocateFrom(source, target);
    expect(report.copied).toBe(0);
    expect(report.alreadyThere).toBe(1);
    expect(target.calls.put).toEqual([]);
    // The live object is still the one the platform wrote after the switch.
    expect((await target.get("posts/1/a.png"))?.body).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("deletes nothing, so an interrupted run can simply be repeated", async () => {
    const source = fakeProvider(LEGACY, { "a/1.png": "image/png", "a/2.png": "image/png" });
    const target = fakeProvider(ACTIVE, {});

    const first = await relocateFrom(source, target, { limit: 1 });
    expect(first.copied).toBe(1);
    expect(first.exhausted).toBe(false);

    const second = await relocateFrom(source, target, { limit: 5 });
    expect(second.alreadyThere).toBe(1);
    expect(second.copied).toBe(1);
    expect(second.exhausted).toBe(true);

    // Nothing leaves the source, so a repeat run sees the same objects again.
    expect(await source.stat("a/1.png")).not.toBeNull();
    expect(await source.stat("a/2.png")).not.toBeNull();
    expect(target.calls.put).toHaveLength(2);
  });

  it("counts what would move in a dry run without writing", async () => {
    const source = fakeProvider(LEGACY, {
      "posts/1/a.png": "image/png",
      "posts/1/b.png": "image/png",
    });
    const target = fakeProvider(ACTIVE, { "posts/1/a.png": "image/png" });

    const report = await relocateFrom(source, target, { dryRun: true });
    expect(report.missing).toBe(1);
    expect(report.copied).toBe(0);
    expect(report.bytes).toBe(0);
    expect(target.calls.put).toEqual([]);
    expect(source.calls.get).toEqual([]); // a dry run must not download anything
  });

  it("stops at the byte budget so one request cannot fill memory", async () => {
    const source = fakeProvider(LEGACY, {
      "a/1.png": "image/png",
      "a/2.png": "image/png",
      "a/3.png": "image/png", // 4 bytes each, so 8 bytes is two objects
    });
    const target = fakeProvider(ACTIVE, {});

    const report = await relocateFrom(source, target, { maxBytes: 8 });
    expect(report.copied).toBe(2);
    expect(report.bytes).toBe(8);
    expect(report.exhausted).toBe(false);
  });

  it("walks every list page, so a bucket larger than one page still drains", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 7; i++) entries[`posts/1/${i}.png`] = "image/png";
    const source = fakeProvider(LEGACY, entries, { pageSize: 2 });
    const target = fakeProvider(ACTIVE, {});

    const report = await relocateFrom(source, target);
    expect(report.scanned).toBe(7);
    expect(report.copied).toBe(7);
    expect(report.exhausted).toBe(true);
  });

  it("keeps going when a single object fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = fakeProvider(
      LEGACY,
      {
        "posts/1/a.png": "image/png",
        "posts/1/broken.png": "image/png",
        "posts/1/c.png": "image/png",
      },
      { unreadable: ["posts/1/broken.png"] },
    );
    const target = fakeProvider(ACTIVE, {});

    const report = await relocateFrom(source, target);
    expect(report.failed).toBe(1);
    expect(report.copied).toBe(2);
    expect(report.exhausted).toBe(true);
    expect(target.calls.put).toEqual(["posts/1/a.png", "posts/1/c.png"]);
    error.mockRestore();
  });

  it("reports a failed copy when the destination lands the wrong size", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = fakeProvider(LEGACY, {
      "posts/1/a.png": "image/png",
      "posts/1/b.png": "image/png",
    });
    const target = fakeProvider(ACTIVE, {}, { shortLanded: ["posts/1/a.png"] });

    const report = await relocateFrom(source, target);
    expect(report.failed).toBe(1);
    expect(report.copied).toBe(1);
    expect(report.bytes).toBe(4);
    error.mockRestore();
  });

  it("skips housekeeping keys that no row can reference", async () => {
    const source = fakeProvider(LEGACY, {
      ".spaces1-access-probe": "text/plain",
      "../escape.png": "image/png",
      "posts/1/a.png": "image/png",
    });
    const target = fakeProvider(ACTIVE, {});

    const report = await relocateFrom(source, target);
    expect(report.scanned).toBe(1);
    expect(target.calls.put).toEqual(["posts/1/a.png"]);
  });

  it("refuses to copy a bucket onto itself", async () => {
    const source = fakeProvider(LEGACY, { "posts/1/a.png": "image/png" });
    const report = await relocateFrom(
      source,
      fakeProvider(LEGACY, { "posts/1/a.png": "image/png" }),
    );
    expect(report.detail).toContain("same bucket");
    expect(report.scanned).toBe(0);
  });

  it("says so when a provider cannot be enumerated instead of claiming success", async () => {
    const source = fakeProvider(LEGACY, {}, { listable: false });
    const report = await relocateFrom(source, fakeProvider(ACTIVE, {}));
    expect(report.detail).toContain("cannot be enumerated");
    expect(report.exhausted).toBe(false);
  });
});

describe("describeRelocate", () => {
  it("reads as one line per hop", async () => {
    const source = fakeProvider(LEGACY, { "posts/1/a.png": "image/png" });
    const report = await relocateFrom(source, fakeProvider(ACTIVE, {}));
    const line = describeRelocate(report);
    expect(line).toContain('Supabase Storage "media" → Cloudflare R2 "spaces"');
    expect(line).toContain("copied 1 objects");
    expect(describeRelocate({ ...report, copied: 0, missing: 1 }, true)).toContain("still missing");
  });
});
