import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageInfo, StorageProvider } from "@/lib/storage/provider.server";
import { readRangeIntent } from "@/lib/media-range.server";
import { resolveS3Config } from "@/lib/storage/s3.server";

// Storage selection is intentionally driven only by the environment, so the
// tests set/clear process.env and reset the module cache between cases.
const S3_KEYS = [
  "STORAGE_PROVIDER",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_REGION",
  "S3_PATH_STYLE",
  "S3_PUBLIC_BASE_URL",
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_REGION",
  "R2_PUBLIC_BASE_URL",
  "SUPABASE_MEDIA_BUCKET",
  "VITE_MEDIA_BUCKET",
  "MEDIA_PUBLIC_BUCKET",
  "MEDIA_PRIVATE_BUCKET",
  "SUPABASE_MEDIA_PUBLIC_BUCKET",
  "SUPABASE_MEDIA_PRIVATE_BUCKET",
  "S3_PUBLIC_BUCKET",
  "R2_PUBLIC_BUCKET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VITE_SUPABASE_URL",
];

function clearEnv() {
  for (const key of S3_KEYS) delete process.env[key];
  vi.resetModules();
}

// aws4fetch hands `fetch` a constructed Request, so read the URL off it.
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function loadIndex() {
  return import("@/lib/storage/index.server");
}

describe("resolveS3Config", () => {
  beforeEach(clearEnv);

  it("is unconfigured with no credentials", () => {
    expect(resolveS3Config()).toBeNull();
  });

  it("needs endpoint (or account id), bucket and both keys", () => {
    process.env.S3_BUCKET = "media";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    expect(resolveS3Config()).toBeNull(); // no endpoint yet

    process.env.S3_ENDPOINT = "https://s3.example.com/";
    const cfg = resolveS3Config();
    expect(cfg).not.toBeNull();
    expect(cfg!.endpoint).toBe("https://s3.example.com"); // trailing slash trimmed
    expect(cfg!.pathStyle).toBe(true); // default
    expect(cfg!.region).toBe("auto");
  });

  it("reads R2_* aliases and derives the R2 endpoint from the account id", () => {
    process.env.R2_ACCOUNT_ID = "abc123";
    process.env.R2_BUCKET = "spaces";
    process.env.R2_ACCESS_KEY_ID = "ak";
    process.env.R2_SECRET_ACCESS_KEY = "sk";
    const cfg = resolveS3Config();
    expect(cfg?.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
    expect(cfg?.bucket).toBe("spaces");
  });

  it("prefers canonical S3_* names over the aliases", () => {
    process.env.S3_ENDPOINT = "https://minio.lan:9000";
    process.env.S3_BUCKET = "primary";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    process.env.R2_BUCKET = "ignored";
    expect(resolveS3Config()?.bucket).toBe("primary");
  });

  it("honours an explicit virtual-host toggle and public base url", () => {
    process.env.S3_ENDPOINT = "https://s3.amazonaws.com";
    process.env.S3_BUCKET = "b";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    process.env.S3_PATH_STYLE = "false";
    process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.com/";
    const cfg = resolveS3Config();
    expect(cfg?.pathStyle).toBe(false);
    expect(cfg?.publicBaseUrl).toBe("https://cdn.example.com/");
  });
});

describe("storage backend selection", () => {
  beforeEach(clearEnv);

  it("uses the S3 provider when credentials are present", async () => {
    process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.S3_BUCKET = "media";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(mod.storageBackendName()).toBe("s3");
    expect(mod.getStorageProvider().info.label).toBe("Cloudflare R2");
    expect(mod.getStorageProvider().info.bucket).toBe("media");
  });

  it("falls back to Supabase when no object-store credentials exist", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(mod.storageBackendName()).toBe("supabase");
  });

  it("STORAGE_PROVIDER=supabase wins even with S3 credentials configured", async () => {
    process.env.STORAGE_PROVIDER = "supabase";
    process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.S3_BUCKET = "media";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(mod.storageBackendName()).toBe("supabase");
  });

  it("rebuilds the provider when credentials change under it", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(mod.storageBackendName()).toBe("supabase");

    process.env.S3_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
    process.env.S3_BUCKET = "media";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    expect(mod.storageBackendName()).toBe("s3");
    expect(mod.getStorageProvider().info.label).toBe("DigitalOcean Spaces");
  });

  it("loudly falls back when a provider is named but not configured", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.STORAGE_PROVIDER = "r2";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(mod.storageBackendName()).toBe("supabase");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("STORAGE_PROVIDER=r2"));
    error.mockRestore();
  });
});

