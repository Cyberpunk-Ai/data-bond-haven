import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MEDIA_FOLDER_VISIBILITY,
  UPLOAD_FOLDERS,
  bucketCandidatesForPath,
  bucketForPath,
  isPrivateMediaPath,
  isPublicMediaPath,
  isUploadFolder,
  mediaBucketNames,
  visibilityOfPath,
} from "@/lib/media-folders.server";

/**
 * Three promises the product makes, each pinned where it lives:
 *
 *  1. Feed posts never expire — only the author or a moderator can delete a
 *     post; no column, trigger, function or scheduled job erases one over
 *     time. Stories stay the platform's only expiring content.
 *  2. Media lives in TWO buckets — a genuinely public one for world-readable
 *     folders and a private one for DM attachments, replays and stories —
 *     with the folder map as the single source of truth.
 *  3. The feed shows all available posts — the ranker's candidate pool is
 *     every visible post (not a truncated newest-N window), the viewer's own
 *     posts are eligible, and thrice-seen posts only replay when the unseen
 *     supply has genuinely run dry.
 */

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

function migrationNamed(part: string): string {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.includes(part));
  expect(file, `no migration matches "${part}"`).toBeTruthy();
  return readFileSync(join(MIGRATIONS_DIR, file!), "utf8");
}

// ---------------------------------------------------------------------------
// 1. Posts never expire
// ---------------------------------------------------------------------------

