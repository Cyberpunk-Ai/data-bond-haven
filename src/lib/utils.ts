import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Ceiling for a paginated page request (feed, profile tabs, notifications,
 * explore). A serverless call or PostgREST query can stall on a cold start or
 * a flaky connection; without this the await never settles, the "loading more"
 * spinner stays up forever and the list looks stuck — the bug users reported
 * as "it hangs on load more". Rejecting lets the caller drop the spinner and
 * offer a retry instead.
 */
export const PAGE_REQUEST_TIMEOUT_MS = 15_000;

/** Reject `promise` if it hasn't settled within `ms`; otherwise pass it through. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * On large screens the AppShell's <main> is its own scroll container
 * (lg:h-screen lg:overflow-hidden + lg:overflow-y-auto), so window scroll
 * events never fire there. These helpers talk to whichever element actually
 * scrolls, letting sticky-reveal / auto-hide UI work on every breakpoint.
 */
export function getScrollContainer(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const main = document.getElementById("app-main");
  if (main && main.scrollHeight > main.clientHeight) return main;
  return null;
}

/**
 * The AppShell's persistent desktop scroll region, WITHOUT the overflow test
 * that `getScrollContainer()` applies. A scroll listener has to be wired to the
 * node that *will* scroll, not only one that happens to be overflowing at the
 * moment we subscribe: on lg+ the feed is short (skeleton, or a restored one-
 * page snapshot) when the reveal effect first runs, so gating on `scrollHeight >
 * clientHeight` skipped the `<main>` binding entirely and left only `window` —
 * which never scrolls on desktop. Result: the sticky tab/refresh header stopped
 * revealing on scroll-up. Reading the offset still wants the overflow-aware
 * `getScrollContainer()`; subscribing wants this stable element.
 */
function getScrollMain(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById("app-main");
}

/** Current vertical scroll offset of the app's real scrolling element. */
export function getScrollY(): number {
  const el = getScrollContainer();
  return el ? el.scrollTop : typeof window !== "undefined" ? window.scrollY : 0;
}

/** Smoothly return the app's real scrolling element to the top. */
export function scrollToTop(): void {
  const el = getScrollContainer();
  if (el) el.scrollTo({ top: 0, behavior: "smooth" });
  else if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Subscribe to scroll events on both the window and the <main> container.
 * Returns the unsubscribe function. The container listener is capture-phase
 * so it also catches nested scrollable panels if breakpoints shift.
 */
export function onAppScroll(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const el = getScrollMain();
  window.addEventListener("scroll", handler, { passive: true });
  el?.addEventListener("scroll", handler, { passive: true, capture: true });
  return () => {
    window.removeEventListener("scroll", handler, { capture: false } as never);
    el?.removeEventListener("scroll", handler, { capture: true } as never);
  };
}

/**
 * Ensures image URLs (e.g. Unsplash) are served with optimal dimension parameters
 * and WebP compression for rapid page loads and minimal bandwidth usage.
 */
export function optimizeImageUrl(url: string | undefined | null, width = 1000): string {
  if (!url) return "";
  if (url.includes("images.unsplash.com")) {
    try {
      const u = new URL(url);
      u.searchParams.set("auto", "format");
      u.searchParams.set("fit", "crop");
      u.searchParams.set("w", String(width));
      u.searchParams.set("q", "80");
      return u.toString();
    } catch {
      return url;
    }
  }
  return url;
}

/**
 * True when a media URL points at a video rather than an image. A media_url can
 * hold several comma-joined attachments and the `media_type` column isn't always
 * set, so every surface that renders a thumbnail (PostCard, explore's media
 * grid) detects video by URL signature to decide between <video> and <img>.
 * Single source of truth — previously duplicated as isMediaVideo/isVideoUrl.
 */
export function isVideoUrl(url?: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes(".mp4") ||
    lower.includes(".webm") ||
    lower.includes(".mov") ||
    lower.includes(".m4v") ||
    lower.includes(".ogv") ||
    lower.includes("oggtheora") ||
    lower.startsWith("data:video") ||
    lower.includes("/video/") ||
    lower.includes("video_")
  );
}

/**
 * The first attachment of a media column, as a single url.
 *
 * A multi-image post stores its attachments comma-joined in one column, so the
 * raw value is never directly usable as an element's `src`: handing
 * `a.jpg,b.jpg` to an `<img>` produces a broken image, which is exactly what
 * every surface that shows only one frame has to avoid. Thumbnails, previews
 * and link cards all want "the first one", so it is decided here.
 */
export function firstMediaUrl(raw?: string | null): string | null {
  for (const part of String(raw ?? "").split(",")) {
    const url = part.trim();
    if (url) return url;
  }
  return null;
}
