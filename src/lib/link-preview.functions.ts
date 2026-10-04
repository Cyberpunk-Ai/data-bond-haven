/**
 * A server-side link preview.
 *
 * When someone pastes a URL into a chat we want to show a small card — title,
 * description, thumbnail — instead of a bare string. That means fetching an
 * arbitrary, user-supplied address from our own server, which sits on a private
 * network: exactly the surface an SSRF attack targets. So this reuses the same
 * guard the Developer Portal webhooks use (`ssrf-guard.server.ts`): the host is
 * resolved and vetted *before* the socket opens, and every redirect hop is
 * re-checked, because a vetted first hop that answers `302 → 169.254.169.254`
 * would otherwise walk straight past a single check.
 *
 * Everything here is best-effort and never throws to the caller: a page that is
 * unreachable, non-HTML, oversized, or refused by the guard simply comes back
 * `{ ok: false }`, and the composer falls back to the plain link. A preview is a
 * nicety; it must never break the message.
 */
import { createServerFn } from "@tanstack/react-start";

export type LinkPreview = {
  ok: boolean;
  title?: string;
  description?: string;
  image?: string;
  host?: string;
};

const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
// Read at most this many bytes of the body. Rich-document `<head>` blocks are
// small; a multi-megabyte page is either not an article or a denial attempt.
const MAX_BYTES = 256_000;

/** Decode the handful of entities that actually show up in `og:` attributes. */
function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    });
}

function clean(text: string | undefined): string {
  return decodeEntities((text ?? "").replace(/\s+/g, " ").trim()).slice(0, 200);
}

/**
 * Find the `content` of a `<meta>` whose `property`/`name`/`itemprop` matches
 * any of `keys`, tolerating either attribute order (content-before-property is
 * common) and single or double quotes.
 */
function readMeta(html: string, keys: string[]): string | undefined {
  const names = keys.map((k) => k.toLowerCase());
  const tagRe = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    const el = tag[0];
    const attr = /(?:property|name|itemprop)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(el);
    if (!attr) continue;
    const value = (attr[2] ?? attr[3] ?? attr[4] ?? "").toLowerCase();
    if (!names.includes(value)) continue;
    const content = /content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(el);
    if (content) {
      const raw = content[2] ?? content[3] ?? content[4] ?? "";
      if (raw.trim()) return raw.trim();
    }
  }
  return undefined;
}

/** Resolve a possibly-relative metadata url against the page URL. */
function absolutize(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

/** Pure HTML → metadata extraction; exported so it can be unit-tested. */
export function extractLinkMeta(html: string, finalUrl: string): LinkPreview {
  const host = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return undefined;
    }
  })();

  const title = clean(
    readMeta(html, ["og:title", "twitter:title"]) ??
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1],
  );
  const description = clean(
    readMeta(html, ["og:description", "twitter:description", "description"]) ?? undefined,
  );
  const image = absolutize(
    readMeta(html, ["og:image", "twitter:image", "twitter:image:src"]),
    finalUrl,
  );

  if (!title && !description && !image) return { ok: false, host };
  // A preview card with only an image and no text still reads as broken; treat a
  // lonely image with no title/description as "no useful preview".
  if (!title && !description) return { ok: false, host };

  return {
    ok: true,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(host ? { host } : {}),
  };
}

/**
 * Read a response body up to `max` bytes. Chunks are decoded incrementally so a
 * slow/large server cannot make us buffer the whole thing first.
 */
async function readBounded(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, max);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: string[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Cancel whether we hit the cap or finished, so the socket is released.
    void reader.cancel().catch(() => {});
  }
  return chunks.join("").slice(0, max);
}

export const getLinkPreview = createServerFn({ method: "GET" })
  .inputValidator((input: { url: string }) => ({ url: String(input?.url ?? "").trim() }))
  .handler(async ({ data }): Promise<LinkPreview> => {
    const { checkSafeUrl, UnsafeUrlError } = await import("./ssrf-guard.server");
    if (!data.url) return { ok: false };

    let current = data.url;
    let response: Response | undefined;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // Validate this hop's host before touching the socket.
        const { url } = await checkSafeUrl(current);
        current = url.toString();
        try {
          response = await fetch(current, {
            method: "GET",
            redirect: "manual",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
              "User-Agent": `${"Spaces"}-preview/1.0 (+link preview bot)`,
              Accept: "text/html,application/xhtml+xml",
            },
          });
        } catch (err) {
          if (err instanceof Error && /redirect/i.test(err.message)) {
            // `redirect: "manual"` doesn't throw on 3xx; some runtimes still do.
            return { ok: false };
          }
          return { ok: false };
        }

        // Manual redirect: follow only after re-checking the new location.
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || hop === MAX_REDIRECTS) return { ok: false };
          current = new URL(location, current).toString();
          continue;
        }
        break;
      }
    } catch (err) {
      // Unsafe host, unresolvable, credential-bearing, non-https, etc.
      if (err instanceof UnsafeUrlError) return { ok: false };
      return { ok: false };
    }

    if (!response || !response.ok) return { ok: false };
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return { ok: false };

    try {
      const html = await readBounded(response, MAX_BYTES);
      return extractLinkMeta(html, current);
    } catch {
      return { ok: false };
    }
  });
