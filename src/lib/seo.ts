import { appConfig } from "@/lib/config";
import { APP_ICON_PATH, PUBLIC_MEDIA_PREFIX, ogImageUrl, siteOrigin } from "@/lib/og-meta";

/**
 * Search-engine plumbing, as pure functions.
 *
 * Everything that decides *what a crawler is told* lives here rather than
 * inline in a route's `head`: which pages exist to be crawled, which are
 * private app surfaces that must never be indexed, what the sitemap looks
 * like, and what the structured data says. That makes each rule testable in
 * node — a canonical tag or an `og:url` that quietly disagrees with the URL the
 * sitemap advertises is exactly the kind of defect nobody notices until rankings
 * drop, and no browser test would ever catch it.
 */

export type ChangeFreq = "daily" | "weekly" | "monthly" | "yearly";

export interface SitemapEntry {
  /** Root-relative path, e.g. "/pricing" or "/u/ada". */
  path: string;
  /** Anything ISO-8601-ish; only the date part is emitted. */
  lastmod?: string | number | null;
  changefreq?: ChangeFreq;
  priority?: number;
}

/**
 * Google's ceiling is 50,000 URLs (or 50 MB) per sitemap file. Staying under it
 * keeps this a single file; past it the answer is a sitemap index with one child
 * per slice, not a silently truncated list.
 */
export const SITEMAP_URL_LIMIT = 45_000;

/**
 * Pages that exist without a database row. Deliberately short: a sitemap is a
 * promise that these URLs are worth crawling, so it advertises only what renders
 * real content to a signed-out visitor.
 */
export const STATIC_SITEMAP_PAGES: SitemapEntry[] = [
  { path: "/", priority: 1, changefreq: "weekly" },
  { path: "/pricing", priority: 0.9, changefreq: "weekly" },
  { path: "/explore", priority: 0.8, changefreq: "daily" },
  { path: "/spaces", priority: 0.8, changefreq: "daily" },
  { path: "/auth", priority: 0.7, changefreq: "monthly" },
  { path: "/about", priority: 0.6, changefreq: "monthly" },
  { path: "/help", priority: 0.5, changefreq: "monthly" },
  { path: "/contact", priority: 0.4, changefreq: "yearly" },
  { path: "/terms", priority: 0.3, changefreq: "yearly" },
  { path: "/privacy", priority: 0.3, changefreq: "yearly" },
  { path: "/guidelines", priority: 0.3, changefreq: "yearly" },
];

/**
 * Signed-in surfaces, transactional endpoints and anything holding somebody
 * else's data. These are `noindex` in their own head *and* disallowed in
 * robots.txt — the tag is the real control, the robots rule only saves crawl
 * budget, because a disallowed URL can still be indexed from inbound links.
 */
export const NOINDEX_PATHS: readonly string[] = [
  "/feed",
  "/messages",
  "/notifications",
  "/bookmarks",
  "/profile",
  "/settings",
  "/admin",
  "/status",
  "/oauth/callback",
  "/billing/callback",
];

