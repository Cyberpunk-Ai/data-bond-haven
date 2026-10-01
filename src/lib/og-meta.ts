/**
 * Link previews (WhatsApp, X, Facebook, LinkedIn, Telegram, iMessage…) all key
 * off `og:image`, and they demand an ABSOLUTE url — without one they scrape a
 * fallback icon (the 32px favicon / 180px apple-touch-icon) and the logo lands
 * in the preview card visibly blurry. This module pins the preview to the real
 * 512px brand icon with its dimensions declared so platforms resize it sharply
 * instead of upscaling a favicon.
 *
 * The app deliberately has no "public domain" env key (one build serves
 * localhost, previews and spaces1.com), so the origin is taken from the
 * runtime where one exists — the browser during client navigations — and from
 * the known production origin during SSR, which is the only place a crawler
 * ever actually reads these tags.
 */

/** Deployment's public address; matches the README "production domain" block. */
const PRODUCTION_ORIGIN = "https://spaces1.com";

export function siteOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : PRODUCTION_ORIGIN;
}

/** Highest-resolution brand asset in /public (verified 512×512 PNG). */
export const OG_IMAGE_PATH = "/icon-512.png";

export function ogImageUrl(): string {
  return `${siteOrigin()}${OG_IMAGE_PATH}`;
}

/**
 * Spread into any route head's meta array. Width/height are what let LinkedIn
 * and Twitter reserve the right box and downscale cleanly instead of guessing
 * from a tiny scraped icon.
 */
export const OG_IMAGE_META = [
  { property: "og:image", content: ogImageUrl() },
  { property: "og:image:width", content: "512" },
  { property: "og:image:height", content: "512" },
  { property: "og:image:alt", content: "Spaces1 — the creator social network" },
  { name: "twitter:image", content: ogImageUrl() },
] as const;
