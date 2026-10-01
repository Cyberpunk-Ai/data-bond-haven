/**
 * Generic S3-compatible object storage.
 *
 * One implementation covers every provider the platform might be pointed at —
 * Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Wasabi, MinIO, AWS S3 —
 * because they all speak the same signed HTTP API. `aws4fetch` does the SigV4
 * signing and is runtime-agnostic (Node, Workers, Bun), so there is no SDK to
 * install and nothing Node-specific to polyfill.
 *
 * The whole point is that switching stores is an environment change, never a
 * code change: fill in `S3_*` (or the `R2_*` aliases) and
 * `getStorageProvider()` picks this up. Everything else in the app talks to
 * {@link StorageProvider}.
 */
import { AwsClient } from "aws4fetch";
import type {
  StorageProvider,
  StorageProbe,
  StorageRead,
  StorageStat,
} from "@/lib/storage/provider.server";
import { isPublicMediaPath } from "@/lib/media-folders.server";

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Bucket in the URL path (default) vs a bucket-prefixed host. */
  pathStyle: boolean;
  /** Optional public/CDN hostname that mirrors the bucket read-only. */
  publicBaseUrl?: string;
  /**
   * Optional second bucket holding only the world-readable folders, so its
   * public domain can never serve a DM attachment or a Space replay. Left unset
   * keeps one bucket and the proxy decides visibility, as before.
   */
  publicBucket?: string;
  /**
   * True once the public bucket proves unusable (missing, or a token scoped to
   * the other bucket cannot reach it — R2 tokens are per-bucket). Writes then
   * stay in the primary bucket, where the read proxy still serves them with
   * the correct visibility, so a half-configured R2 switch never fails an
   * upload.
   */
  publicBucketDown?: boolean;
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function flag(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

/**
 * `S3_*` is canonical; `R2_*` is kept as an alias so the credentials already
 * documented for Cloudflare keep working unchanged.
 */
export function resolveS3Config(): S3Config | null {
  const accessKeyId = env("S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY");
  const bucket = env("S3_BUCKET", "R2_BUCKET");
  if (!accessKeyId || !secretAccessKey || !bucket) return null;

  // R2 can derive its endpoint from the account id, which is the friendliest
  // entry path: account id + bucket + a bucket-scoped token.
  const accountId = env("R2_ACCOUNT_ID", "S3_ACCOUNT_ID");
  let endpoint = env("S3_ENDPOINT");
  if (!endpoint && accountId) {
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  }
  if (!endpoint) return null;

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env("S3_REGION", "R2_REGION") ?? "auto",
    pathStyle: flag("S3_PATH_STYLE", true),
    publicBaseUrl: env("S3_PUBLIC_BASE_URL", "R2_PUBLIC_BASE_URL"),
    // A separate public bucket is opt-in: without it every key stays in the
    // primary bucket and the read proxy remains the only visibility gate.
    // Names double as the Supabase-side names (MEDIA_PUBLIC_BUCKET) so one env
    // line configures the public bucket wherever media currently lives.
    publicBucket: env("S3_PUBLIC_BUCKET", "R2_PUBLIC_BUCKET", "MEDIA_PUBLIC_BUCKET"),
  };
}

/** Named for display only — a human should recognise the store they picked. */
function labelForEndpoint(endpoint: string): string {
  const host = endpoint.toLowerCase();
  if (host.includes("r2.cloudflarestorage.com")) return "Cloudflare R2";
  if (host.includes("backblazeb2.com")) return "Backblaze B2";
  if (host.includes("digitaloceanspaces.com")) return "DigitalOcean Spaces";
  if (host.includes("wasabisys.com") || host.includes("wasabi.tech")) return "Wasabi";
  if (host.includes("storage.googleapis.com")) return "Google Cloud Storage";
  if (host.includes("amazonaws.com")) return "Amazon S3";
  if (host.includes("minio")) return "MinIO";
  try {
    return `S3-compatible (${new URL(endpoint).host})`;
  } catch {
    return "S3-compatible storage";
  }
}

/** A key that will never exist, used to probe credentials without writing. */
const PROBE_KEY = ".spaces1-access-probe";

/** Buckets proven unreachable, keyed by name: R2 tokens are per-bucket, so a
 * write to a public bucket the token was not minted for fails 403 forever. */
const PUBLIC_BUCKET_DOWN = new Set<string>();

