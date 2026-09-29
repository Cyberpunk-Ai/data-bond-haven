/**
 * Byte-range request parsing, shared by every media reader.
 *
 * Kept out of the route file so the behaviour is unit-testable and so a future
 * second reader (an R2 presign path, a Worker edge cache) cannot drift from the
 * rules the app's players already depend on.
 */

export type RangeIntent = { start?: number; end?: number; suffix?: number };

/**
 * Read a single `Range: bytes=a-b` / `bytes=a-` / `bytes=-N` request without
 * knowing the object size yet. Malformed, ambiguous or multi-range requests
 * return null and the whole object is served, which is always valid HTTP.
 */
export function readRangeIntent(header: string | null): RangeIntent | null {
  const text = header?.trim().toLowerCase();
  if (!text || !text.startsWith("bytes=")) return null;
  if (text.slice(6).includes(",")) return null;
  const [rawStart, rawEnd] = text.slice(6).split("-");
  if (rawStart === "" || rawStart === undefined) {
    const suffix = Number(rawEnd);
    return Number.isFinite(suffix) && suffix > 0 ? { suffix } : null;
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0) return null;
  if (rawEnd === undefined || rawEnd === "") return { start };
  const end = Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}
