// @vitest-environment node
/**
 * Crawler-facing contracts: what search engines and link-preview bots are told.
 *
 * Two kinds of check live here. The pure decisions (`src/lib/seo.ts`) are tested
 * directly — canonical shaping, sitemap XML, JSON-LD escaping. The wiring that
 * only exists as source (route heads, robots.txt, the icon files on disk) is
 * tested as a contract, because the failure mode is invisible: a route that
 * forgets `noindex`, a sitemap entry pointing at a soft-404, or an `<link>` to
 * an icon that was never committed all look fine until a crawler reports them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  ICON_LINKS,
  NOINDEX_PATHS,
  ROBOTS_ALLOWED_PREFIXES,
  ROBOTS_DISALLOWED_PREFIXES,
  SITEMAP_URL_LIMIT,
  STATIC_SITEMAP_PAGES,
  buildSitemapXml,
  canonicalHref,
  canonicalLink,
  canonicalPath,
  escapeXml,
  isDisallowedForCrawlers,
  jsonLdBlock,
  ogUrlMeta,
  organizationJsonLd,
  postJsonLd,
  profileJsonLd,
  sitemapDate,
  sitemapEntryXml,
  websiteJsonLd,
  breadcrumbJsonLd,
} from "@/lib/seo";
import { OG_IMAGE_META, siteOrigin } from "@/lib/og-meta";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const publicFile = (href: string) => new URL(`../public${href}`, import.meta.url);
/** `/oauth/callback` → `src/routes/oauth.callback.tsx` (this repo's routing convention). */
const routeFileFor = (path: string) =>
  `../src/routes/${path === "/" ? "index" : path.replace(/^\//, "").replace(/\//g, ".")}.tsx`;

describe("canonicalPath collapses every variant of a url", () => {
  it("drops query strings and fragments", () => {
    expect(canonicalPath("/explore?q=cat&utm_source=x")).toBe("/explore");
    expect(canonicalPath("/pricing#teams")).toBe("/pricing");
  });

  it("accepts a fully-qualified url and a trailing slash", () => {
    expect(canonicalPath("https://spaces1.com/about/")).toBe("/about");
    expect(canonicalPath("/spaces//live//")).toBe("/spaces/live");
    expect(canonicalPath("")).toBe("/");
    expect(canonicalPath("/")).toBe("/");
  });

  it("builds an absolute href without doubling the slash", () => {
    expect(canonicalHref("/pricing", "https://spaces1.com/")).toBe("https://spaces1.com/pricing");
    expect(canonicalLink("/pricing", "https://spaces1.com")).toEqual({
      rel: "canonical",
      href: "https://spaces1.com/pricing",
    });
    expect(ogUrlMeta("/pricing", "https://spaces1.com")).toEqual({
      property: "og:url",
      content: "https://spaces1.com/pricing",
    });
  });
});

