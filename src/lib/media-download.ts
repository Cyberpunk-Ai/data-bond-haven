/**
 * Pure rules for saving a chat attachment to the user's device.
 *
 * The bug these rules encode: a download was a plain
 * `<a href={mediaUrl} download>`. That fails twice over. First, DM media is
 * private, so the stored path (`/api/public/media/messages/…`) is only readable
 * with a bearer token or a minted `?mt=` capability — and a click navigates
 * without either, so the proxy answered its usual fail-closed 404 and the user
 * saw "download failed". Second, the `download` attribute is ignored for
 * cross-origin URLs and on iOS Safari, so even a readable image opened in a tab
 * instead of saving.
 *
 * So: mint the capability, ask our own proxy for the bytes as an attachment, and
 * let the browser save a blob it fetched itself. Kept free of DOM and Supabase
 * imports so all of it is testable in node, like the other rule modules.
 */

const MEDIA_PROXY_MARKER = "/api/public/media/";

const MAX_NAME_LENGTH = 120;

/**
 * Drop characters that would break out of a quoted Content-Disposition value:
 * quotes, a backslash, and any control character. Written as a code-point loop
 * rather than a character class so the rule reads as what it is — "no control
 * characters, ever" — while a name like `résumé.pdf` passes through untouched.
 */
function stripUnsafeNameChars(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === '"' || ch === "'" || ch === "\\") continue;
    out += ch;
  }
  return out;
}

export function sanitizeFileName(name: string, fallback = "attachment"): string {
  const base = String(name ?? "")
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean)
    .pop();
  const cleaned = stripUnsafeNameChars(base ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  // Keep the extension when truncating: a file saved as "report.docx" opening in
  // Word is a different experience from "report" with no hint at all.
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 8 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, MAX_NAME_LENGTH - ext.length)}${ext}`;
}

/** A name that is safe between ASCII quotes: printable ASCII, no quotes. */
export function asciiName(name: string): string {
  let out = "";
  for (const ch of String(name ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) continue;
    if (ch === '"' || ch === "\\") continue;
    out += ch;
  }
  return out.trim() || "media";
}

/**
 * The `Content-Disposition` a download is answered with.
 *
 * `filename="…"` is a 7-bit field, so a name with anything above U+007E in it —
 * `发票.pdf`, `résumé.pdf` — either reaches the user mangled or gets rejected when
 * the header is written. RFC 5987's `filename*=UTF-8''…` is the form that carries
 * it honestly, so we send both: an ASCII stand-in for anything old, the real name
 * for every current browser (which prefers `filename*` when both are present).
 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const encoded = encodeURIComponent(String(name ?? "")).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${asciiName(name)}"; filename*=UTF-8''${encoded}`;
}

/**
 * Pull the human name out of a DM body. Documents are stored as
 * `📄 Document: [name] [url]`, and the name the sender picked is the one the
 * receiver should get back — not the randomised storage key.
 */
export function fileNameFromMessageBody(body: string): string | null {
  const tagged = body?.match(/\[([^\]]*\.[A-Za-z0-9]{1,8})\]/);
  if (tagged) return tagged[1];
  const named = body?.match(/Document:\s*\[([^\]]+)\]/);
  return named?.[1] ?? null;
}

/** The last path segment with an extension, or null when the object is nameless. */
export function fileNameFromUrl(url: string): string | null {
  if (!url) return null;
  const path = url.split(/[?#]/)[0];
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return /\.[A-Za-z0-9]{1,8}$/.test(last) ? decodeURIComponent(last) : null;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Storage key (`messages/<conversation>/<uuid>.png`) out of any URL shape.
 * Mirrors `mediaKeyFromUrl` in src/lib/storage/provider.server.ts: this module
 * ships to the browser and that one is server-only, so the two rules are stated
 * twice and tests in tests/media-download.test.ts pin the shapes both accept.
 */
export function mediaStorageKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const idx = url.indexOf(MEDIA_PROXY_MARKER);
  if (idx !== -1)
    return decodeURIComponent(url.slice(idx + MEDIA_PROXY_MARKER.length).split("?")[0]);
  // A bare object path (no protocol) is already a key.
  if (!/^https?:\/\//.test(url)) return url.replace(/^\/+/, "");
  return null;
}

/** True when the bytes are read through our own proxy, so we control auth and headers. */
export function isProxiedMediaUrl(url: string): boolean {
  return url.includes(MEDIA_PROXY_MARKER);
}

/**
 * The folders the proxy refuses to serve without proof of who is asking.
 *
 * Matched anywhere in the URL rather than only at the start: `messages/`,
 * `recordings/` and `stories/` bytes are private whoever wrote the host down, and
 * treating an absolute `https://app.example.com/api/public/media/messages/...`
 * copy as public is how a DM photo renders as a broken image — the element loads
 * it with no capability and gets the proxy's fail-closed 404.
 */
const PRIVATE_MEDIA_PATH = /\/api\/public\/media\/(recordings|messages|stories)\//;

export function isPrivateMediaPath(url: string | null | undefined): boolean {
  return !!url && PRIVATE_MEDIA_PATH.test(url);
}

/**
 * The URL a top-level navigation can save from: our proxy path for this object,
 * with `dl=1` so the server answers `Content-Disposition: attachment`.
 *
 * `mt` (the media capability) is added by the caller once one has been minted.
 * Public folders need no capability, so this is already a working download.
 */
export function attachmentHref(url: string, name: string): string | null {
  const key = mediaStorageKey(url);
  if (!key || key.includes("..")) return null;
  const objectPath = key.replace(/^api\/public\/media\//, "");
  const params = new URLSearchParams({ dl: "1", name: sanitizeFileName(name) });
  return `/api/public/media/${objectPath}?${params.toString()}`;
}

/**
 * Puts the read capability on a URL without assuming it already has a query.
 *
 * String-concatenating `&mt=` onto a path that carries no `?` is a silent
 * corruption: the token becomes part of the last path segment, the proxy looks
 * up an object that does not exist and answers its fail-closed 404 — which reads
 * back as "the file is gone" rather than "we built the URL wrong".
 */
export function withMediaToken(href: string, token: string | null | undefined): string {
  if (!token || !href) return href;
  if (/[?&]mt=/.test(href)) return href;
  return `${href}${href.includes("?") ? "&" : "?"}mt=${encodeURIComponent(token)}`;
}

/** Copy that tells the truth about what went wrong, without jargon. */
export function downloadErrorMessage(status: number | null): string {
  if (status === 404 || status === 403) return "This file is no longer available to download.";
  if (status === 401) return "Sign in again to download this file.";
  if (status === 429) return "Too many downloads at once. Try again in a moment.";
  return "The download couldn't start. Please try again.";
}

/**
 * How to save one attachment.
 *
 * The browser first tries to fetch the bytes and hand over a blob URL, which
 * honours `download` on every desktop browser and on Android. `saveHref` is the
 * fallback a plain navigation can use, and it is a real download because the
 * proxy stamps `Content-Disposition: attachment` on it. It is null for an
 * absolute URL we don't serve (a CDN, an external link) — the caller opens that
 * in a tab instead of pretending it would save.
 */
export function planDownload(url: string, name: string): { name: string; saveHref: string | null } {
  return {
    name: sanitizeFileName(name, fileNameFromUrl(url) ?? "attachment"),
    saveHref: attachmentHref(url, name),
  };
}