export function createS3Provider(input?: S3Config | null): StorageProvider {
  const candidate = input ?? resolveS3Config();
  if (!candidate) {
    throw new Error("createS3Provider called with no S3 credentials configured");
  }
  const config: S3Config = candidate;
  // Shared across providers built from the same config object; survives the
  // provider rebuilds that env fingerprints trigger, so a dead public bucket
  // is probed once per process, not once per upload.
  if (config.publicBucketDown === undefined && PUBLIC_BUCKET_DOWN.has(config.publicBucket ?? ""))
    config.publicBucketDown = true;

  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
  });

  const host = (() => {
    try {
      return new URL(config.endpoint).host;
    } catch {
      return hostOf(config.endpoint);
    }
  })();
  const scheme = config.endpoint.startsWith("http://") ? "http" : "https";

  /**
   * Which bucket a key lives in. Public folders go to the dedicated public
   * bucket when the operator configured one; everything else stays in the
   * primary bucket, where only the authorized reader can reach it.
   */
  function bucketOfKey(key: string): string {
    return config.publicBucket && !config.publicBucketDown && isPublicMediaPath(key)
      ? config.publicBucket
      : config.bucket;
  }

  /**
   * Buckets a read should try, in order. When the public bucket was marked
   * down, its earlier objects are still there — the primary misses and the
   * public bucket catches them, so nothing that landed before the fallback
   * disappears.
   */
  function readBucketsFor(key: string): string[] {
    const primary = bucketOfKey(key);
    const alternates = config.publicBucket
      ? [config.publicBucket, config.bucket].filter((b) => b !== primary)
      : [];
    return [primary, ...alternates];
  }

  function encodedKey(key: string): string {
    return key.split("/").map(encodeURIComponent).join("/");
  }

  function objectUrl(key: string, bucketName = bucketOfKey(key)): string {
    return config.pathStyle
      ? `${config.endpoint}/${bucketName}/${encodedKey(key)}`
      : `${scheme}://${bucketName}.${host}/${encodedKey(key)}`;
  }

  /** Bucket root, which is where ListObjects v2 lives. */
  function bucketUrl(query: URLSearchParams, bucketName = config.bucket): string {
    return config.pathStyle
      ? `${config.endpoint}/${bucketName}/?${query}`
      : `${scheme}://${bucketName}.${host}/?${query}`;
  }

  function toRead(res: Response, fallbackType: string, wholeSize?: number): Promise<StorageRead> {
    return res.arrayBuffer().then((buffer) => {
      // `Content-Range: bytes 0-499/12345` carries the total object size.
      const contentRange = res.headers.get("content-range");
      const total = contentRange?.split("/")[1];
      return {
        body: new Uint8Array(buffer),
        contentType: res.headers.get("content-type") || fallbackType,
        totalSize: Number(total) || wholeSize || buffer.byteLength,
        partial: res.status === 206,
      };
    });
  }

  return {
    info: {
      id: "s3",
      label: labelForEndpoint(config.endpoint),
      bucket: config.publicBucket ? `${config.bucket} + ${config.publicBucket}` : config.bucket,
      endpoint: host,
    },
    async put(key, body, contentType) {
      let target = bucketOfKey(key);
      let res = await client.fetch(objectUrl(key, target), {
        method: "PUT",
        headers: { "content-type": contentType },
        body: body as BodyInit,
      });
      // A public bucket that does not exist yet (404) or that this token was
      // never minted for (403) must not fail the upload: remember it is down,
      // and land the object in the primary bucket, where the read proxy serves
      // it with the same visibility rules as before the split.
      if (!res.ok && target === config.publicBucket && (res.status === 403 || res.status === 404)) {
        console.warn(
          `[storage] public bucket "${target}" is not reachable (${res.status}) — ` +
            `writing to "${config.bucket}" instead. Grant this token access to both ` +
            `buckets (or create the public one) to use direct public URLs.`,
        );
        config.publicBucketDown = true;
        if (config.publicBucket) PUBLIC_BUCKET_DOWN.add(config.publicBucket);
        target = config.bucket;
        res = await client.fetch(objectUrl(key, target), {
          method: "PUT",
          headers: { "content-type": contentType },
          body: body as BodyInit,
        });
      }
      if (!res.ok) throw new Error(`${this.info.label} upload failed (${res.status})`);
      return { key };
    },
    async get(key) {
      for (const bucketName of readBucketsFor(key)) {
        const res = await client.fetch(objectUrl(key, bucketName), { method: "GET" });
        if (res.status === 404 || res.status === 403) continue;
        if (!res.ok) throw new Error(`${this.info.label} read failed (${res.status})`);
        return toRead(res, "application/octet-stream");
      }
      return null;
    },
    async getRange(key, start, end) {
      const last = end === undefined ? "" : String(Math.max(start, end));
      for (const bucketName of readBucketsFor(key)) {
        const res = await client.fetch(objectUrl(key, bucketName), {
          method: "GET",
          headers: { range: `bytes=${start}-${last}` },
        });
        if (res.status === 404 || res.status === 416) continue;
        if (!res.ok && res.status !== 206 && res.status !== 200) {
          throw new Error(`${this.info.label} range read failed (${res.status})`);
        }
        // Some gateways answer 200 with the whole object when they ignore Range;
        // `partial` then tells the proxy it must not claim a 206.
        return toRead(res, "application/octet-stream");
      }
      return null;
    },
    async delete(keys) {
      const removed: string[] = [];
      // S3 DELETE is idempotent and a 404 means "already gone", which is a
      // success for us. Sequential keeps this dependency-free (no multipart
      // DeleteObjects XML body to sign) and deletes are always small-N.
      // Every candidate bucket is visited, or a key that predates the public
      // bucket fallback would resurrect itself through the un-removed copy.
      for (const key of keys) {
        if (!key) continue;
        for (const bucketName of readBucketsFor(key)) {
          const res = await client.fetch(objectUrl(key, bucketName), { method: "DELETE" });
          if (res.ok || res.status === 404 || res.status === 204) {
            if (!removed.includes(key)) removed.push(key);
          } else console.error(`${this.info.label} delete failed (${res.status}) for ${key}`);
        }
      }
      return removed;
    },
    async stat(key) {
      for (const bucketName of readBucketsFor(key)) {
        const res = await client.fetch(objectUrl(key, bucketName), { method: "HEAD" });
        if (res.status === 404 || res.status === 403) continue;
        if (!res.ok) throw new Error(`${this.info.label} stat failed (${res.status})`);
        return {
          size: Number(res.headers.get("content-length") ?? 0),
          contentType: res.headers.get("content-type") || "application/octet-stream",
        };
      }
      return null;
    },
    publicUrl(key) {
      // Never hand out a direct URL for a non-public key: a CDN domain that
      // fronts the bucket would then serve DM attachments and replays to anybody.
      if (!isPublicMediaPath(key)) return null;
      if (!config.publicBaseUrl) return null;
      return `${config.publicBaseUrl.replace(/\/+$/, "")}/${encodedKey(key)}`;
    },
    async list(cursor) {
      // ListObjectsV2, one page at a time, walking the private bucket first and
      // the public one after it so a reconciliation sees every stored byte.
      const buckets = [...new Set([config.bucket, config.publicBucket ?? config.bucket])];
      let page: { bucketIndex: number; token?: string } = { bucketIndex: 0 };
      if (cursor) {
        try {
          page = JSON.parse(cursor);
        } catch {
          page = { bucketIndex: 0, token: cursor };
        }
      }
      const bucketName = buckets[page.bucketIndex];
      if (!bucketName) return { keys: [], nextCursor: null };
      const query = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
      if (page.token) query.set("continuation-token", page.token);
      const res = await client.fetch(bucketUrl(query, bucketName), { method: "GET" });
      if (!res.ok) {
        throw new Error(`${this.info.label} listing failed (${res.status})`);
      }
      const xml = await res.text();
      const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => unescapeXml(m[1]));
      const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
      const token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/i)?.[1];
      if (truncated && token) {
        return { keys, nextCursor: JSON.stringify({ bucketIndex: page.bucketIndex, token }) };
      }
      const nextIndex = page.bucketIndex + 1;
      return {
        keys,
        nextCursor: nextIndex < buckets.length ? JSON.stringify({ bucketIndex: nextIndex }) : null,
      };
    },
    async verifyAccess(): Promise<StorageProbe> {
      // HEAD on a key that cannot exist: 404 proves the credentials and the
      // bucket are reachable, 401/403 proves they are not. Nothing is written.
      try {
        const res = await client.fetch(objectUrl(PROBE_KEY), { method: "HEAD" });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, detail: "credentials rejected for this bucket" };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.name : "network error" };
      }
    },
  };
}

function hostOf(url: string): string {
  const withoutProtocol = url.replace(/^https?:\/\//, "");
  return withoutProtocol.split("/")[0] ?? withoutProtocol;
}

/** Undo the five XML entities (plus numeric refs) S3 escapes keys with. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}