describe("buildSitemapXml emits a file a parser will accept", () => {
  const origin = "https://spaces1.com";

  it("declares the xml version and the sitemap namespace", () => {
    const xml = buildSitemapXml([{ path: "/pricing" }], origin);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("de-duplicates on the canonical path, first entry wins", () => {
    const xml = buildSitemapXml(
      [
        { path: "/pricing", priority: 0.9 },
        { path: "/pricing/", priority: 0.5 },
        { path: "https://spaces1.com/pricing?q=1" },
      ],
      origin,
    );
    expect(xml.match(/<loc>/g)).toHaveLength(1);
    expect(xml).toContain("<priority>0.9</priority>");
  });

  it("never advertises a noindex surface", () => {
    const xml = buildSitemapXml(
      [...STATIC_SITEMAP_PAGES, ...NOINDEX_PATHS.map((path) => ({ path }))],
      origin,
    );
    for (const path of NOINDEX_PATHS) expect(xml).not.toContain(`<loc>${origin}${path}</loc>`);
    expect(xml).toContain(`<loc>${origin}/pricing</loc>`);
  });

  it("escapes xml metacharacters in a handle, & exactly once", () => {
    expect(escapeXml(`a&b<c>"d'e`)).toBe("a&amp;b&lt;c&gt;&quot;d&apos;e");
    const xml = sitemapEntryXml({ path: "/u/a&b" }, "https://spaces1.com");
    expect(xml).toContain("<loc>https://spaces1.com/u/a&amp;b</loc>");
    expect(xml).not.toContain("&amp;amp;");
  });

  it("emits only a real date, and clamps priority", () => {
    expect(sitemapDate("2026-10-03T07:12:00Z")).toBe("2026-10-03");
    expect(sitemapDate(1_759_484_800_000)).toBe("2025-10-03");
    expect(sitemapDate("not a date")).toBeUndefined();
    expect(sitemapDate(null)).toBeUndefined();
    const xml = sitemapEntryXml({ path: "/x", lastmod: "junk", priority: 7 }, origin);
    expect(xml).not.toContain("<lastmod>");
    expect(xml).toContain("<priority>1.0</priority>");
  });

  it("stops at the url limit instead of shipping a file Google truncates", () => {
    const many = Array.from({ length: SITEMAP_URL_LIMIT + 50 }, (_, i) => ({ path: `/p/${i}` }));
    const xml = buildSitemapXml(many, origin);
    expect(xml.match(/<loc>/g)).toHaveLength(SITEMAP_URL_LIMIT);
  });
});

describe("JSON-LD is safe to inline and says what we know", () => {
  it("cannot break out of its script tag once the payload is escaped", () => {
    const doc = profileJsonLd({
      username: "ada",
      displayName: "Ada </script><img src=x onerror=alert(1)>",
      origin: "https://spaces1.com",
    });
    // The router serialises `script:ld+json` and escapes `&`, `<` and `>` as
    // `\u0026`/`\u003c`/`\u003e`. Those sit inside json string values, so a parser
    // reads the original characters back while the html scanner can no longer
    // see a tag that closes the script early.
    const escaped = JSON.stringify(doc).replace(
      /[&><]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    expect(escaped).not.toContain("</script>");
    expect(JSON.parse(escaped).name).toContain("</script>");
  });

  it("emits one meta entry, as an array only when there is more than one document", () => {
    const single = jsonLdBlock({ "@type": "Organization" });
    expect(single["script:ld+json"]).toEqual({ "@type": "Organization" });
    expect(jsonLdBlock({ a: 1 }, { b: 2 })["script:ld+json"]).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("optional members are dropped, not serialised as nulls", () => {
    const doc = profileJsonLd({
      username: "ada",
      displayName: "Ada",
      bio: null,
      avatarUrl: null,
      origin: "https://spaces1.com",
    });
    // schema.org validators report a literal null image/description as missing
    // required data; an absent key reads as "we do not know that".
    const json = JSON.stringify(doc);
    expect(json).not.toContain("null");
    expect(json).not.toContain('"description"');
    expect(json).not.toContain('"image"');
  });

  it("keeps the SearchAction template literal so sitelinks can match it", () => {
    const site = websiteJsonLd("https://spaces1.com");
    const target = site.potentialAction.target.urlTemplate;
    expect(target).toBe("https://spaces1.com/explore?q={search_term_string}");
    expect(site.potentialAction["query-input"]).toBe("required name=search_term_string");
    // The publisher reference only resolves if the org node carries that id.
    expect(organizationJsonLd("https://spaces1.com")["@id"]).toBe(
      "https://spaces1.com/#/organization",
    );
  });

  it("encodes a handle in the url but keeps it readable in the name", () => {
    const person = profileJsonLd({
      username: "ada l",
      displayName: "Ada",
      followers: 0,
      origin: "https://spaces1.com",
    });
    expect(person.url).toBe("https://spaces1.com/u/ada%20l");
    expect(person.alternateName).toBe("@ada l");
    expect(person.interactionStatistic).toBeUndefined();
    // `sameAs` means "this same person elsewhere", so a self-reference is
    // removed rather than left as an empty array.
    expect(JSON.stringify(person)).not.toContain("sameAs");
  });

  it("gives a post a headline that fits and a breadcrumb that counts from 1", () => {
    const post = postJsonLd({
      id: "p1",
      content: `  hello\n\n world ${"x".repeat(200)}  `,
      authorName: "Ada",
      authorUsername: "ada",
      createdAt: "2026-10-01T10:00:00Z",
      origin: "https://spaces1.com",
    });
    expect(post.headline).toBe(`hello world ${"x".repeat(98)}`);
    expect(post.headline.length).toBeLessThanOrEqual(110);
    expect(post.url).toBe("https://spaces1.com/post/p1");

    const trail = breadcrumbJsonLd(
      [
        { name: "Spaces1", path: "/" },
        { name: "Post", path: "/post/p1" },
      ],
      "https://spaces1.com",
    );
    expect(trail.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(trail.itemListElement[0].item).toBe("https://spaces1.com/");
  });
});

describe("robots.txt agrees with the route declarations", () => {
  const text = read("../public/robots.txt");

  it("points at the sitemap on the canonical origin", () => {
    const line = text.split(/\r?\n/).find((l) => l.startsWith("Sitemap:"));
    expect(line).toBe(`Sitemap: ${siteOrigin()}/sitemap.xml`);
  });

  it("blocks exactly the declared prefixes for the default agent", () => {
    const groups = parseGroups(text);
    const wildcard = groups.find((g) => g.agents.includes("*"));
    expect(wildcard, "robots.txt needs a User-agent: * group").toBeTruthy();
    expect(wildcard!.disallow.sort()).toEqual([...ROBOTS_DISALLOWED_PREFIXES].sort());
  });

  it("re-opens the public media proxy inside the /api/ block", () => {
    // A preview card is only as good as the image a bot can actually fetch, and
    // every avatar and post photo lives under /api/, which is otherwise blocked.
    const wildcard = parseGroups(text).find((g) => g.agents.includes("*"))!;
    expect(wildcard.allow).toContain("/");
    for (const allowed of ROBOTS_ALLOWED_PREFIXES) {
      expect(wildcard.allow, `${allowed} must be allowed for the default agent`).toContain(allowed);
    }
    // Longest match is what makes the exception win, so it has to be the more
    // specific string — an `Allow: /` alone would be overridden by Disallow: /api/.
    for (const allowed of ROBOTS_ALLOWED_PREFIXES) {
      expect(allowed.length).toBeGreaterThan("/api/".length);
      expect(allowed.startsWith("/api/")).toBe(true);
      expect(isDisallowedForCrawlers(`${allowed}avatars/me.jpg`)).toBe(false);
    }
    expect(isDisallowedForCrawlers("/api/media/token")).toBe(true);
    expect(isDisallowedForCrawlers("/api/uploads")).toBe(true);
  });

  it("covers every noindex route, and nothing the sitemap advertises", () => {
    for (const path of NOINDEX_PATHS) {
      expect(isDisallowedForCrawlers(path), `${path} must be disallowed`).toBe(true);
    }
    for (const page of STATIC_SITEMAP_PAGES) {
      expect(isDisallowedForCrawlers(page.path), `${page.path} must stay crawlable`).toBe(false);
    }
    expect(isDisallowedForCrawlers("/u/ada")).toBe(false);
    expect(isDisallowedForCrawlers("/post/0f1e")).toBe(false);
    expect(isDisallowedForCrawlers("/sitemap.xml")).toBe(false);
  });

  it("never blocks a link-preview bot from fetching", () => {
    // A disallowed url cannot be fetched, and a page that cannot be fetched has
    // no preview card — `noindex` is what keeps these out of the index instead.
    for (const bot of ["twitterbot", "facebookexternalhit", "linkedinbot", "telegrambot"]) {
      const group = parseGroups(text).find((g) => g.agents.includes(bot));
      expect(group, `${bot} needs its own group`).toBeTruthy();
      expect(group!.disallow, `${bot} must not be disallowed anywhere`).toEqual([]);
      expect(group!.allow).toContain("/");
    }
  });
});

/** Split robots.txt into (agents, allow, disallow) groups the way a crawler does. */
function parseGroups(text: string) {
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[] }> = [];
  let afterDirective = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    if (!line) {
      afterDirective = false;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (!afterDirective) groups.push({ agents: [], allow: [], disallow: [] });
      groups[groups.length - 1]!.agents.push(value.toLowerCase());
      afterDirective = false;
    } else {
      const group = groups[groups.length - 1];
      if (!group) continue;
      if (key === "disallow" && value) group.disallow.push(value);
      if (key === "allow" && value) group.allow.push(value);
      afterDirective = true;
    }
  }
  return groups;
}

describe("every route declares its indexability", () => {
  it("noindex routes carry the tag, and only the tag", () => {
    for (const path of NOINDEX_PATHS) {
      const src = read(routeFileFor(path));
      expect(src, `${path} must spread NOINDEX_META`).toContain("...NOINDEX_META");
      expect(src, `${path} must not hand-roll a weaker robots tag`).not.toMatch(
        /name: "robots",\s*content: "noindex"\s*}/,
      );
    }
  });

  it("public routes canonicalise as a <link>, not as a <meta>", () => {
    for (const page of STATIC_SITEMAP_PAGES) {
      const src = read(routeFileFor(page.path));
      const meta = headArray(src, "meta");
      const links = headArray(src, "links");
      // `<meta rel="canonical">` is what the router renders for a link-shaped
      // object placed in `meta` — a tag that looks right in source and does
      // nothing in the delivered html, so the split is the contract.
      expect(links, `${page.path} needs a canonical link`).toContain(
        `canonicalLink("${page.path}")`,
      );
      expect(meta, `${page.path} must not declare its canonical in meta`).not.toContain(
        "canonicalLink",
      );
      expect(meta, `${page.path} needs an og:url`).toContain(`ogUrlMeta("${page.path}")`);
      expect(src, `${page.path} must not also be noindexed`).not.toContain("NOINDEX_META");
    }
  });

  it("the root head offers the icon set and no competing robots directive", () => {
    const src = read("../src/routes/__root.tsx");
    expect(src).toContain("...ICON_LINKS");
    // A root-level `index,follow` would be merged into every route and argue
    // with the private pages' own `noindex`.
    expect(src).not.toMatch(/name: "robots"/);
  });

  it("server-rendered share pages publish structured data in the head", () => {
    const home = read("../src/routes/index.tsx");
    expect(headArray(home, "meta")).toContain("jsonLdBlock(websiteJsonLd(), organizationJsonLd())");

    const profile = read("../src/routes/u.$username.tsx");
    expect(profile).toContain("profileJsonLd({");
    expect(profile).toContain("breadcrumbJsonLd([");
    // The hand-off url is the canonical profile, so it points at itself.
    expect(profile).toContain("links: [canonicalLink(path)]");

    const post = read("../src/routes/post.$id.tsx");
    expect(post).toContain("postJsonLd({");
    expect(post).toContain("links: [canonicalLink(path)]");

    // Neither key reaches `<head>`: the head function's own `scripts` output is
    // what becomes `headScripts`, and the route option `scripts` renders in the
    // body. A crawler without javascript must still find the json, so structured
    // data goes through `meta: [{ "script:ld+json": … }]` and nothing else.
    for (const src of [home, profile, post]) {
      expect(src, "ld+json must not be handed to a script slot").not.toMatch(/headScripts\s*:/);
      expect(src, "ld+json must not be deferred to the body").not.toMatch(/^\s*scripts: \[/m);
    }
  });

  /** Return the text inside a head function's `meta: [...]` or `links: [...]`. */
  function headArray(src: string, key: "meta" | "links"): string {
    const open = src.indexOf(`${key}: [`);
    expect(open, `${key}: [...] must be declared in the head`).toBeGreaterThan(-1);
    const body = open + key.length + 3; // first character after the opening bracket
    let depth = 1;
    let cursor = body;
    while (cursor < src.length && depth > 0) {
      if (src[cursor] === "[") depth++;
      if (src[cursor] === "]") depth--;
      cursor++;
    }
    expect(depth, `unbalanced ${key}: array`).toBe(0);
    return src.slice(body, cursor - 1);
  }
});

describe("the sitemap route lists only pages that really render", () => {
  const src = read("../src/routes/sitemap[.]xml.ts");

  it("is served at /sitemap.xml as xml, and cached", () => {
    expect(src).toContain('createFileRoute("/sitemap.xml")');
    expect(src).toContain("application/xml");
    expect(src).toContain("s-maxage");
  });

  it("mirrors the RLS visibility predicate instead of trusting the service role", () => {
    // The service-role client bypasses RLS, so the filters that keep a hidden
    // post or a suspended account out of search results are written here.
    expect(src).toContain('eq("hidden", false)');
    expect(src).toContain('eq("status", "active")');
    expect(src, "never widen a public listing to select *").not.toContain('select("*")');
  });

  it("degrades to static routes rather than failing the crawl", () => {
    expect(src).toMatch(/catch/);
    expect(src).toContain("STATIC_SITEMAP_PAGES");
  });
});

describe("the icon set exists on disk", () => {
  it("every declared href resolves to a real file", () => {
    const hrefs = [...ICON_LINKS.map((l) => l.href), OG_IMAGE_PATH];
    for (const href of new Set(hrefs)) {
      expect(existsSync(publicFile(href)), `public${href} is missing`).toBe(true);
    }
  });

  it("the og:image meta points at that file with honest dimensions", () => {
    const byName = new Map(
      (OG_IMAGE_META as readonly MetaTag[]).map((m) => [m.property ?? m.name, m.content]),
    );
    expect(byName.get("og:image")).toBe(`${siteOrigin()}${OG_IMAGE_PATH}`);
    // Declared as 1200x630 (the 1.91:1 every previewer asks for) — and the file
    // itself is checked against those numbers, because a declared size the image
    // does not have makes platforms crop the card to fit the lie.
    expect(byName.get("og:image:width")).toBe("1200");
    expect(byName.get("og:image:height")).toBe("630");
    const bytes = readFileSync(publicFile(OG_IMAGE_PATH));
    expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe("1200x630");
  });

  it("an icon never declares a size its own file does not have", () => {
    // Browsers and installers trust `sizes`: paint a 512px png as 192x192 and a
    // sharp mark is scaled from the wrong box, and a wrong apple-touch size is a
    // blurry home-screen icon that no test of the html would ever reveal.
    const dims = (href: string) => {
      const bytes = readFileSync(publicFile(href));
      expect(bytes.subarray(1, 4).toString("ascii"), `${href} is not a png`).toBe("PNG");
      return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
    };
    const pngs = ICON_LINKS.filter((l) => l.href.endsWith(".png"));
    expect(pngs).toHaveLength(3);
    for (const link of pngs) {
      const declared = "sizes" in link ? link.sizes : undefined;
      expect(dims(link.href), `${link.href} disagrees with its sizes attribute`).toBe(declared);
    }
  });

  it("favicon.ico is multi-size, not a single 32px bitmap", () => {
    const ico = readFileSync(publicFile("/favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(3);

    const entries = Array.from({ length: count }, (_, i) => {
      const at = 6 + i * 16;
      const size = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      return {
        width: ico[at],
        payload: ico.subarray(offset, offset + size),
        declared: size,
      };
    });
    for (const entry of entries) {
      expect(entry.payload.length, "directory points past the end of the file").toBe(
        entry.declared,
      );
    }

    // Legacy bitmap for readers that only understand the old format…
    expect(entries.some((e) => e.width === 32 && !isPngEntry(e))).toBe(true);
    // …plus the real marks, with the big one declared in the 256+ slot.
    const pngSizes = entries
      .filter(isPngEntry)
      .map((e) => e.payload.readUInt32BE(16))
      .sort((a, b) => a - b);
    expect(pngSizes).toEqual([192, 512]);
  });

  it("the web app manifest covers the same icons and is valid json", () => {
    const manifest = JSON.parse(read("../public/manifest.webmanifest"));
    expect(manifest.start_url).toBe("/");
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      expect(existsSync(publicFile(icon.src)), `${icon.src} is declared but missing`).toBe(true);
    }
  });
});

type MetaTag = { property?: string; name?: string; content: string };

const OG_IMAGE_PATH = (
  (OG_IMAGE_META as readonly MetaTag[]).find((m) => m.property === "og:image") as MetaTag
).content.replace(siteOrigin(), "");

const isPngEntry = (e: { payload: Buffer }) =>
  e.payload.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
