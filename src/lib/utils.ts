import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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

/** Current vertical scroll offset of the app's real scrolling element. */
export function getScrollY(): number {
  const el = getScrollContainer();
  return el ? el.scrollTop : (typeof window !== "undefined" ? window.scrollY : 0);
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
  const el = getScrollContainer();
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
