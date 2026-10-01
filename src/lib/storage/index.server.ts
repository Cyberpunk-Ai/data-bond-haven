/**
 * Which storage backend is live, decided from the environment alone.
 *
 * `STORAGE_PROVIDER` names one explicitly (`s3`/`r2` or `supabase`); the
 * default `auto` prefers an S3-compatible store whenever credentials exist and
 * falls back to the Supabase bucket otherwise. Adding R2 (or B2, Spaces, MinIO,
 * S3) is therefore an env change and a restart — never a code change — and the
 * rest of the app only ever sees a {@link StorageProvider}.
 *
 * The other configured backend stays available as a *read* mirror (see
 * {@link withReadMirror}): objects uploaded before a switch keep working.
 */
import type { StorageInfo, StorageProbe, StorageProvider } from "@/lib/storage/provider.server";
import { createS3Provider, resolveS3Config } from "@/lib/storage/s3.server";
import { createSupabaseProvider } from "@/lib/storage/supabase.server";
import { mediaBucketNames } from "@/lib/media-folders.server";

export * from "@/lib/storage/provider.server";

let cached: StorageProvider | null = null;
let cachedFingerprint = "";

/** Any credential-shaped change in the environment rebuilds the provider. */
function fingerprint(): string {
  const s3 = resolveS3Config();
  const buckets = mediaBucketNames();
  return [
    (process.env["STORAGE_PROVIDER"] || "auto").toLowerCase(),
    s3
      ? `${s3.endpoint}|${s3.bucket}|${s3.publicBucket ?? ""}|${s3.region}|${s3.pathStyle}|${s3.publicBaseUrl ?? ""}`
      : "-",
    `${buckets.publicBucket}|${buckets.privateBucket}|${buckets.legacyBucket}`,
  ].join(":");
}

/**
 * Reads that miss the chosen backend are retried against the other backend that
 * is still configured, so pasting R2 credentials into `.env` does not black out
 * every object uploaded while the Supabase bucket was live. Writes always go to
 * the primary backend only, so the store converges on the new provider over
 * time instead of splitting across two.
 */
