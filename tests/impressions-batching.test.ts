// @vitest-environment node
/**
 * Supabase impression (view-log) ingestion is the app's hottest write path.
 *
 * A feed scroll makes a dozen cards intersect the viewport almost at once, and
 * each card used to fire its OWN `recordPostImpression` POST → its own server
 * round-trip (a profile lookup + an existence check + an upsert + a client
 * read-back). The "batched" docstring was aspirational: the per-card caller never
 * batched, so a page of N cards cost N POSTs and ~4N queries — write traffic that
 * scales with concurrent viewers like a self-inflicted DDoS.
 *
 * The contract that shrinks it (with no perceived perf cost, since views are
 * best-effort telemetry):
 *   • ids that intersect are collected into a client-side queue and flushed as
 *     ONE `recordPostImpressions(ids)` call — on a short timer, immediately at a
 *     batch ceiling, and on navigation-away so nothing queued is lost;
 *   • the queue de-dupes pending ids (and the card keeps its session de-dupe), so
 *     a card scrolling in/out never re-sends;
 *   • `recordPostImpression` is now just "enqueue" — it no longer awaits a
 *     per-card response; the refreshed tally still reaches the card through the
 *     `post_view_updated` realtime event the flush emits.
 *
 * Client/JSX code a node test cannot stand up is read out of source, matching the
 * rest of this suite.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const src = (rel: string) => read(`../src/${rel}`);

/** Text between two markers, so an assertion is about one region only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe("impression ids are queued and flushed as one batch", () => {
  const api = src("lib/api-client.ts");

  it("exposes a queue that de-dupes pending ids", () => {
    expect(api).toContain("export function queuePostImpression(postId: string)");
    expect(api).toContain("const pendingImpressions = new Set<string>();");
    expect(api).toContain("pendingImpressions.has(postId)");
  });

  it("flushes the whole pending set through the existing batch worker", () => {
    const flush = between(
      api,
      "async function flushImpressions()",
      "export function queuePostImpression",
    );
    expect(flush).toContain("Array.from(pendingImpressions)");
    expect(flush).toContain("pendingImpressions.clear()");
    // ONE call carries the batch — this is what replaces the per-card fan-out.
    expect(flush).toContain("await recordPostImpressions(ids)");
  });

  it("flushes on a timer, at the batch ceiling, and on navigation-away", () => {
    expect(api).toContain("const IMPRESSION_FLUSH_MS =");
    expect(api).toContain("const IMPRESSION_BATCH_MAX =");
    expect(api).toContain("if (pendingImpressions.size >= IMPRESSION_BATCH_MAX)");
    expect(api).toContain("impressionTimer = setTimeout(");
    // A reader who hides the tab or closes the page still ships what they saw.
    expect(api).toContain('window.addEventListener("pagehide"');
    expect(api).toContain('document.addEventListener("visibilitychange"');
  });

  it("keeps the batched server write intact (one profiles lookup + upsert)", () => {
    const server = src("lib/impressions.functions.ts");
    expect(server).toContain(
      '.upsert(rows, { onConflict: "post_id,user_id", ignoreDuplicates: true })',
    );
    // Repeat views stay silent, so a re-sent id costs nothing.
    expect(server).toContain("ignoreDuplicates: true");
  });
});

describe("the single-id entry point enqueues instead of POSTing per card", () => {
  const api = src("lib/api-client.ts");

  it("recordPostImpression now just queues the id", () => {
    const fn = between(api, "export async function recordPostImpression(postId: string)", "/* ---");
    expect(fn).toContain("queuePostImpression(postId);");
    // It must no longer fire its own awaited round-trip.
    expect(fn).not.toContain("await recordPostImpressions([postId])");
  });
});

describe("PostCard enqueues and lets realtime refresh the tally", () => {
  const card = src("components/social/PostCard.tsx");

  it("keeps the session de-dupe so a card never re-sends", () => {
    expect(card).toContain("const recordedImpressions = new Set<string>();");
    expect(card).toContain("if (recordedImpressions.has(post.id)) return;");
  });

  it("enqueues fire-and-forget — no per-card awaited response", () => {
    const cb = between(card, "observerCallbacks.set(el, () => {", "observer.observe(el);");
    expect(cb).toContain("recordPostImpression(post.id);");
    // The old `.then((res) => … res.viewCount)` awaited a dedicated round-trip.
    expect(cb).not.toMatch(/recordPostImpression\(post\.id\)\s*\.\then/);
    expect(cb).not.toContain("res.viewCount");
  });

  it("still updates the view count from the realtime event the flush emits", () => {
    expect(card).toContain('event.type === "post_view_updated"');
    expect(card).toContain("setState((s) => ({ ...s, views: newViews }))");
  });
});
