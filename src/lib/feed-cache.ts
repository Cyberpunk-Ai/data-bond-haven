import { preloadFeedBundle, PreloadBundleResponse } from "./api-client";
import type { Post, Story, TrendingTag } from "./types";
import { optimizeImageUrl } from "./utils";

interface MemoryFeedCache {
  bundle: PreloadBundleResponse | null;
  lastFetchedAt: number;
  foryou: Post[];
  following: Post[];
  latest: Post[];
  stories: Story[];
  trendingTags: TrendingTag[];
  prefetchedImages: Set<string>;
}

const cache: MemoryFeedCache = {
  bundle: null,
  lastFetchedAt: 0,
  foryou: [],
  following: [],
  latest: [],
  stories: [],
  trendingTags: [],
  prefetchedImages: new Set<string>(),
};

const CACHE_TTL_MS = 30_000; // 30 seconds fresh window before background refresh

// ---------------------------------------------------------------------------
// Feed snapshot — a stable view across a hard reload
//
// The in-memory cache above dies the instant the page reloads (F5, a harsher
// navigation than an SPA hop), so a returning reader was thrown back to a
// skeleton and a fresh fetch. That fetch could differ from what they had: it may
// run before the viewer id resolves (a guest chronological page that then
// reshuffles to ranked), and it can land on a newer 10-minute ranking epoch. The
// result read as "the feed isn't stable — it reordered itself when I reloaded".
//
// We persist the exact rendered view to sessionStorage, which lives for the
// lifetime of the tab and therefore survives a reload but is gone once the tab
// closes (so a stale list never greets a brand-new session). Restoring it paints
// the identical order, cursor and scroll position instantly; a background
// reconcile then refreshes counts without moving anything.
// ---------------------------------------------------------------------------

const SNAPSHOT_KEY = "spaces1:feed-snapshot:v1";
// Aligned to the ranker's epoch: beyond this the stored order no longer matches
// what the server would page-continue from, so it is wiser to re-fetch fresh.
const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
// Cap the persisted list so a long scroll session can't bloat sessionStorage.
const SNAPSHOT_MAX_POSTS = 150;

export interface FeedSnapshot {
  viewerId: string;
  foryou: Post[];
  stories: Story[];
  /** The deep pagination cursor reached, so "load more" continues where you left off. */
  cursor: string | null;
  hasMore: boolean;
  visibleCount: number;
  scrollY: number;
  savedAt: number;
}

/**
 * Read a previous view for `viewerId`, or null when there is nothing safe to
 * restore (no snapshot, a different account, stale past the epoch, malformed
 * payload). The payload is treated as untrusted: a shape check gates every use.
 */
export function readFeedSnapshot(viewerId: string): FeedSnapshot | null {
  if (typeof window === "undefined" || !viewerId) return null;
  try {
    const raw = window.sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FeedSnapshot;
    if (
      !parsed ||
      parsed.viewerId !== viewerId ||
      !Array.isArray(parsed.foryou) ||
      parsed.foryou.length === 0 ||
      Date.now() - Number(parsed.savedAt || 0) > SNAPSHOT_MAX_AGE_MS
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Best-effort persist; a quota or private-mode throw is never worth a crash. */
export function writeFeedSnapshot(snapshot: FeedSnapshot): void {
  if (typeof window === "undefined" || !snapshot.viewerId) return;
  try {
    const trimmed: FeedSnapshot = {
      ...snapshot,
      foryou: snapshot.foryou.slice(0, SNAPSHOT_MAX_POSTS),
    };
    window.sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage disabled/full: losing the reload-continuity nicety is acceptable */
  }
}

export function clearFeedSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Prefetches image URLs to warm the browser's disk & memory cache.
 */
export function prewarmImages(urls: (string | null | undefined)[]) {
  if (typeof window === "undefined") return;
  for (const url of urls) {
    if (url && !cache.prefetchedImages.has(url)) {
      cache.prefetchedImages.add(url);
      const img = new Image();
      img.src = optimizeImageUrl(url, 800);
    }
  }
}

/**
 * Returns currently cached data synchronously without blocking render.
 */
export function getCachedFeedData() {
  return {
    foryou: cache.foryou,
    following: cache.following,
    latest: cache.latest,
    stories: cache.stories,
    trendingTags: cache.trendingTags,
    isFresh: Date.now() - cache.lastFetchedAt < CACHE_TTL_MS,
    hasData: cache.foryou.length > 0 || cache.stories.length > 0,
  };
}

let ongoingPreloadPromise: Promise<PreloadBundleResponse | null> | null = null;

/**
 * Triggers preloading of feed content and prewarms story/avatar assets.
 */
export async function triggerFeedPreload(force = false): Promise<PreloadBundleResponse | null> {
  const isFresh = Date.now() - cache.lastFetchedAt < CACHE_TTL_MS;
  if (!force && isFresh && cache.bundle) {
    return cache.bundle;
  }

  if (ongoingPreloadPromise) {
    return ongoingPreloadPromise;
  }

  ongoingPreloadPromise = (async () => {
    try {
      const bundle = await preloadFeedBundle();
      cache.bundle = bundle;
      cache.lastFetchedAt = Date.now();
      cache.foryou = bundle.foryou || [];
      cache.following = bundle.following || [];
      cache.stories = bundle.stories || [];
      cache.trendingTags = bundle.trendingTags || [];

      // Warm image caches for all story avatars and media. media_url can hold
      // several comma-joined attachments — prewarm each URL on its own, never
      // the joined string (which 4xx/5xxs the media proxy as one path).
      // Story media is follow-network private now: a raw prewarm would just
      // 404 (and cache nothing), so only public post media is warmed here.
      const imagesToWarm: (string | null | undefined)[] = [];
      const splitUrls = (value?: string | null) =>
        value
          ? value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      bundle.foryou.forEach((p) => {
        imagesToWarm.push(...splitUrls(p.media_url));
      });
      prewarmImages(imagesToWarm);

      return bundle;
    } catch (err) {
      console.warn("Feed preload error (non-fatal, will retry):", err);
      return null;
    } finally {
      ongoingPreloadPromise = null;
    }
  })();

  return ongoingPreloadPromise;
}

// Automatically schedule background prewarm on browser idle
if (typeof window !== "undefined") {
  const schedulePrewarm = () => {
    if ("requestIdleCallback" in window) {
      (window as any).requestIdleCallback(
        () => {
          triggerFeedPreload();
        },
        { timeout: 2000 },
      );
    } else {
      setTimeout(() => {
        triggerFeedPreload();
      }, 500);
    }
  };

  if (document.readyState === "complete") {
    schedulePrewarm();
  } else {
    window.addEventListener("load", schedulePrewarm, { once: true });
  }
}
