/**
 * What a story viewer has to know before a story can paint.
 *
 * Stories look simple — one panel, twenty-four hours old at most — but the
 * pixels behind them are not free: story media lives in the private bucket, so
 * every image needs a signed URL minted by `/api/media/token` *and* a decode
 * before it can be seen. Doing that only when the viewer arrives is what made
 * stories blink: a flat dark panel, then the photo arriving half-way through
 * the six seconds you were given to read it.
 *
 * So the decisions live here, apart from React, and the modal is the plumbing:
 *  - which layer a story row actually means (a photo, a clip, or nothing),
 *  - which neighbours to warm while the current one is being read,
 *  - whether the timer may advance, or must wait for the media it is showing.
 */

import { splitMediaList } from "@/lib/media-list";

export interface StoryLike {
  id: string;
  type?: string;
  media_url?: string | null;
  gradient?: string | null;
  text?: string | null;
}

/**
 * The one visual layer a story row asks for. `src` is the *stored* path — the
 * viewer still has to mint a playable URL for it.
 */
export type StoryLayer =
  { kind: "text"; src: null } | { kind: "image"; src: string } | { kind: "video"; src: string };

/** Text/gradient stories have nothing to load, so they are always paintable. */
export const TEXT_LAYER: StoryLayer = { kind: "text", src: null };

/**
 * `media_url` can hold several comma-joined attachments (the composer sends
 * one, the API has always accepted more). Splitting here keeps every consumer
 * — the painted frame, the preload queue, the signed-URL cache — agreeing on
 * what "the media of this story" means instead of each re-splitting the string.
 */
export function storyMediaList(story: StoryLike | undefined | null): string[] {
  if (!story?.media_url) return [];
  // De-dup through the shared, data-URL-aware splitter so a base64 story is not
  // shattered into a header and an orphaned payload.
  return [...new Set(splitMediaList(story.media_url))];
}

/** Does this stored path play as video? Extension first, then the row's own type. */
export function isVideoStorySrc(src: string | null | undefined, type?: string): boolean {
  const value = String(src ?? "").toLowerCase();
  if (/\.(mp4|mov|m4v|webm|ogv|ogg)(\?|#|$)/.test(value)) return true;
  return String(type ?? "").toLowerCase() === "video";
}

/** The layer a story row means: its first attachment, or its text panel. */
export function storyLayer(story: StoryLike | undefined | null): StoryLayer {
  const [first] = storyMediaList(story);
  if (!first) return TEXT_LAYER;
  return isVideoStorySrc(first, story?.type)
    ? { kind: "video", src: first }
    : { kind: "image", src: first };
}

/** Nothing about this story needs a network round trip before it can be read. */
export function storyPaintsImmediately(story: StoryLike | undefined | null): boolean {
  return storyLayer(story).kind === "text";
}

/**
 * Indices worth warming while the current story is open: the next few in the
 * queue (that is where a reader is going) and the one behind it (so tapping
 * back is not a blank jump). Out-of-range and the current index are excluded —
 * the current one is already loading by definition.
 */
export function storyPreloadIndices(
  total: number,
  current: number,
  ahead = 2,
  behind = 1,
): number[] {
  const out: number[] = [];
  for (let i = current - behind; i <= current + Math.max(0, ahead); i += 1) {
    if (i === current || i < 0 || i >= total) continue;
    out.push(i);
  }
  return out;
}

/**
 * Whether the auto-advance clock may run for the frame on screen.
 *
 * `waitedMs` is how long this story has been open without its media decoding.
 * Past `patienceMs` the viewer stops waiting: a photo that will not arrive
 * (a dead object, a captive network) must not freeze the carousel, and a
 * gradient panel with the caption on it is still a readable story.
 */
export function storyShouldHoldClock(opts: {
  layer: StoryLayer;
  hasUrl: boolean;
  decoded: boolean;
  waitedMs: number;
  patienceMs?: number;
}): boolean {
  const { layer, hasUrl, decoded, waitedMs } = opts;
  if (layer.kind === "text") return false;
  if (decoded) return false;
  const patience = opts.patienceMs ?? 4000;
  if (waitedMs >= patience) return false;
  // Still minting the URL, or minted but not decoded yet: hold.
  return !hasUrl || !decoded;
}

/**
 * How far the progress bar may move on one tick. Held frames do not tick at
 * all (the caller stops the clock), so this only shapes the speed once media is
 * up: `stepPerTick`/`intervalMs` is the story's own budget in seconds.
 */
export function storyProgressStep(intervalMs: number, durationMs: number): number {
  if (intervalMs <= 0 || durationMs <= 0) return 100;
  return Math.max(0.1, Math.min(100, (intervalMs / durationMs) * 100));
}
