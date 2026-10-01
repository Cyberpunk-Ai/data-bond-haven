/**
 * Reading an uploaded body without trusting it first.
 *
 * The upload handler used to do `await request.arrayBuffer()` before any size,
 * rate-limit or plan check — so the *largest* request an account is allowed to
 * attempt was the amount of memory the process had to hold for it, and a
 * refusal arrived only after the bytes were already buffered. Both halves are
 * fixed here: a declared `Content-Length` that cannot fit is refused before a
 * single byte is read, and a body that grows past its cap is abandoned
 * mid-stream instead of being finished and then rejected.
 *
 * Deliberately dependency-free (no env, no database) so it can be unit-tested
 * and imported from a route file that also ships to the client.
 */

/** `Content-Length` as reported by the client, or 0 when it is absent/unusable. */
export function declaredBodyBytes(request: Request): number {
  const raw = request.headers.get("content-length");
  if (!raw) return 0;
  const value = Number(raw);
  // A lying or malformed header must not become a negative cap.
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface CappedBody {
  /** The body, when it fit. Empty when `tooLarge` — nothing is kept from a refusal. */
  bytes: Uint8Array;
  /** The stream gave us more than `maxBytes`, so it was cancelled. */
  tooLarge: boolean;
}

/**
 * Read at most `maxBytes` from a request body. Anything over that is a refusal
 * the moment the excess arrives: the reader is cancelled, so the remainder never
 * reaches memory and the client's connection is cut short.
 *
 * `Content-Length` is still only a claim — the caller must check `bytes`
 * afterwards, which is why this returns the real size as well.
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<CappedBody> {
  if (!body) return { bytes: new Uint8Array(0), tooLarge: false };
  if (!(maxBytes >= 0)) throw new RangeError("readCappedBody needs a real byte cap");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { bytes: new Uint8Array(0), tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    // Release the lock on every path (including a mid-stream throw), or the
    // stream stays claimed for the life of the request.
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false };
}
