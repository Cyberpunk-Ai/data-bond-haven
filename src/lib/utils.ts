import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