/** Normalise a path into the single canonical form: absolute, root-relative, no query, no trailing slash. */
export function canonicalPath(path: string): string {
  const raw = String(path ?? "").trim();
  // Drop the query and any fragment: `?utm_…` and `#section` are the same page.
  const withoutParams = raw.split("?")[0]?.split("#")[0] ?? "";
  // Accept a fully-qualified url too, so callers can pass `request.url`.
  const stripped = withoutParams.replace(/^[a-z]+:\/\/[^/]+/i, "");
  const withLeadingSlash = stripped.startsWith("/") ? stripped : `/${stripped}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  const trimmed = collapsed.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function canonicalHref(path: string, origin: string = siteOrigin()): string {
  return `${origin.replace(/\/+$/, "")}${canonicalPath(path)}`;
}

/**
 * The `<link rel="canonical">` for one route.
 *
 * This belongs in a head's `links` array, never its `meta`: the router renders
 * every `meta` entry as a `<meta>` tag, and `<meta rel="canonical">` is not a
 * canonical — search engines ignore it, so the page silently keeps its duplicate
 * urls. `og:url` *is* a meta tag, which is why the two are separate helpers.
 */
export function canonicalLink(path: string, origin?: string): { rel: "canonical"; href: string } {
  return { rel: "canonical", href: canonicalHref(path, origin) };
}

/** Absolute `og:url` — crawlers resolve relative ones inconsistently. */
export function ogUrlMeta(path: string, origin?: string) {
  return { property: "og:url", content: canonicalHref(path, origin) };
}

export const NOINDEX_META = [{ name: "robots", content: "noindex,nofollow" }] as const;

export function isIndexPath(path: string): boolean {
  return !NOINDEX_PATHS.includes(canonicalPath(path));
}

/**
 * Prefixes blocked to crawlers in `public/robots.txt`.
 *
 * The file is static (a crawler must be able to read it even when the app is
 * not) so the two are kept honest by a test rather than by a build step. Two
 * invariants matter: every `noindex` route must be covered here, and nothing
 * that `STATIC_SITEMAP_PAGES` advertises may be — a URL in the sitemap that
 * robots.txt disallows is a contradiction Google resolves by trusting neither.
 *
 * Callbacks are blocked as directory prefixes (`/oauth/`, `/billing/`) so a
 * future `?step=` child cannot leak through the exact-path form.
 */
export const ROBOTS_DISALLOWED_PREFIXES: readonly string[] = [
  "/feed",
  "/messages",
  "/notifications",
  "/bookmarks",
  "/profile",
  "/settings",
  "/admin",
  "/workspace",
  "/status",
  "/oauth/",
  "/billing/",
  // Server endpoints: reachable, but a crawler following them only burns budget
  // and risks indexing raw JSON as a page.
  "/api/",
];

/**
 * Prefixes explicitly *unblocked* in `public/robots.txt`.
 *
 * Robots rules are matched by longest path, so one line here overrides a
 * shorter `Disallow` above it. The single exception the product actually needs
 * is the public media proxy: a profile's avatar or a post's photo is an
 * `og:image`, a preview bot has to fetch it to build the card, and it lives
 * under `/api/` — which everything else in this namespace is disallowed from.
 * Private folders (stories, DMs, Space replays) are never reachable this way;
 * `previewImageUrl` in `og-meta.ts` refuses to advertise them.
 */
export const ROBOTS_ALLOWED_PREFIXES: readonly string[] = [PUBLIC_MEDIA_PREFIX];

/**
 * Is this path inside a blocked prefix? Compared on the canonical form, and
 * answered the way a crawler's parser would: a more specific `Allow` beats a
 * shorter `Disallow`, so an exception wins rather than being swallowed by the
 * namespace that contains it.
 */
export function isDisallowedForCrawlers(path: string): boolean {
  const target = canonicalPath(path);
  const matches = (prefix: string) => {
    const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return target === prefix || target === base || target.startsWith(base);
  };
  const allowed = ROBOTS_ALLOWED_PREFIXES.filter(matches).reduce(
    (longest, prefix) => (prefix.length > longest.length ? prefix : longest),
    "",
  );
  const blocked = ROBOTS_DISALLOWED_PREFIXES.filter(matches).reduce(
    (longest, prefix) => (prefix.length > longest.length ? prefix : longest),
    "",
  );
  if (allowed && allowed.length >= blocked.length) return false;
  return blocked.length > 0;
}

/**
 * The icon set, in the order a browser should read it.
 *
 * `favicon.ico` stays because it is still what some crawlers, feed readers and
 * Windows shortcuts request when they ignore `<link>` tags — and it now carries
 * a legacy 32px bitmap alongside a 192px and a 512px PNG, so a tab icon stops
 * being an upscale of a 32px square on a high-dpi screen. The sized PNG links
 * are what modern browsers pick; declaring `sizes` is what lets them pick
 * instead of guess.
 *
 * No `mask-icon` line: that needs a monochrome SVG, and shipping one would mean
 * inventing brand artwork rather than reusing the existing marks.
 */
export const ICON_LINKS = [
  { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
  { rel: "icon", href: "/icon-192.png", type: "image/png", sizes: "192x192" },
  { rel: "icon", href: "/icon-512.png", type: "image/png", sizes: "512x512" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
  { rel: "manifest", href: "/manifest.webmanifest" },
] as const;

/** `2026-10-03T07:12:00Z` → `2026-10-03`; a garbage date is omitted, not guessed. */
export function sitemapDate(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}

/**
 * XML text escaping. `&` first, or every entity added afterwards gets escaped
 * again — a username like `a&b` would otherwise emit `&amp;amp;`.
 */
export function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function sitemapEntryXml(entry: SitemapEntry, origin: string = siteOrigin()): string {
  const url = canonicalHref(entry.path, origin);
  const parts = [`  <url>\n    <loc>${escapeXml(url)}</loc>`];
  const lastmod = sitemapDate(entry.lastmod);
  if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
  if (entry.changefreq) parts.push(`    <changefreq>${entry.changefreq}</changefreq>`);
  if (typeof entry.priority === "number") {
    const p = Math.max(0, Math.min(1, entry.priority));
    parts.push(`    <priority>${p.toFixed(1)}</priority>`);
  }
  parts.push("  </url>");
  return parts.join("\n");
}

/**
 * A complete urlset. Entries are de-duplicated on the canonical path — the same
 * URL twice (a static page also produced by a DB row, say) is a soft
 * inconsistency Google reports as a duplicate, so the first one wins.
 */
export function buildSitemapXml(entries: SitemapEntry[], origin: string = siteOrigin()): string {
  const seen = new Set<string>();
  const unique: SitemapEntry[] = [];
  for (const entry of entries) {
    const key = canonicalPath(entry.path);
    if (!isIndexPath(key) || seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
    if (unique.length >= SITEMAP_URL_LIMIT) break;
  }
  const body = unique.map((entry) => sitemapEntryXml(entry, origin)).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    "</urlset>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Structured data. JSON-LD rather than microdata: it is what Google parses most
// reliably, and it survives a markup refactor because it never sits inside the
// visual tree.
// ---------------------------------------------------------------------------

/**
 * The product's name, as one source of truth.
 *
 * `VITE_APP_NAME` already renames the static pages (`appConfig.brand.name`), so
 * anything a crawler or a search result reads has to come from the same place —
 * a hardcoded copy here is how a rebranded deployment keeps describing itself
 * as the old product in its structured data.
 */
export const ORG_NAME = appConfig.brand.name;

/**
 * `<label> — <brand>`, the title shape every route head uses.
 *
 * Kept as a function rather than ten template literals so the em-dash form is
 * consistent across the tab strip, search results and the history menu — and so
 * a grep for a hardcoded product name in a `head` has exactly one answer.
 */
export function brandedTitle(label: string): string {
  const name = String(label ?? "").trim();
  return name ? `${name} — ${ORG_NAME}` : ORG_NAME;
}

export function organizationJsonLd(origin: string = siteOrigin()) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    // Addressed by `websiteJsonLd`'s publisher reference: the two documents only
    // merge into one entity graph if the node actually has this id.
    "@id": `${origin}/#/organization`,
    name: ORG_NAME,
    url: `${origin}/`,
    // Google wants a square mark of at least 112x112 for the entity logo.
    logo: ogImageUrl(APP_ICON_PATH),
    // No `sameAs`: it means "the same organisation, on another platform", and
    // inventing handles we have not verified is worse than leaving it out.
  };
}