function withReadMirror(primary: StorageProvider, others: StorageProvider[]): StorageProvider {
  if (!others.length) return primary;

  async function readThrough<T>(
    pick: (provider: StorageProvider) => Promise<T | null>,
  ): Promise<T | null> {
    const first = await pick(primary).catch((err) => {
      console.error(
        `[storage] ${primary.info.label} read failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });
    if (first !== null && first !== undefined) return first;
    for (const other of others) {
      const hit = await pick(other).catch(() => null);
      if (hit !== null && hit !== undefined) {
        // Loud once per process per mirror: tells an operator the switch is
        // half-done (bytes still live in the old store) without flooding logs.
        noteMirrorHit(other.info);
        return hit;
      }
    }
    return null;
  }

  return {
    info: primary.info,
    put: (key, body, contentType) => primary.put(key, body, contentType),
    get: (key) => readThrough((p) => p.get(key)),
    getRange: (key, start, end) => readThrough((p) => p.getRange(key, start, end)),
    stat: (key) => readThrough((p) => p.stat(key)),
    // A delete must clear every copy, or the mirror resurrects the object.
    async delete(keys) {
      const groups = await Promise.allSettled([primary, ...others].map((p) => p.delete(keys)));
      const removed = new Set<string>();
      for (const group of groups) {
        if (group.status === "fulfilled") for (const key of group.value) removed.add(key);
      }
      return [...removed];
    },
    // A public CDN only fronts the primary bucket; mirrored keys are not there.
    publicUrl: primary.publicUrl
      ? (key) => {
          const url = primary.publicUrl!(key);
          return url;
        }
      : undefined,
    // Listing means "what is in the active store", which is what a caller
    // reconciling an old bucket against the new one needs the mirror to say.
    list: primary.list ? (cursor) => primary.list!(cursor) : undefined,
    verifyAccess: () => primary.verifyAccess(),
  };
}

const notedMirrors = new Set<string>();

function noteMirrorHit(info: StorageInfo): void {
  const id = `${info.id}:${info.bucket}`;
  if (notedMirrors.has(id)) return;
  notedMirrors.add(id);
  console.warn(
    `[storage] served an object from the legacy ${info.label} bucket "${info.bucket}" — ` +
      `those bytes have not been copied to the active backend yet.`,
  );
}

/** The legacy store is only a mirror while its own credentials are still set. */
function hasSupabaseConfig(): boolean {
  const value = (name: string) => (process.env[name] ?? "").trim();
  return Boolean(
    (value("SUPABASE_URL") || value("VITE_SUPABASE_URL")) &&
    (value("SUPABASE_SERVICE_ROLE_KEY") || value("VITE_SUPABASE_SERVICE_ROLE_KEY")),
  );
}

/** Mirrors are only useful when the legacy store is actually reachable config-wise. */
function readMirrors(primary: StorageProvider): StorageProvider[] {
  const mirrors: StorageProvider[] = [];
  if (primary.info.id !== "supabase" && hasSupabaseConfig()) {
    mirrors.push(createSupabaseProvider());
  }
  const s3 = resolveS3Config();
  if (s3 && primary.info.id !== "s3") mirrors.push(createS3Provider(s3));
  return mirrors;
}

/**
 * Every other configured backend, unread-mirrored: the sources a relocation
 * copies *from* while the active backend is the destination.
 */
export function legacyStorageProviders(): StorageProvider[] {
  return readMirrors(buildPrimaryProvider());
}

function build(): StorageProvider {
  const requested = (process.env["STORAGE_PROVIDER"] || "auto").trim().toLowerCase();
  const s3 = resolveS3Config();

  let primary: StorageProvider;
  if (requested === "supabase") primary = createSupabaseProvider();
  else if (s3) primary = createS3Provider(s3);
  else {
    if (requested === "s3" || requested === "r2") {
      // Named deliberately but configured incompletely: say exactly what is
      // missing instead of quietly serving from the other backend forever.
      console.error(
        `[storage] STORAGE_PROVIDER=${requested} but S3/R2 credentials are incomplete ` +
          `(need S3_ENDPOINT or R2_ACCOUNT_ID, plus S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY). ` +
          `Falling back to the Supabase media bucket.`,
      );
    }
    primary = createSupabaseProvider();
  }

  return withReadMirror(primary, readMirrors(primary));
}

/** The active storage backend (with any legacy store mirrored for reads). */
export function getStorageProvider(): StorageProvider {
  const fp = fingerprint();
  if (!cached || fp !== cachedFingerprint) {
    cached = build();
    cachedFingerprint = fp;
  }
  return cached;
}

export function storageBackendName(): StorageInfo["id"] {
  return getStorageProvider().info.id;
}

export interface StorageStatus extends StorageInfo, StorageProbe {
  /** Legacy backends still readable, with the state of their credentials. */
  mirrors: Array<StorageInfo & StorageProbe>;
}

/** What backend is live right now, plus a live credential probe (admin-only). */
export async function storageStatus(): Promise<StorageStatus> {
  const provider = getStorageProvider();
  const probe = await provider.verifyAccess();
  const mirrors = readMirrors(provider);
  const mirrorStatus = await Promise.all(
    mirrors.map(async (mirror) => ({ ...mirror.info, ...(await mirror.verifyAccess()) })),
  );
  return { ...provider.info, ...probe, mirrors: mirrorStatus };
}

/** Test seam: forget the cached provider so an env change takes effect. */
export function resetStorageProvider(): void {
  cached = null;
  cachedFingerprint = "";
  notedMirrors.clear();
}

/** Test seam: the raw selection logic, without the read mirror. */
export function buildPrimaryProvider(): StorageProvider {
  const requested = (process.env["STORAGE_PROVIDER"] || "auto").trim().toLowerCase();
  const s3 = resolveS3Config();
  if (requested === "supabase") return createSupabaseProvider();
  if (s3) return createS3Provider(s3);
  return createSupabaseProvider();
}
