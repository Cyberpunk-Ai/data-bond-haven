import { preloadFeedBundle, PreloadBundleResponse } from "./api-client";
import type { Post, Story, Space, TrendingTag } from "./types";
import { optimizeImageUrl } from "./utils";

interface MemoryFeedCache {
  bundle: PreloadBundleResponse | null;
  lastFetchedAt: number;
  foryou: Post[];
  following: Post[];
  latest: Post[];
  stories: Story[];
  spaces: Space[];
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
  spaces: [],
  trendingTags: [],
  prefetchedImages: new Set<string>(),
};

const CACHE_TTL_MS = 30_000; // 30 seconds fresh window before background refresh

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
    spaces: cache.spaces,
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
      cache.spaces = bundle.spaces || [];
      cache.trendingTags = bundle.trendingTags || [];

      // Warm image caches for all story avatars and media
      const imagesToWarm: (string | null | undefined)[] = [];
      bundle.stories.forEach((s) => {
        imagesToWarm.push(s.media_url);
      });
      bundle.foryou.forEach((p) => {
        if (p.media_url) imagesToWarm.push(p.media_url);
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