/**
 * The `SearchAction` is what earns a sitelinks search box: the query template is
 * declared with `{search_term_string}` in braces, which must not be URL-encoded
 * or the matcher never fires.
 */
export function websiteJsonLd(origin: string = siteOrigin()) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: ORG_NAME,
    url: `${origin}/`,
    publisher: { "@id": `${origin}/#/organization` },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${origin}/explore?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export function profileJsonLd(opts: {
  username: string;
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  followers?: number;
  origin?: string;
}) {
  const origin = opts.origin ?? siteOrigin();
  // Handles are user data: encode for the url, keep the raw text for `name`.
  const profileUrl = `/u/${encodeURIComponent(opts.username)}`;
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: opts.displayName,
    alternateName: `@${opts.username}`,
    identifier: `@${opts.username}`,
    url: canonicalHref(profileUrl, origin),
    description: opts.bio || undefined,
    image: opts.avatarUrl || undefined,
    interactionStatistic:
      opts.followers && opts.followers > 0
        ? {
            "@type": "InteractionCounter",
            interactionType: "https://schema.org/FollowAction",
            userInteractionCount: opts.followers,
          }
        : undefined,
    // No `sameAs`: this profile *is* the page it would point at, and `url`
    // already says so — a self-reference adds nothing a parser can use.
  };
}