describe("posts never expire unless a user or admin deletes them", () => {
  const allSql = () =>
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

  it("no migration ever deletes rows from posts", () => {
    const offenders: string[] = [];
    for (const sql of allSql()) {
      // `delete from posts` in any casing/whitespace; `on delete cascade` /
      // `on delete set null` are FK clauses on OTHER tables' rows, not here.
      for (const match of sql.matchAll(/delete\s+from\s+(public\.)?posts/gi)) {
        offenders.push(match[0]);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("posts gains no expiry column and stories keeps its 24h one", () => {
    // `expires_at` may only ever appear on stories: no ALTER on posts adds
    // one, and every mention in the migration folder sits in a stories
    // statement (the column, its index, its RLS rule, its cleanup job).
    for (const sql of allSql()) {
      for (const [, table, stmt] of sql.matchAll(
        /alter table\s+(?:if exists\s+)?public\.(\w+)([^;]*);/gi,
      )) {
        if (/expires_at/i.test(stmt)) expect(table).toBe("stories");
      }
    }
    const core = migrationNamed("starpace_core_schema");
    expect(core).toMatch(/expires_at timestamptz not null default now\(\) \+ interval '24 hours'/);
  });

  it("the buckets migration re-asserts the only posts delete policy: owner or staff", () => {
    const sql = migrationNamed("media_public_private_buckets");
    expect(sql).toMatch(/create policy "posts owner delete" on public\.posts/i);
    expect(sql).toMatch(
      /for delete to authenticated using \(public\.owns_profile\(user_id\) or public\.is_staff\(\)\)/,
    );
  });

  it("the app's only scheduled jobs are media GC and stories GC", async () => {
    // Stories GC expiring rows is the product; media GC must not touch posts.
    const cronDir = join(process.cwd(), "src", "routes", "api", "public", "cron");
    const files = readdirSync(cronDir).filter((f) => f.endsWith(".ts"));
    expect(files.sort()).toEqual(["media-gc.ts", "stories-gc.ts"]);
    const stories = readFileSync(join(cronDir, "stories-gc.ts"), "utf8");
    expect(stories).toMatch(/expires_at/);
    expect(stories).not.toMatch(/from\("posts"\)[\s\S]{0,80}\.delete/);
  });
});

// ---------------------------------------------------------------------------
// 2. Public + private buckets
// ---------------------------------------------------------------------------

describe("media bucket layout", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes public folders to the public bucket and the rest to the private one", () => {
    expect(MEDIA_FOLDER_VISIBILITY.avatars).toBe("public");
    expect(MEDIA_FOLDER_VISIBILITY.posts).toBe("public");
    expect(MEDIA_FOLDER_VISIBILITY.stories).toBe("authed");
    expect(MEDIA_FOLDER_VISIBILITY.messages).toBe("private");
    expect(MEDIA_FOLDER_VISIBILITY.recordings).toBe("private");

    expect(isPublicMediaPath("posts/p1/a.jpg")).toBe(true);
    expect(isPublicMediaPath("avatars/p1/me.png")).toBe(true);
    // Authed and private are both "not world-readable".
    expect(isPublicMediaPath("stories/p1/s.mp4")).toBe(false);
    expect(isPrivateMediaPath("stories/p1/s.mp4")).toBe(true);
    expect(isPrivateMediaPath("messages/p1/f.pdf")).toBe(true);
    expect(isPrivateMediaPath("recordings/host/rec.webm")).toBe(true);
  });

  it("fails closed for an unknown folder", () => {
    expect(visibilityOfPath("secrets/p1/x.txt")).toBeNull();
    expect(isPublicMediaPath("secrets/p1/x.txt")).toBe(false);
    // An unknown folder is not a valid upload target either.
    expect(isUploadFolder("secrets")).toBe(false);
    expect(UPLOAD_FOLDERS).toContain("posts");
  });

  it("names the pair, with the pre-split bucket kept as a legacy read fallback", () => {
    vi.stubEnv("MEDIA_PUBLIC_BUCKET", "");
    vi.stubEnv("MEDIA_PRIVATE_BUCKET", "");
    vi.stubEnv("SUPABASE_MEDIA_BUCKET", "");
    const names = mediaBucketNames();
    expect(names.publicBucket).toBe("media-public");
    expect(names.privateBucket).toBe("media-private");
    expect(names.legacyBucket).toBe("media");

    expect(bucketForPath("posts/p1/a.jpg")).toBe("media-public");
    expect(bucketForPath("messages/p1/f.pdf")).toBe("media-private");

    // Lookups try the routed bucket first, then the legacy one, then the other.
    expect(bucketCandidatesForPath("posts/p1/a.jpg")).toEqual([
      "media-public",
      "media",
      "media-private",
    ]);
    expect(bucketCandidatesForPath("recordings/h/r.webm")).toEqual([
      "media-private",
      "media",
      "media-public",
    ]);
  });

  it("creates both buckets with matching policies in the migration", () => {
    const sql = migrationNamed("media_public_private_buckets");
    expect(sql).toMatch(/values \('media-public', 'media-public', true,/);
    expect(sql).toMatch(/values \('media-private', 'media-private', false,/);
    // The public bucket is readable by anybody; the private one never is.
    expect(sql).toMatch(
      /create policy "media_public read" on storage\.objects[\s\S]{0,120}for select to public/,
    );
    expect(sql).toMatch(
      /create policy "media_private read" on storage\.objects[\s\S]{0,160}for select to authenticated/,
    );
    expect(sql).toMatch(
      /\(storage\.foldername\(name\)\)\[2\] = public\.current_profile_id\(\)::text/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2b. GC must not reclaim a multi-image post's bytes
// ---------------------------------------------------------------------------

describe("media GC understands comma-joined media columns", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/storage/index.server");
    vi.doUnmock("@/integrations/supabase/client.server");
  });

  it("splits a joined cell into per-URL keys before deleting", async () => {
    const removed: string[][] = [];
    vi.doMock("@/lib/storage/index.server", () => ({
      getStorageProvider: () => ({
        delete: async (keys: string[]) => {
          removed.push(keys);
          return keys;
        },
      }),
      mediaKeyFromUrl: (u?: string) => (u ? `key:${u}` : null),
    }));
    vi.doMock("@/integrations/supabase/client.server", () => ({
      supabaseAdmin: {
        from: () => ({ delete: () => ({ in: () => Promise.resolve({ error: null }) }) }),
      },
    }));

    const { deleteStoredMedia } = await import("@/lib/media-cleanup.server");
    const joined = "/api/public/media/posts/p1/a.jpg,/api/public/media/posts/p1/b.jpg";
    const count = await deleteStoredMedia([joined]);

    // One key per image — never the joined string as a single (garbage) key.
    expect(removed[0]).toEqual([
      "key:/api/public/media/posts/p1/a.jpg",
      "key:/api/public/media/posts/p1/b.jpg",
    ]);
    expect(removed[0]).not.toContain(`key:${joined}`);
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. The ranked feed sees every available post
// ---------------------------------------------------------------------------

describe("For-you candidate pool covers every post", () => {
  const src = readFileSync(
    join(process.cwd(), "src", "lib", "recommendations.functions.ts"),
    "utf8",
  );

  it("fetches the full pool as one parallel batch (no shallow newest-400, no sequential walk)", () => {
    expect(src).not.toMatch(/\.limit\(400\)/);
    expect(src).toMatch(/POOL_CHUNK/);
    expect(src).toMatch(/POOL_MAX/);
    // The pool is walked with explicit range windows, not a shallow limit.
    expect(src).toMatch(/\.range\(i \* POOL_CHUNK, i \* POOL_CHUNK \+ POOL_CHUNK - 1\)/);
    // ...issued concurrently in a single Promise.all rather than awaited in a
    // for-loop, so a cold epoch can't stall past the client fetch timeout.
    expect(src).toMatch(/const poolBatch = await Promise\.all\(/);
    expect(src).not.toMatch(/for \(let from = 0; from < POOL_MAX;/);
  });

  it("no longer excludes the viewer's own posts from recommendation slots", () => {
    expect(src).not.toMatch(/r\.user_id !== myId/);
  });

  it("replays thrice-seen posts only when the unseen supply runs dry", () => {
    // The hard `.filter(... impressionCount ... < 3 ...)` that removed posts
    // from the pool is gone; instead unseen/replay queues fall back to each other.
    expect(src).not.toMatch(/\.filter\(\(row: any\) => \(impressionCount\.get\(row\.id\)/);
    expect(src).toMatch(/const unseen = scored\.filter/);
    expect(src).toMatch(/const replayed = scored\.filter/);
    expect(src).toMatch(
      /unseen\.length >= data\.limit \? unseen : \[\.\.\.unseen, \.\.\.replayed\]/,
    );
  });

  it("diversity cap defers a blocked post to a later pass, never drops it", () => {
    // The old single-pass `if (inWindow >= 2) continue;` permanently swallowed
    // an author's third-plus posts whenever other authors kept refilling the
    // window — the feed then claimed "all caught up" over a pool it had
    // truncated itself. A blocked item now goes to `deferred` and the loop
    // only ends when nothing is left pending.
    expect(src).not.toMatch(/if \(inWindow >= 2\) continue;/);
    expect(src).toMatch(/\(inWindow >= 2 \? deferred : placed\)\.push\(item\)/);
    expect(src).toMatch(/while \(pending\.length\)/);
    // A saturated window places ONE best leftover and re-evaluates, so the
    // cap still bounds flooding while coverage stays total.
    expect(src).toMatch(/placed\.push\(pending\[0\]\);/);
  });

  it("the end-of-feed marker shows no post count", () => {
    // The tail banner is the viewer's loaded page, not the platform total —
    // printing "(N posts)" advertised a number that never matched admin's 41.
    const feed = readFileSync(join(process.cwd(), "src", "routes", "feed.tsx"), "utf8");
    expect(feed).toMatch(/You're all caught up/);
    expect(feed).not.toMatch(/all caught up \(\$\{posts\.length\}/);
  });

  it("re-ranks the pool once per epoch, then pages from the cached snapshot", () => {
    // The compute-heavy pool walk + rescoring must run ONCE per viewer per
    // 10-minute epoch, not on every "load more". A warm page is served straight
    // from the ranked snapshot; only a cold miss (or a manual refresh) walks.
    expect(src).toMatch(/const epochBucket = Math\.floor\(Date\.now\(\) \/ RANK_EPOCH_MS\);/);
    // Cache read happens BEFORE the behaviour queries, gated on `!data.refresh`.
    const readAt = src.indexOf("snapshotFor(myId, epochBucket)");
    const queriesAt = src.indexOf('from("likes")');
    expect(readAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(queriesAt);
    expect(src).toMatch(/if \(!data\.refresh\) \{/);
    // Both return paths (recency-led and personalised) store then page from the
    // snapshot, so the shared cursor logic is identical cold vs warm.
    expect(src).toMatch(
      /rememberSnapshot\(myId, epochBucket, \{ entries: ranked, personalised: true \}\);/,
    );
    expect(src).toMatch(
      /rememberSnapshot\(myId, epochBucket, \{ entries, personalised: false \}\);/,
    );
    expect(src).toMatch(/return pageFromSnapshot\(ranked, true, data\.cursor, data\.limit\);/);
    expect(src).toMatch(
      /return pageFromSnapshot\(cached\.entries, cached\.personalised, data\.cursor, data\.limit\);/,
    );
    // No leftover inline pagination in the handler: it all routes through the
    // shared helper (the old `ranked.slice(startIdx, ...)` is gone).
    expect(src).not.toMatch(/ranked\.slice\(startIdx/);
  });
});
