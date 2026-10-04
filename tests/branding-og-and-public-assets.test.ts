// @vitest-environment node
/**
 * Branding, link-preview art and the public asset set.
 *
 * Same house model as the rest of `tests/`: the decisions are pure functions
 * tested directly, and the parts that only exist as source or as bytes on disk
 * (route heads, the manifest, robots.txt, the actual png files) are tested as
 * contracts. Every check here corresponds to a failure that is invisible until
 * somebody shares a link or installs the app: a card that is a square image
 * letterboxed into a 1.91:1 slot, a `theme-color` that stopped matching the
 * accent, an `<img>` handed a comma-joined media column, a rebranded deployment
 * still calling itself the old product in its own structured data.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseOklch, toCssHex } from "@/lib/oklch";
import { appConfig } from "@/lib/config";
import {
  APP_ICON_PATH,
  NON_PREVIEWABLE_MEDIA_FOLDERS,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  PREVIEWABLE_MEDIA_FOLDERS,
  PUBLIC_MEDIA_PREFIX,
  pagePreviewMeta,
  previewCardFor,
  previewImageUrl,
} from "@/lib/og-meta";
import { ICON_LINKS, ORG_NAME, brandedTitle } from "@/lib/seo";
import { ACCENT_PALETTES, DEFAULT_THEME_COLOR, themeColorFor } from "@/lib/theme-state";
import { firstMediaUrl, isVideoUrl } from "@/lib/utils";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const publicFile = (href: string) => new URL(`../public${href}`, import.meta.url);
/** Real PNG dimensions, straight out of the IHDR header (bytes 16..23). */
const pngSize = (href: string) => {
  const bytes = readFileSync(publicFile(href));
  expect(bytes.subarray(1, 4).toString("ascii"), `${href} is not a png`).toBe("PNG");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
};

describe("oklch converts to the hex a browser would paint", () => {
  it("hits the primaries, the neutrals and the house brand exactly", () => {
    // The spec's own oklch coordinates for sRGB red and blue, to full precision:
    // if the conversion chain (oklch -> oklab -> linear sRGB -> gamma) is off by
    // a step, these are the two anchors that show it.
    expect(toCssHex("oklch(0.6279553935557614 0.25795239339409965 29.233889687988826)")).toBe(
      "#ff0000",
    );
    expect(toCssHex("oklch(0.4520367376974926 0.3135783574619273 264.05222369720665)")).toBe(
      "#0000ff",
    );
    expect(toCssHex("oklch(0.556 0 0)")).toBe("#737373");
    expect(toCssHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(toCssHex("oklch(0 0 0)")).toBe("#000000");
    // `--brand` in src/styles.css. This is the number the manifest and the
    // server-rendered `theme-color` both claim, so it is checked, not assumed.
    expect(toCssHex(ACCENT_PALETTES.violet.brand)).toBe("#7f22fe");
  });

  it("reads the spec's other spellings and passes plain hex through", () => {
    expect(toCssHex("oklch(54.1% 0.281 293.009)")).toBe("#7f22fe");
    expect(toCssHex("oklch(0.541, 0.281, 293.009)")).toBe("#7f22fe");
    expect(toCssHex("oklch(0.541 0.281 293.009deg)")).toBe("#7f22fe");
    expect(toCssHex("#ABC")).toBe("#aabbcc");
    expect(toCssHex("#7f22fe")).toBe("#7f22fe");
    expect(toCssHex("red")).toBeNull();
    expect(toCssHex("")).toBeNull();
    expect(parseOklch("hsl(0 100% 50%)")).toBeNull();
  });
});

describe("theme-color agrees with the stylesheet, the manifest and the accent", () => {
  it("is derived from the accent rather than hand-copied", () => {
    expect(themeColorFor()).toBe(DEFAULT_THEME_COLOR);
    expect(themeColorFor("violet")).toBe(toCssHex(ACCENT_PALETTES.violet.brand));
    expect(DEFAULT_THEME_COLOR).toBe("#7f22fe");
    for (const accent of Object.keys(ACCENT_PALETTES)) {
      expect(themeColorFor(accent as keyof typeof ACCENT_PALETTES)).toMatch(/^#[0-9a-f]{6}$/);
    }
    // An unknown accent must still paint something, and it must paint the brand.
    expect(themeColorFor("nope" as never)).toBe(DEFAULT_THEME_COLOR);
  });

  it("the manifest and the canvas tokens tell the same story", () => {
    const manifest = JSON.parse(read("../public/manifest.webmanifest"));
    const css = read("../src/styles.css");
    // The stylesheet is the authority for the canvas; the manifest copies it as a
    // hex. The block is located with plain string scanning rather than a
    // generated regex, for two reasons: an unescaped `.` in a pattern would also
    // match `:is(.dark *)` in the @custom-variant line above the rules, and this
    // toolchain rewrites escapes inside interpolated template literals (turning
    // `\s` into a literal backslash-s, which matches nothing).
    const token = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, `no \`${selector} {\` rule found in styles.css`).toBeGreaterThan(-1);
      const value = /--background:\s*([^;]+);/.exec(css.slice(start))?.[1]?.trim();
      expect(value, `no --background token inside the \`${selector}\` block`).toBeTruthy();
      return value!;
    };
    expect(manifest.theme_color).toBe(themeColorFor());
    expect(manifest.background_color).toBe(toCssHex(token(":root")!));
    expect(toCssHex(token(".dark")!)).toBe("#010205");
  });

  it("the head declares it and a theme change re-points it", () => {
    const root = read("../src/routes/__root.tsx");
    expect(root).toContain('{ name: "theme-color", content: themeColorFor() }');
    // The tag cannot follow the user's accent on its own: applying the theme has
    // to rewrite it, or the toolbar keeps the brand the deployment shipped with.
    const theme = read("../src/lib/theme-state.ts");
    expect(theme).toContain("syncThemeColor(settings.accent)");
    expect(theme).toContain('meta[name="theme-color"]');
  });
});

