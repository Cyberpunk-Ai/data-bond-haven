import { appConfig } from "@/lib/config";
import { isVideoUrl } from "@/lib/utils";

/**
 * Link-preview (open graph) metadata, as pure rules.
 *
 * Every platform that renders a shared link — WhatsApp, X, Facebook, LinkedIn,
 * Telegram, Slack, Discord, iMessage — keys off `og:image`, and it demands an
 * ABSOLUTE url: without one they scrape a fallback icon (the 32px favicon /
 * 180px apple-touch-icon) and the preview lands blurry and letterboxed. This
 * module owns both halves of that promise: the site's own card, and the rule
 * for when a *page's* image (a person's avatar, a post's photo) may replace it.
 *
 * The app deliberately has no "public domain" env key (one build serves
 * localhost, previews and spaces1.com), so the origin is taken from the runtime
 * where one exists — the browser during client navigations — and from the known
 * production origin during SSR, which is the only place a crawler ever actually
 * reads these tags.
 */

/** Deployment's public address; matches the README "production domain" block. */
const PRODUCTION_ORIGIN = "https://spaces1.com";

export function siteOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : PRODUCTION_ORIGIN;
}

/**
 * The site card: 1200x630, the ratio every previewer asks for. Built from the
 * real mark by `scripts/build-og-image.ps1`, never hand-drawn, so it cannot
 * drift from the app icon.
 */
export const OG_IMAGE_PATH = "/og-image.png";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/**
 * The square app mark, for the slots that want one: the PWA manifest, the
 * notification icon, and schema.org's `Organization.logo` (which asks for a
 * square image and rejects a wide banner).
 */
export const APP_ICON_PATH = "/icon-512.png";

/**
 * The read proxy for world-readable objects, and the only `/api/` prefix a
 * crawler is allowed into (see `ROBOTS_ALLOWED_PREFIXES` in `seo.ts`, which is
 * built from this constant so the two cannot drift apart).
 */
export const PUBLIC_MEDIA_PREFIX = "/api/public/media/";

export function ogImageUrl(path: string = OG_IMAGE_PATH): string {
  return `${siteOrigin().replace(/\/+$/, "")}${path}`;
}

/**
 * The `og:image` family for one url, sized and described.
 *
 * `width`/`height` are what let LinkedIn and X reserve the right box and
 * downscale cleanly instead of guessing from a scraped favicon; they are only
 * ever passed for the fixed site card, because a user's photo has dimensions
 * nobody checked before it was uploaded (and a wrong declared size is worse
 * than none — the platform crops to the lie).
 *
 * Passing `null` for a size emits the tag with an EMPTY `content`. That is not
 * decoration: the root head spreads the site card into every route, the router
 * dedupes meta by `name`/`property` alone (deepest match wins, see
 * `headContentUtils`), and `og:image:width` is a different key from `og:image`.
 * So a page that swaps in an avatar would otherwise keep advertising the site
 * card's 1200x630 under a 96px picture — and the platforms crop to that lie.
 * A page overriding its image must therefore re-declare, and empty means
 * "measured nowhere, guess from the bytes" — which is exactly the truth.
 */
export function ogImageMeta(
  url: string,
  opts: {
    width?: number | null;
    height?: number | null;
    alt?: string;
  } = {},
) {
  const { width, height } = opts;
  const meta: Array<{ property?: string; name?: string; content: string }> = [
    { property: "og:image", content: url },
  ];
  if (width !== undefined) {
    meta.push({ property: "og:image:width", content: width === null ? "" : String(width) });
  }
  if (height !== undefined) {
    meta.push({ property: "og:image:height", content: height === null ? "" : String(height) });
  }
  meta.push({
    property: "og:image:alt",
    content: opts.alt ?? `${appConfig.brand.name} — creator social network`,
  });
  // X reads `twitter:image` rather than falling back to og:image on some card
  // types, so a page that swaps its preview image has to say so twice.
  meta.push({ name: "twitter:image", content: url });
  return meta;
}

/** Spread into any route head's meta array for the default site card. */
export const OG_IMAGE_META = ogImageMeta(ogImageUrl(), {
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  alt: `${appConfig.brand.name} — ${appConfig.brand.tagline}`,
});

/**
 * Object folders whose bytes are world-readable.
 *
 * Mirrors `MEDIA_FOLDER_VISIBILITY` in `src/lib/media-folders.server.ts`, which
 * is the authority: that file cannot be imported here (it is server-only and
 * pulls in credentials), and a preview tag must never advertise an object that
 * only the author can read. A test compares the two lists, so adding a folder
 * on the server without deciding its preview-ability here fails loudly.
 */
