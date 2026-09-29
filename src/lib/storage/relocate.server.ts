/**
 * Moving an existing deployment's bytes from one object store to another.
 *
 * Stored references are already backend-agnostic (`media_objects.path` plus the
 * `folder/key` values in posts, profiles, stories and messages resolve through
 * `/api/public/media/…` against whichever store is active), so switching stores
 * does not corrupt any row. What it *does* leave behind is the bytes: objects
 * uploaded while the old bucket was live only exist there, and the read mirror
 * that keeps them visible needs the old credentials to stay in the environment.
 *
 * Relocation closes that gap. It walks the retired bucket, copies whatever the
 * active bucket is missing under the same key, and verifies the size landed
 * intact. It never overwrites an existing object and never deletes a source, so
 * it is idempotent and safe to interrupt — run it again and it picks up where it
 * stopped.
 */
import type { StorageInfo, StorageProvider } from "@/lib/storage/provider.server";
import { buildPrimaryProvider, legacyStorageProviders } from "@/lib/storage/index.server";

export interface RelocateOptions {
  /** Report what would move without writing anything. */
  dryRun?: boolean;
  /** Stop after this many objects have been inspected. */
  limit?: number;
  /** Stop once this many bytes have been copied (bounds one request). */
  maxBytes?: number;
}

export interface RelocateReport {
  from: StorageInfo;
  to: StorageInfo;
  scanned: number;
  /** Objects whose bytes were not in the active store and are now. */
  copied: number;
  /** Missing from the active store — in a dry run this is what a copy would do. */
  missing: number;
  alreadyThere: number;
  failed: number;
  bytes: number;
  /** True when the source bucket was fully walked in this run. */
  exhausted: boolean;
  detail?: string;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Housekeeping objects a bucket may contain that no row ever references. */
function skipKey(key: string): boolean {
  return !key || key.startsWith(".") || key.includes("\0") || key.includes("..");
}

/** Copy one bucket into another, key for key, stopping at the run's budget. */
export async function relocateFrom(
  source: StorageProvider,
  target: StorageProvider,
  options: RelocateOptions = {},
): Promise<RelocateReport> {
  const report: RelocateReport = {
    from: source.info,
    to: target.info,
    scanned: 0,
    copied: 0,
    missing: 0,
    alreadyThere: 0,
    failed: 0,
    bytes: 0,
    exhausted: false,
  };

  if (!source.list) {
    report.detail = `${source.info.label} cannot be enumerated, so its objects were not checked.`;
    return report;
  }
  if (source.info.id === target.info.id && source.info.bucket === target.info.bucket) {
    report.detail = "The source and destination are the same bucket — nothing to relocate.";
    report.exhausted = true;
    return report;
  }

  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const dryRun = Boolean(options.dryRun);

  let cursor: string | null = null;
  let budgetLeft = true;

  do {
    const page = await source.list(cursor);
    cursor = page.nextCursor;

    for (const key of page.keys) {
      if (skipKey(key)) continue;
      if (report.scanned >= limit || (!dryRun && report.bytes >= maxBytes)) {
        budgetLeft = false;
        break;
      }
      report.scanned++;

      // A key that already exists in the active store is left exactly as it is:
      // it was either copied by an earlier run or uploaded after the switch.
      const existing = await target.stat(key).catch(() => null);
      if (existing) {
        report.alreadyThere++;
        continue;
      }
      report.missing++;
      if (dryRun) continue;

      try {
        const object = await source.get(key);
        if (!object || !object.body.byteLength) {
          report.failed++;
          console.error(`[relocate] ${key}: nothing readable in ${source.info.label}`);
          continue;
        }
        await target.put(key, object.body, object.contentType);
        const landed = await target.stat(key).catch(() => null);
        if (!landed || landed.size !== object.totalSize) {
          // Sizes disagree: keep the source intact and let the next run retry.
          report.failed++;
          console.error(
            `[relocate] ${key}: wrote ${object.totalSize} bytes but the destination reports ${landed?.size ?? "nothing"}`,
          );
          continue;
        }
        report.copied++;
        report.bytes += object.totalSize;
      } catch (err) {
        report.failed++;
        console.error(`[relocate] ${key} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } while (cursor && budgetLeft);

  report.exhausted = !cursor && budgetLeft;
  return report;
}

/**
 * Relocate everything from every *other* configured backend into the active one.
 * One entry per legacy store, so an operator who has been through two switches
 * still sees each hop accounted for.
 */
export async function relocateLegacyMedia(
  options: RelocateOptions = {},
): Promise<RelocateReport[]> {
  const target = buildPrimaryProvider();
  const sources = legacyStorageProviders();
  if (!sources.length) return [];
  const reports: RelocateReport[] = [];
  for (const source of sources) {
    reports.push(await relocateFrom(source, target, options));
  }
  return reports;
}

/** Human one-liner for the admin console and logs. */
export function describeRelocate(report: RelocateReport, dryRun = false): string {
  const route = `${report.from.label} "${report.from.bucket}" → ${report.to.label} "${report.to.bucket}"`;
  if (report.detail) return `${route}: ${report.detail}`;
  const mb = (report.bytes / (1024 * 1024)).toFixed(1);
  return dryRun
    ? `${route}: ${report.missing} of ${report.scanned} objects still missing from the active bucket`
    : `${route}: copied ${report.copied} objects (${mb} MB), ${report.alreadyThere} already present, ${report.failed} failed`;
}