describe("preview images are absolute, fetchable and never private", () => {
  it("takes the first attachment of a multi-image post", () => {
    expect(previewImageUrl("/api/public/media/posts/a.jpg,/api/public/media/posts/b.jpg")).toBe(
      "https://spaces1.com/api/public/media/posts/a.jpg",
    );
  });

  it("refuses the shapes that produced a broken or leaking card", () => {
    // Inline base64: no previewer fetches it, and it can be megabytes of tag.
    expect(previewImageUrl("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    // Private objects: the proxy 404s without a capability, and the key names a
    // conversation that has no business appearing in a public page's source.
    for (const folder of NON_PREVIEWABLE_MEDIA_FOLDERS) {
      expect(previewImageUrl(`${PUBLIC_MEDIA_PREFIX}${folder}/x.jpg`), folder).toBeNull();
      expect(
        previewImageUrl(`https://spaces1.com${PUBLIC_MEDIA_PREFIX}${folder}/x.jpg`),
      ).toBeNull();
      expect(previewImageUrl(`${folder}/x.jpg`), folder).toBeNull();
    }
    // A video is not an image: every platform renders an empty card for one.
    expect(previewImageUrl("/api/public/media/posts/clip.mp4")).toBeNull();
    // Unknown folders fail closed, exactly like the server's ACL does.
    expect(previewImageUrl("mystery/x.jpg")).toBeNull();
    expect(previewImageUrl("   ")).toBeNull();
    expect(previewImageUrl(null)).toBeNull();
  });

  it("absolutises the two public forms a media column actually holds", () => {
    expect(previewImageUrl("/api/public/media/avatars/me.jpg")).toBe(
      "https://spaces1.com/api/public/media/avatars/me.jpg",
    );
    // A bare storage key becomes the proxy url for its public folder.
    expect(previewImageUrl("posts/ada/frame.jpg")).toBe(
      "https://spaces1.com/api/public/media/posts/ada/frame.jpg",
    );
    // A CDN-fronted deployment is already absolute; glueing an origin to it
    // again would be a broken url.
    expect(previewImageUrl("https://cdn.example.com/posts/a.jpg")).toBe(
      "https://cdn.example.com/posts/a.jpg",
    );
  });

  it("a page with no fetchable picture keeps the site card", () => {
    const site = new Map(OG_KEYS(pagePreviewMeta(null)));
    const textOnlyPost = new Map(OG_KEYS(pagePreviewMeta("posts/clip.mp4")));
    expect(site.get("og:image")).toBe(`https://spaces1.com${OG_IMAGE_PATH}`);
    expect(textOnlyPost.get("og:image")).toBe(site.get("og:image"));
  });

  it("clears the site card's size rather than reusing it for an unmeasured photo", () => {
    // The root head spreads the site card's 1200x630 into EVERY route, and the
    // router dedupes meta by key with the deepest match winning. A page that
    // swaps in a user's photo was never measured, so it must NOT inherit that
    // size — leaving it would make the platform crop the preview to a lie. The
    // only lever a child route has is to override the key, so it declares it
    // empty ("guess from the bytes"), which beats the root's 1200.
    const own = new Map(OG_KEYS(pagePreviewMeta("posts/ada/frame.jpg", "a photo")));
    expect(own.get("og:image")).toBe("https://spaces1.com/api/public/media/posts/ada/frame.jpg");
    expect(own.get("og:image:width")).toBe("");
    expect(own.get("og:image:height")).toBe("");
    expect(own.get("og:image:alt")).toBe("a photo");
    // The site card keeps its real measured size.
    const site = new Map(OG_KEYS(pagePreviewMeta(null)));
    expect(site.get("og:image:width")).toBe(String(OG_IMAGE_WIDTH));
    expect(site.get("og:image:height")).toBe(String(OG_IMAGE_HEIGHT));
  });

  it("says the image twice, because X reads twitter:image rather than falling back", () => {
    const own = new Map(OG_KEYS(pagePreviewMeta("avatars/ada.png")));
    expect(own.get("twitter:image")).toBe(own.get("og:image"));
  });

  it("picks the card type by what the image is", () => {
    expect(previewCardFor("/api/public/media/avatars/ada.png")).toBe("summary");
    expect(previewCardFor(null)).toBe("summary_large_image");
    expect(previewCardFor("messages/ada.png")).toBe("summary_large_image");
  });

  it("no page that shows the wide site card asks for the small one", () => {
    // A route that keeps the site card inherits `og:image` = the 1200x630 banner
    // from the root head; declaring `twitter:card=summary` there shrinks that
    // banner to a thumbnail beside the text. Only an item page that swaps in a
    // face (an avatar or team logo, via `previewCardFor`) should say `summary`,
    // and that value is computed, never a literal. `auth.tsx` is the one frozen
    // exception (sign-in copy is off-limits).
    const routes = readdirSync(fileURLToPath(new URL("../src/routes", import.meta.url)))
      .filter((f) => f.endsWith(".tsx") && f !== "auth.tsx")
      .sort();
    for (const file of routes) {
      expect(
        read(`../src/routes/${file}`),
        `src/routes/${file} forces the small card under the wide site image`,
      ).not.toContain('name: "twitter:card", content: "summary"');
    }
  });

  it("mirrors the server's folder ACL rather than guessing it", () => {
    const server = read("../src/lib/media-folders.server.ts");
    const block = /MEDIA_FOLDER_VISIBILITY[^{]*\{([\s\S]*?)\};/.exec(server)?.[1] ?? "";
    const entries = [...block.matchAll(/([a-z_]+):\s*"(public|authed|private)"/g)];
    expect(entries.length, "parsed the visibility map").toBeGreaterThan(3);
    const named = (keep: (visibility: string) => boolean) =>
      entries
        .filter(([, , visibility]) => keep(visibility))
        .map(([, folder]) => folder)
        .sort();
    const isPublic = (visibility: string) => visibility === "public";
    // Adding a folder on the server without deciding whether a share may
    // advertise it fails here, with both lists in the diff.
    expect([...NON_PREVIEWABLE_MEDIA_FOLDERS].sort()).toEqual(named((v) => !isPublic(v)));
    expect([...PREVIEWABLE_MEDIA_FOLDERS].sort()).toEqual(named(isPublic));
  });
});

describe("a media column is only ever rendered as one attachment", () => {
  it("firstMediaUrl agrees with previewImageUrl's idea of 'the first one'", () => {
    expect(firstMediaUrl("a.jpg, b.jpg")).toBe("a.jpg");
    expect(firstMediaUrl(" , , c.jpg")).toBe("c.jpg");
    expect(firstMediaUrl("")).toBeNull();
    expect(firstMediaUrl(null)).toBeNull();
    expect(firstMediaUrl(undefined)).toBeNull();
    // The two rules read the same column for the same reason, so they must not
    // disagree about which attachment is first.
    const joined = "/api/public/media/posts/a.jpg,/api/public/media/posts/b.jpg";
    expect(previewImageUrl(joined)).toBe(`https://spaces1.com${firstMediaUrl(joined)}`);
  });

  it("the shared-post fallback uses it instead of the raw column", () => {
    const src = read("../src/routes/post.$id.tsx");
    expect(src).toContain("firstMediaUrl(post?.mediaUrl)");
    expect(src).toContain("src={shareMedia}");
    // A video attachment gets a player, not a broken image.
    expect(src).toContain("isVideoUrl(shareMedia)");
    expect(src).toMatch(/<video[\s\S]*controls/);
    expect(src).not.toContain("src={post.mediaUrl}");
    // Explore's media grid used to re-implement the split inline; both surfaces
    // now call the same rule.
    const explore = read("../src/routes/explore.tsx");
    expect(explore).toContain("firstMediaUrl(");
    expect(explore).not.toContain('.split(",")[0]');
  });

  it("recognises the container names the uploader can produce", () => {
    for (const url of ["a.mp4", "a.webm", "a.mov", "/video/b", "video_c.mp4"]) {
      expect(isVideoUrl(url), url).toBe(true);
      expect(previewImageUrl(`posts/${url}`), url).toBeNull();
    }
    expect(isVideoUrl("a.jpg")).toBe(false);
  });
});

describe("one brand name reaches everything the product says about itself", () => {
  it("the crawler-facing strings come from config, not from a copy", () => {
    expect(ORG_NAME).toBe(appConfig.brand.name);
    expect(brandedTitle("Settings")).toBe(`Settings — ${appConfig.brand.name}`);
    expect(brandedTitle("  Padded  ")).toBe(`Padded — ${appConfig.brand.name}`);
    expect(brandedTitle("")).toBe(appConfig.brand.name);
    const jsonld = read("../src/lib/seo.ts");
    expect(jsonld).toContain("export const ORG_NAME = appConfig.brand.name;");
  });

  it("no route hardcodes the product name any more", () => {
    // `index.tsx` (landing) and `auth.tsx` (sign-in) are frozen for compliance
    // review, so their copy is excluded from this contract by name rather than
    // the rule being quietly weakened for everything else.
    const frozen = new Set(["index.tsx", "auth.tsx"]);
    const routes = readdirSync(fileURLToPath(new URL("../src/routes", import.meta.url)))
      .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx") && !frozen.has(f))
      .sort();
    expect(routes.length).toBeGreaterThan(15);
    for (const file of routes) {
      const src = read(`../src/routes/${file}`);
      expect(
        src,
        `src/routes/${file} names the product literally instead of via config`,
      ).not.toContain("Spaces1");
    }
  });

  it("the app chrome spells it the same way as the head does", () => {
    const shell = read("../src/components/social/AppShell.tsx");
    expect(shell).toContain("{appConfig.brand.name}");
    expect(shell).not.toContain(">Spaces1<");
    const logo = read("../src/components/BrandLogo.tsx");
    expect(logo).toContain("alt={appConfig.brand.name}");
    expect(logo).toContain("srcSet=");
    expect(logo).toContain("sizes=");
  });
});

describe("every public asset the app promises is on disk and honestly sized", () => {
  it("the head's icon set exists, at the size it declares", () => {
    for (const link of ICON_LINKS) {
      expect(existsSync(publicFile(link.href)), `public${link.href} is missing`).toBe(true);
    }
    expect(pngSize("/icon-192.png")).toBe("192x192");
    expect(pngSize("/icon-512.png")).toBe("512x512");
    expect(pngSize("/apple-touch-icon.png")).toBe("180x180");
    expect(pngSize("/favicon-16x16.png")).toBe("16x16");
    expect(pngSize("/favicon-32x32.png")).toBe("32x32");
    expect(pngSize("/favicon-48x48.png")).toBe("48x48");
    expect(pngSize("/favicon-256x256.png")).toBe("256x256");
    expect(pngSize(APP_ICON_PATH)).toBe("512x512");
    expect(pngSize("/logo.png")).toBe("512x512");
  });

  it("the site card is the 1.91:1 the platforms ask for", () => {
    expect(pngSize(OG_IMAGE_PATH)).toBe(`${OG_IMAGE_WIDTH}x${OG_IMAGE_HEIGHT}`);
    expect(OG_IMAGE_WIDTH / OG_IMAGE_HEIGHT).toBeCloseTo(1.91, 1);
  });

  it("the srcSet's candidates are files, not wishes", () => {
    const srcSet = /srcSet="([^"]+)"/.exec(read("../src/components/BrandLogo.tsx"))?.[1];
    expect(srcSet).toBeTruthy();
    for (const candidate of srcSet!.split(",")) {
      const href = candidate.trim().split(/\s+/)[0]!;
      expect(existsSync(publicFile(href)), `public${href} is missing`).toBe(true);
    }
  });

  it("the service worker the notification path registers is served from public/", () => {
    expect(existsSync(publicFile("/sw.js"))).toBe(true);
    expect(read("../src/lib/browser-notifications.ts")).toContain('register("/sw.js"');
  });

  it("the card has a reproducible generator that Windows PowerShell can read", () => {
    const script = read("../scripts/build-og-image.ps1");
    // PowerShell 5.1 decodes a .ps1 without a BOM as ANSI, so any literal
    // non-ASCII glyph in this file would reach the canvas as mojibake. The
    // source has to stay pure ASCII.
    expect(
      [...script].some((c) => c.charCodeAt(0) > 0x7f),
      "generator is pure ASCII",
    ).toBe(false);
    // It composes the real mark (never a redrawn one) onto the brand's black,
    // centred and ALONE: no wordmark, no tagline, nothing drawn as text at all.
    expect(script).toContain("og-image");
    expect(script).toContain("logo.png");
    expect(script).not.toMatch(/DrawString|Draw-Line|New-Font|StringFormat|\$Tagline|\$Name\b/);
  });
});

describe("the manifest describes an installable app", () => {
  const manifest = JSON.parse(read("../public/manifest.webmanifest"));

  it("carries the fields an installer reads", () => {
    for (const key of [
      "id",
      "name",
      "short_name",
      "description",
      "start_url",
      "scope",
      "display",
      "orientation",
      "lang",
      "dir",
      "categories",
      "background_color",
      "theme_color",
      "icons",
      "shortcuts",
    ]) {
      expect(manifest[key], `manifest.${key} is missing`).toBeDefined();
    }
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.lang).toBe("en");
    expect(manifest.categories).toContain("social");
  });

  it("is named the name the deployment runs as", () => {
    // The manifest is a static file, so it cannot read VITE_APP_NAME at request
    // time. This is the drift gate: renaming the app without renaming the
    // installed shortcut fails here, pointing at the one file to update.
    expect(manifest.name).toBe(appConfig.brand.name);
    expect(manifest.short_name).toBe(appConfig.brand.name);
    expect(manifest.description).toContain(appConfig.brand.name);
    expect(read("../public/robots.txt")).toContain(appConfig.brand.name);
  });

  it("every icon it lists is real, sized, and typed", () => {
    const seen = new Set<string>();
    for (const icon of manifest.icons) {
      expect(icon.src).toMatch(/^\//);
      expect(seen.has(`${icon.src}:${icon.purpose}`), "no duplicate icon entries").toBe(false);
      seen.add(`${icon.src}:${icon.purpose}`);
      expect(existsSync(publicFile(icon.src)), `${icon.src} is declared but missing`).toBe(true);
      // A vector carries a sharp mark at every slot, so it declares `any`; a
      // raster must honestly report the pixel box it actually is.
      if (icon.type === "image/svg+xml") {
        expect(icon.sizes).toBe("any");
        const text = readFileSync(publicFile(icon.src), "utf8");
        expect(text).toContain("<svg");
      } else {
        expect(icon.type).toBe("image/png");
        expect(pngSize(icon.src)).toBe(icon.sizes);
      }
    }
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  });

  it("shortcuts go somewhere real, in this app", () => {
    expect(manifest.shortcuts.length).toBeGreaterThan(1);
    const routeDir = new URL("../src/routes/", import.meta.url);
    for (const shortcut of manifest.shortcuts) {
      expect(shortcut.name).toBeTruthy();
      expect(shortcut.short_name).toBeTruthy();
      const [path, query] = shortcut.url.split("?");
      const file = path === "/" ? "index.tsx" : `${path.slice(1)}.tsx`;
      expect(existsSync(new URL(file, routeDir)), `${shortcut.url} is not a route`).toBe(true);
      // A shortcut that only works because of a query string has to be a query
      // the route actually reads, or the tap opens a plain page.
      if (query) {
        const src = readFileSync(new URL(file, routeDir), "utf8");
        expect(src).toContain(query.split("=")[0]!);
      }
      for (const icon of shortcut.icons ?? []) {
        expect(existsSync(publicFile(icon.src)), `${icon.src} is missing`).toBe(true);
      }
    }
  });
});

/** meta entries as `property|name -> content`, the shape every check wants. */
function OG_KEYS(meta: readonly { property?: string; name?: string; content: string }[]) {
  return meta.map((m) => [m.property ?? m.name!, m.content] as [string, string]);
}