const PRIVATE_MEDIA_FOLDERS = ["messages", "recordings", "stories"] as const;

/**
 * The folders whose objects the proxy will serve to an anonymous reader: the
 * other half of the same mirror, and deliberately an allow-list rather than
 * "whatever is not on the deny-list". A new media type added on the server
 * starts life unlisted here, so the worst a share can do with it is fall back
 * to the site card — never hand a stranger an object key that turns out to be
 * somebody's private file.
 */
const PUBLIC_MEDIA_FOLDERS = ["avatars", "posts", "media"] as const;

/** Exposed for the tests that keep both lists in step with the server's ACL. */
export const NON_PREVIEWABLE_MEDIA_FOLDERS: readonly string[] = PRIVATE_MEDIA_FOLDERS;
export const PREVIEWABLE_MEDIA_FOLDERS: readonly string[] = PUBLIC_MEDIA_FOLDERS;

/**
 * The first image of a stored media value that a link preview may fetch, as an
 * absolute url — or null to fall back to the site card.
 *
 * Stored media columns are messy by design, and every rule below exists
 * because one of those shapes produced a broken or leaking preview:
 *
 * - `posts.media_url` holds several comma-joined urls for a multi-image post,
 *   so only the first is a single object.
 * - Avatars and post photos are root-relative `/api/public/media/<key>` paths
 *   (storage-agnostic by policy), which a crawler cannot resolve without the
 *   origin glued on. Some deployments front a CDN, so an absolute url is also
 *   possible and is kept as-is.
 * - DM attachments, Space replays and story media are private: the proxy
 *   answers 404 without a capability, so pointing a preview at one produces a
 *   broken image for the person who shared it — and puts an object key that
 *   names a private conversation in a public page's source.
 * - `data:` urls are inline base64 that no previewer fetches, and can be
 *   megabytes long inside a `<meta>` tag.
 * - A video is not an image. `og:image` pointing at an mp4 renders an empty
 *   card on every platform, so a video post keeps the site card (there is no
 *   stored poster frame to offer instead).
 */
export function previewImageUrl(raw: string | null | undefined): string | null {
  const first = String(raw ?? "")
    .split(",")[0]
    ?.trim();
  if (!first || first.toLowerCase().startsWith("data:")) return null;
  if (isVideoUrl(first)) return null;

  // Anywhere in the value, not just after the marker: an absolute copy of a
  // private url is just as private as the relative form.
  const lower = first.toLowerCase();
  if (
    PRIVATE_MEDIA_FOLDERS.some(
      (folder) => lower.includes(`/${folder}/`) || lower.startsWith(`${folder}/`),
    )
  ) {
    return null;
  }

  if (/^https?:\/\//i.test(first)) return first;
  if (first.startsWith("/")) return `${siteOrigin().replace(/\/+$/, "")}${first}`;
  // A bare storage key. Only a folder declared world-readable is fetchable.
  const folder = first.split("/")[0]?.toLowerCase();
  if (folder && (PUBLIC_MEDIA_FOLDERS as readonly string[]).includes(folder)) {
    return ogImageUrl(`${PUBLIC_MEDIA_PREFIX}${first}`);
  }
  return null;
}

/**
 * `og:image` for a page that has a picture of its own (a profile's avatar, a
 * post's photo), falling back to the site card when it has none.
 *
 * When a page's own image replaces the site card, the card's declared 1200x630
 * has to be cleared as well — see `ogImageMeta` for why an empty `content` is
 * the mechanism rather than omitting the tag.
 */
export function pagePreviewMeta(raw: string | null | undefined, alt?: string) {
  const url = previewImageUrl(raw);
  if (!url) return OG_IMAGE_META;
  return ogImageMeta(url, {
    width: null,
    height: null,
    ...(alt ? { alt } : {}),
  });
}

/**
 * The `twitter:card` for a page whose own picture is a *face* — a profile
 * avatar or a team logo, which is how this is used.
 *
 * X crops `summary_large_image` to 1.91:1 and shows `summary`'s thumbnail
 * uncropped, so a square avatar in the wide card arrives with its chin cut off.
 * Once the page has no fetchable picture the site card takes over, and that one
 * is already 1.91:1, so the wide card is restored — declaring `summary` there
 * would shrink a banner made to be shown big.
 *
 * A post's photo is deliberately NOT routed through here: content photos are
 * what a shared link is about, and every social platform shows them big and
 * centre-cropped, which is the expectation people recognise.
 */
export function previewCardFor(raw: string | null | undefined): "summary" | "summary_large_image" {
  return previewImageUrl(raw) ? "summary" : "summary_large_image";
}