describe("S3 object operations", () => {
  beforeEach(clearEnv);

  function configureS3(pathStyle = true) {
    process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.S3_BUCKET = "media";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    process.env.S3_PATH_STYLE = String(pathStyle);
  }

  it("signs a ranged GET and reports partial reads with the total size", async () => {
    configureS3();
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(urlOf(input));
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { "content-type": "video/mp4", "content-range": "bytes 10-12/12345" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl as never);

    const mod = await loadIndex();
    mod.resetStorageProvider();
    const provider = mod.getStorageProvider();
    const read = await provider.getRange("recordings/a/b.mp4", 10, 12);
    expect(seen[0]).toContain("/media/recordings/a/b.mp4");
    expect(read?.partial).toBe(true);
    expect(read?.totalSize).toBe(12345);
    expect(read?.body).toHaveLength(3);
    expect(read?.contentType).toBe("video/mp4");
    vi.unstubAllGlobals();
  });

  it("treats a missing object as null rather than an error", async () => {
    configureS3();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })) as never);
    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(await mod.getStorageProvider().get("posts/nope.png")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("reports unhealthy credentials without writing anything", async () => {
    configureS3();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(urlOf(input));
        return new Response(null, { status: 403 });
      }) as never,
    );
    const mod = await loadIndex();
    mod.resetStorageProvider();
    const status = await mod.storageStatus();
    expect(status.ok).toBe(false);
    expect(status.detail).toContain("credentials rejected");
    expect(status.id).toBe("s3");
    expect(calls.every((u) => u.includes("spaces1-access-probe"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("builds virtual-host URLs when path style is off", async () => {
    configureS3(false);
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(urlOf(input));
        return new Response(new Uint8Array([9]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "1" },
        });
      }) as never,
    );
    const mod = await loadIndex();
    mod.resetStorageProvider();
    await mod.getStorageProvider().get("avatars/me.png");
    expect(seen[0]).toBe("https://media.acct.r2.cloudflarestorage.com/avatars/me.png");
    vi.unstubAllGlobals();
  });

  it("only produces a public URL when a public base is configured", async () => {
    configureS3();
    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(mod.getStorageProvider().publicUrl!("posts/x.png")).toBeNull();

    process.env.S3_PUBLIC_BASE_URL = "https://cdn.spaces1.com";
    mod.resetStorageProvider();
    expect(mod.getStorageProvider().publicUrl!("posts/x y.png")).toBe(
      "https://cdn.spaces1.com/posts/x%20y.png",
    );
  });

  it("routes public writes to the public bucket when the token reaches both", async () => {
    configureS3();
    process.env.S3_PUBLIC_BUCKET = "media-public";
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(urlOf(input));
        return new Response(null, { status: 200 });
      }) as never,
    );
    const mod = await loadIndex();
    mod.resetStorageProvider();
    await mod.getStorageProvider().put("posts/x.png", new Uint8Array([1]), "image/png");
    // A reachable public bucket takes the world-readable key directly.
    expect(seen[0]).toContain("/media-public/posts/x.png");
    vi.unstubAllGlobals();
  });

  it("falls back to the primary bucket when a public-bucket write is refused", async () => {
    configureS3();
    // A token scoped to only the private bucket answers 403 for the public one.
    process.env.S3_PUBLIC_BUCKET = "media-public";
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const method = (input as Request).method;
        const url = urlOf(input);
        seen.push(`${method} ${url}`);
        if (method === "PUT") {
          return url.includes("/media-public/")
            ? new Response(null, { status: 403 })
            : new Response(null, { status: 200 });
        }
        // Reads miss everywhere so every candidate bucket is visited in turn.
        return new Response(null, { status: 404 });
      }) as never,
    );
    const mod = await loadIndex();
    mod.resetStorageProvider();
    const provider = mod.getStorageProvider();

    // A half-configured switch must never fail the upload: it lands in primary.
    await expect(provider.put("posts/x.png", new Uint8Array([1]), "image/png")).resolves.toEqual({
      key: "posts/x.png",
    });
    expect(seen).toContain("PUT https://acct.r2.cloudflarestorage.com/media-public/posts/x.png");
    expect(seen).toContain("PUT https://acct.r2.cloudflarestorage.com/media/posts/x.png");

    // Once the public bucket is marked down, reads still try it — an object
    // that landed there before the fallback must not disappear: primary first,
    // then the public bucket as a fallback.
    seen.length = 0;
    await provider.get("posts/x.png");
    expect(seen[0]).toBe("GET https://acct.r2.cloudflarestorage.com/media/posts/x.png");
    expect(seen).toContain("GET https://acct.r2.cloudflarestorage.com/media-public/posts/x.png");
    vi.unstubAllGlobals();
  });

  it("lists the bucket and unescapes keys the XML carried encoded", async () => {
    configureS3();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        seen.push(url);
        return new Response(
          `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<Name>media</Name><KeyCount>2</KeyCount><IsTruncated>false</IsTruncated>` +
            `<Contents><Key>posts/a&amp;b.png</Key><Size>4</Size></Contents>` +
            `<Contents><Key>avatars/\u00e9t\u00e9.jpg</Key><Size>9</Size></Contents>` +
            `</ListBucketResult>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }) as never,
    );

    const mod = await loadIndex();
    mod.resetStorageProvider();
    const page = await mod.getStorageProvider().list!(null);
    // The list lives at the bucket root, not on an object.
    expect(seen[0]).toContain("/media/?");
    expect(seen[0]).toContain("list-type=2");
    expect(page.keys).toEqual(["posts/a&b.png", "avatars/été.jpg"]);
    expect(page.nextCursor).toBeNull();
    vi.unstubAllGlobals();
  });

  it("passes a truncation token back as the next cursor", async () => {
    configureS3();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        seen.push(url);
        return new Response(
          `<ListBucketResult><Contents><Key>posts/a.png</Key></Contents>` +
            `<IsTruncated>true</IsTruncated><NextContinuationToken>tok+123</NextContinuationToken>` +
            `</ListBucketResult>`,
          { status: 200 },
        );
      }) as never,
    );

    const mod = await loadIndex();
    mod.resetStorageProvider();
    const page = await mod.getStorageProvider().list!(null);
    expect(page.keys).toEqual(["posts/a.png"]);
    // The cursor is an opaque token, but it has to carry the live continuation
    // token and the bucket the walk stopped in.
    expect(JSON.parse(page.nextCursor!)).toEqual({ bucketIndex: 0, token: "tok+123" });

    await mod.getStorageProvider().list!(page.nextCursor);
    expect(seen[1]).toContain("continuation-token=tok%2B123");
    vi.unstubAllGlobals();
  });

  it("surfaces a listing failure instead of reporting an empty bucket", async () => {
    configureS3();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })) as never);
    const mod = await loadIndex();
    mod.resetStorageProvider();
    await expect(mod.getStorageProvider().list!(null)).rejects.toThrow(/listing failed \(403\)/);
    vi.unstubAllGlobals();
  });

  it("reports an enumerable mirror and a primary-only list through the read mirror", async () => {
    configureS3();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    const legacyList = vi.fn(async () => ({ keys: ["posts/old.png"], nextCursor: null }));
    vi.doMock("@/lib/storage/supabase.server", () => ({
      createSupabaseProvider: () => ({
        info: { id: "supabase", label: "Supabase Storage", bucket: "media" },
        put: vi.fn(),
        get: vi.fn(),
        getRange: vi.fn(),
        stat: vi.fn(),
        delete: vi.fn(),
        verifyAccess: vi.fn(async () => ({ ok: true })),
        list: legacyList,
      }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`, {
            status: 200,
          }),
      ) as never,
    );

    const mod = await loadIndex();
    mod.resetStorageProvider();
    // Relocation needs to see the legacy store on its own, not merged into the
    // active one — and listing the merged provider must stay primary-only.
    expect(mod.legacyStorageProviders()).toHaveLength(1);
    expect(await mod.getStorageProvider().list!(null)).toEqual({ keys: [], nextCursor: null });
    expect(legacyList).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/storage/supabase.server");
    vi.unstubAllGlobals();
  });
});