export function postJsonLd(opts: {
  id: string;
  content: string;
  authorName: string;
  authorUsername: string;
  createdAt: string;
  likeCount?: number;
  commentCount?: number;
  origin?: string;
}) {
  const origin = opts.origin ?? siteOrigin();
  const text = String(opts.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const profileUrl = `/u/${encodeURIComponent(opts.authorUsername)}`;
  return {
    "@context": "https://schema.org",
    "@type": "SocialMediaPosting",
    headline: text.slice(0, 110),
    articleBody: text || undefined,
    datePublished: opts.createdAt,
    url: canonicalHref(`/post/${opts.id}`, origin),
    isPartOf: {
      "@type": "WebSite",
      name: ORG_NAME,
      url: `${origin}/`,
    },
    author: {
      "@type": "Person",
      name: opts.authorName,
      url: canonicalHref(profileUrl, origin),
    },
    interactionStatistic: [
      opts.likeCount
        ? {
            "@type": "InteractionCounter",
            interactionType: "https://schema.org/LikeAction",
            userInteractionCount: opts.likeCount,
          }
        : null,
      opts.commentCount
        ? {
            "@type": "InteractionCounter",
            interactionType: "https://schema.org/CommentAction",
            userInteractionCount: opts.commentCount,
          }
        : null,
    ].filter(Boolean),
  };
}

export function breadcrumbJsonLd(
  items: Array<{ name: string; path: string }>,
  origin: string = siteOrigin(),
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: canonicalHref(item.path, origin),
    })),
  };
}

/**
 * One JSON-LD document for a route's `meta`, holding one or many schema objects.
 *
 * `script:ld+json` is the head entry the router turns into
 * `<script type="application/ld+json">`. It also serialises the payload and
 * escapes `&`, `<`, `>` and the line/paragraph separators as `\u003c`-style json
 * escapes, which is what makes it safe to feed it user-authored display names and
 * post text: a literal `</script>` in somebody's profile cannot close the tag
 * early, and the escapes are inside string values, so parsing restores the text.
 * `JSON.stringify` drops `undefined` members on its own, which is why the
 * builders below set optional fields to `undefined` rather than omitting keys.
 *
 * Two other ways here were tried against a running server and do not work: a
 * `links`-shaped object placed in `meta` renders as a `<meta>` tag (so a
 * canonical written that way is inert), and a `headScripts` key is never read —
 * the head function's own `scripts` array is what maps to the match's
 * `headScripts`. One `meta` entry is the only thing that lands json in `<head>`.
 *
 * It has to be in the head: the crawlers that use structured data (and every
 * link-preview bot) read the document before they run any JavaScript.
 *
 * The two `undefined` members exist only for the type checker: a route's `meta`
 * array is typed as html meta attributes (`MetaHTMLAttributes`), which has no
 * shared property with a `script:ld+json` key and would reject the entry as an
 * object with "no properties in common". The tag builder looks for
 * `script:ld+json` before it ever builds a `<meta>`, so those optional members
 * are never rendered and cannot be set from outside this function.
 */
export function jsonLdBlock(...docs: unknown[]): {
  "script:ld+json": unknown;
  name?: undefined;
  content?: undefined;
} {
  return { "script:ld+json": docs.length === 1 ? docs[0] : docs };
}
