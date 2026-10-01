import { describe, expect, it } from "vitest";

import { declaredBodyBytes, readCappedBody } from "@/lib/upload-limits";

/**
 * The upload endpoint used to `await request.arrayBuffer()` before it looked at
 * the caller's plan, the file's size or the rate limit — so the biggest upload an
 * account could attempt was the amount of memory the process had to hold for it
 * (Pro allows four-figure megabytes). These tests pin the replacement contract:
 * a body that cannot fit is refused before it is read, and one that grows past
 * its cap mid-stream is abandoned rather than finished.
 */

function requestWithContentLength(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("content-length", value);
  // A real `Request` would recompute Content-Length from its body, which is
  // exactly the value under test — so hand the helper the header set it reads.
  return { headers } as Request;
}

describe("declaredBodyBytes", () => {
  it("reports the client's claim when it is usable", () => {
    expect(declaredBodyBytes(requestWithContentLength("4096"))).toBe(4096);
    expect(declaredBodyBytes(requestWithContentLength("0"))).toBe(0);
  });

  it("treats an absent, malformed or hostile header as unknown", () => {
    for (const value of [null, "", "not-a-number", "-1", "1e999", "12.5", "9007199254740993"]) {
      expect(declaredBodyBytes(requestWithContentLength(value))).toBe(0);
    }
  });
});

/** A pull-based stream that records what the producer actually handed over. */
function chunkedStream(chunkBytes: number, chunkCount: number) {
  const seen = { delivered: 0, cancelled: false, completed: false };
  let pushed = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pushed >= chunkCount) {
        seen.completed = true;
        controller.close();
        return;
      }
      pushed += 1;
      seen.delivered += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(7));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

describe("readCappedBody", () => {
  it("reassembles a body that fits, in order", async () => {
    const { stream } = chunkedStream(3, 5);
    const { bytes, tooLarge } = await readCappedBody(stream, 15);
    expect(tooLarge).toBe(false);
    expect(bytes).toHaveLength(15);
    expect(Array.from(bytes)).toEqual(new Array(15).fill(7));
  });

  it("accepts a body exactly at the cap", async () => {
    const { stream } = chunkedStream(4, 4);
    const { bytes, tooLarge } = await readCappedBody(stream, 16);
    expect(tooLarge).toBe(false);
    expect(bytes).toHaveLength(16);
  });

  it("stops reading, keeps nothing and cancels the stream past the cap", async () => {
    const chunkBytes = 1024 * 1024;
    const cap = 4 * chunkBytes;
    const { stream, seen } = chunkedStream(chunkBytes, 64); // 64MB on offer

    const { bytes, tooLarge } = await readCappedBody(stream, cap);
    expect(tooLarge).toBe(true);
    expect(bytes).toHaveLength(0);
    expect(seen.cancelled).toBe(true);
    expect(seen.completed).toBe(false);
    // The point of the exercise: we never brought the whole 64MB in. One chunk
    // of slack is the stream's own read-ahead; more than that is a regression.
    expect(seen.delivered).toBeLessThanOrEqual(cap + chunkBytes);
  });

  it("handles an absent or empty body without inventing bytes", async () => {
    expect(await readCappedBody(null, 10)).toEqual({ bytes: new Uint8Array(0), tooLarge: false });

    const empty = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const { bytes, tooLarge } = await readCappedBody(empty, 10);
    expect(tooLarge).toBe(false);
    expect(bytes).toHaveLength(0);
  });

  it("refuses to read against a cap that is not a real size", async () => {
    const { stream } = chunkedStream(1, 1);
    await expect(readCappedBody(stream, Number.NaN)).rejects.toThrow(RangeError);
  });

  it("releases the reader when the stream errors mid-body", async () => {
    const boom = new Error("network went away");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(boom);
      },
    });
    await expect(readCappedBody(stream, 100)).rejects.toBe(boom);
    // Releasing the lock is what lets the request finish rather than leak.
    expect(stream.locked).toBe(false);
  });
});