describe("Supabase bucket listing", () => {
  // Supabase lists one folder at a time and reports sub-folders as id-less
  // entries, so the walk has to descend without returning folder names as keys.
  const TREE: Record<string, Array<{ name: string; id?: string }>> = {
    "": [{ name: "root.txt", id: "f0" }, { name: "avatars" }, { name: "posts" }],
    avatars: [{ name: "a.png", id: "f1" }],
    posts: [
      { name: "p1.png", id: "f2" },
      { name: "p2.png", id: "f3" },
    ],
  };

  beforeEach(clearEnv);

  it("walks every folder and returns only object keys", async () => {
    // Only the legacy bucket holds bytes here; the walk must still visit the
    // routed buckets first and finish with each key exactly once.
    vi.doMock("@/integrations/supabase/client.server", () => ({
      supabaseAdmin: {
        storage: {
          from: (bucketName: string) => ({
            list: async (prefix: string, opts: { limit: number; offset: number }) => ({
              data:
                bucketName === "media"
                  ? (TREE[prefix] ?? []).slice(opts.offset, opts.offset + opts.limit)
                  : [],
              error: null,
            }),
          }),
        },
      },
    }));

    const mod = await import("@/lib/storage/supabase.server");
    const provider = mod.createSupabaseProvider();
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await provider.list!(cursor);
      collected.push(...page.keys);
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(collected.sort()).toEqual(["avatars/a.png", "posts/p1.png", "posts/p2.png", "root.txt"]);
    expect(cursor).toBeNull();
    vi.doUnmock("@/integrations/supabase/client.server");
  });

  it("reports a listing failure rather than an empty bucket", async () => {
    vi.doMock("@/integrations/supabase/client.server", () => ({
      supabaseAdmin: {
        storage: {
          from: () => ({
            list: async () => ({ data: null, error: { message: "bucket not found" } }),
          }),
        },
      },
    }));
    const mod = await import("@/lib/storage/supabase.server");
    await expect(mod.createSupabaseProvider().list!(null)).rejects.toThrow("bucket not found");
    vi.doUnmock("@/integrations/supabase/client.server");
  });
});

