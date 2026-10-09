/**
 * The one place that understands how a media COLUMN encodes several attachments.
 *
 * A post/story/message stores any number of attachments in a single TEXT column,
 * comma-joined by the composer (`attachedMedia.join(",")`). A dozen surfaces read
 * that column back — the feed card, thumbnails, the OG preview, the GC sweep that
 * decides which bytes are still live — and every one of them has to agree on where
 * one attachment ends and the next begins.
 *
 * The naive `value.split(",")` is WRONG, because a fallback upload is stored as a
 * `data:<mime>;base64,<payload>` URL and that URL contains a comma of its own.
 * Splitting on it shatters a single attachment into a header with no body and a
 * orphaned base64 blob, so the feed paints a broken-image glyph for every one of a
 * multi-attachment post's images (and miscounts "N attachments"). This module
 * splits on the DELIMITING commas only — never the one inside a `data:` URL — so
 * the round-trip is lossless no matter how the bytes were stored.
 */

/** A `data:` URL's base64 payload never contains a comma, so exactly ONE comma sits inside it. */
const DATA_URL_HEAD = /^\s*data:/i;

/**
 * Split a comma-joined media column into its individual URLs.
 *
 * Reassembles `data:` URLs that the plain comma would otherwise cut in half, and
 * drops empty segments, so a caller gets exactly the attachments the composer put
 * in — in order, none broken.
 */
export function splitMediaList(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  const raw = value.split(",");
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i].trim();
    if (!part) continue;
    // A segment that opens with `data:` is only the URL's header — its base64
    // body is the very next comma-delimited segment. Put them back together and
    // consume the body so it is not emitted a second time as a stray token.
    if (DATA_URL_HEAD.test(part)) {
      const body = raw[i + 1];
      if (body !== undefined) {
        out.push(`${part},${body.trim()}`);
        i++; // the body belongs to this URL, not to the next one
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

/** Join attachments back into the single-column form readers split apart. */
export function joinMediaList(urls: Array<string | null | undefined>): string {
  return urls
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter(Boolean)
    .join(",");
}

/** The first attachment of a media column, or null when it holds nothing. */
export function firstMedia(value: unknown): string | null {
  return splitMediaList(value)[0] ?? null;
}