describe("read mirror for a backend switch", () => {
  const SB_INFO: StorageInfo = { id: "supabase", label: "Supabase Storage", bucket: "media" };
  const LEGACY_MODULE = "@/lib/storage/supabase.server";

  function configureS3Env() {
    process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.S3_BUCKET = "media";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
  }

  // The legacy store is standing in for Supabase Storage: the real client needs
  // network access, and the mirror's job is only to *try* the other provider.
  function fakeProvider(info: StorageInfo, entries: Record<string, string> = {}) {
    const objects = new Map(Object.entries(entries));
    const calls: string[] = [];
    const provider: StorageProvider & { calls: string[] } = {
      info,
      calls,
      async put(key, _body, contentType) {
        calls.push(`put:${key}`);
        objects.set(key, contentType);
        return { key };
      },
      async get(key) {
        calls.push(`get:${key}`);
        const hit = objects.get(key);
        if (!hit) return null;
        return {
          body: new Uint8Array([7, 7]),
          contentType: hit,
          totalSize: 2,
          partial: false,
        };
      },
      async getRange(key) {
        calls.push(`getRange:${key}`);
        return this.get(key);
      },
      async stat(key) {
        calls.push(`stat:${key}`);
        const hit = objects.get(key);
        return hit ? { size: 2, contentType: hit } : null;
      },
      async delete(keys) {
        const removed: string[] = [];
        for (const key of keys) {
          calls.push(`delete:${key}`);
          if (objects.delete(key)) removed.push(key);
        }
        return removed;
      },
      async verifyAccess() {
        calls.push("verifyAccess");
        return { ok: true };
      },
    };
    return provider;
  }

  function mockLegacy(legacy: StorageProvider) {
    vi.doMock(LEGACY_MODULE, () => ({ createSupabaseProvider: () => legacy }));
  }

  beforeEach(() => {
    vi.doUnmock(LEGACY_MODULE);
    clearEnv();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  });

  afterEach(() => {
    vi.doUnmock(LEGACY_MODULE);
    vi.unstubAllGlobals();
  });

  it("serves objects the new backend does not have from the legacy store", async () => {
    const legacy = fakeProvider(SB_INFO, { "posts/old.png": "image/png" });
    mockLegacy(legacy);
    configureS3Env();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })) as never);

    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(mod.storageBackendName()).toBe("s3");

    const read = await mod.getStorageProvider().get("posts/old.png");
    expect(read?.contentType).toBe("image/png");
    expect(read?.body).toEqual(new Uint8Array([7, 7]));
    expect(legacy.calls).toContain("get:posts/old.png");
  });

  it("warns once per mirror, not once per object", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacy = fakeProvider(SB_INFO, {
      "posts/a.png": "image/png",
      "posts/b.png": "image/png",
    });
    mockLegacy(legacy);
    configureS3Env();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })) as never);

    const mod = await loadIndex();
    mod.resetStorageProvider();
    await mod.getStorageProvider().get("posts/a.png");
    await mod.getStorageProvider().get("posts/b.png");

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("legacy"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("writes only to the active backend, and deletes from both", async () => {
    const legacy = fakeProvider(SB_INFO, { "posts/old.png": "image/png" });
    mockLegacy(legacy);
    configureS3Env();
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        methods.push(input instanceof Request ? input.method : "GET");
        return new Response(null, { status: 200 });
      }) as never,
    );

    const mod = await loadIndex();
    mod.resetStorageProvider();
    const provider = mod.getStorageProvider();

    await provider.put("posts/new.png", new Uint8Array([1]), "image/png");
    expect(legacy.calls).not.toContain("put:posts/new.png");

    const removed = await provider.delete(["posts/old.png"]);
    expect(legacy.calls).toContain("delete:posts/old.png");
    expect(removed).toEqual(["posts/old.png"]); // one copy, reported once
  });

  it("mirrors in the other direction when Supabase is pinned as primary", async () => {
    const legacy = fakeProvider(SB_INFO);
    mockLegacy(legacy);
    process.env.STORAGE_PROVIDER = "supabase";
    configureS3Env();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([3]), {
            status: 200,
            headers: { "content-type": "image/jpeg", "content-length": "1" },
          }),
      ) as never,
    );

    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(mod.storageBackendName()).toBe("supabase");

    const read = await mod.getStorageProvider().get("posts/x.jpg");
    expect(read?.contentType).toBe("image/jpeg");
    expect(legacy.calls).toContain("get:posts/x.jpg");
  });

  it("reports the mirror in the admin status without leaking credentials", async () => {
    const legacy = fakeProvider(SB_INFO);
    mockLegacy(legacy);
    configureS3Env();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })) as never);

    const mod = await loadIndex();
    mod.resetStorageProvider();
    const status = await mod.storageStatus();
    expect(status.id).toBe("s3");
    expect(status.mirrors).toHaveLength(1);
    expect(status.mirrors[0].label).toBe("Supabase Storage");
    expect(status.mirrors[0].ok).toBe(true);
    expect(JSON.stringify(status)).not.toContain("sk");
  });

  it("does not mirror when the legacy store is not configured", async () => {
    configureS3Env();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchImpl as never);

    const mod = await loadIndex();
    mod.resetStorageProvider();
    expect(await mod.getStorageProvider().get("posts/old.png")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("readRangeIntent", () => {
  it("parses the shapes players actually send", () => {
    expect(readRangeIntent("bytes=0-1023")).toEqual({ start: 0, end: 1023 });
    expect(readRangeIntent("bytes=2048-")).toEqual({ start: 2048 });
    expect(readRangeIntent("bytes=-512")).toEqual({ suffix: 512 });
    expect(readRangeIntent("BYTES=0-10")).toEqual({ start: 0, end: 10 });
    expect(readRangeIntent("  bytes=5-9  ")).toEqual({ start: 5, end: 9 });
  });

  it("declines anything ambiguous so the caller serves the whole object", () => {
    expect(readRangeIntent(null)).toBeNull();
    expect(readRangeIntent("")).toBeNull();
    expect(readRangeIntent("items=0-1")).toBeNull();
    expect(readRangeIntent("bytes=0-1,4-5")).toBeNull();
    expect(readRangeIntent("bytes=abc-def")).toBeNull();
    expect(readRangeIntent("bytes=10-5")).toBeNull();
    expect(readRangeIntent("bytes=-0")).toBeNull();
    expect(readRangeIntent("bytes=-")).toBeNull();
  });
});
