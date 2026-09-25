/**
 * Magic-byte content sniffing (M2/M3 — plan §4.6).
 *
 * The upload endpoint trusted only the client-supplied `content-type` header,
 * so an `.html`/polyglot payload renamed to `image/jpeg` would have been stored
 * as a JPEG. It was only ever stopped from executing by an inline allowlist in
 * the media reader — one layer deep. This verifies the file's actual leading
 * bytes and rejects a declared type whose signature does not match.
 *
 * Pure and dependency-free so it runs in the Worker and under unit tests.
 */

type Kind = "image" | "video" | "audio";

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len && offset + i < bytes.length; i++)
    s += String.fromCharCode(bytes[offset + i]);
  return s;
}

/** Detect the concrete MIME type from the leading bytes, or null if unknown. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  // Images
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";

  // Audio: RIFF....WAVE
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  // ID3-tagged MP3 or a raw MPEG frame sync
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";

  // ISO-BMFF family (mp4 / quicktime / m4a / avif): 'ftyp' at offset 4.
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (brand.startsWith("avi")) return "image/avif"; // avif / avis
    if (
      brand.startsWith("mp4") ||
      ["isom", "iso2", "iso6", "esds"].includes(brand) ||
      /^mp4v/.test(brand)
    ) {
      return "video/mp4";
    }
    if (brand === "m4a " || brand === "mp42") return "audio/mp4";
    if (brand.startsWith("qt")) return "video/quicktime";
    // Default the remaining ftyp brands to a container we accept as video.
    return "video/mp4";
  }

  // Matroska / WebM / WebA: EBML header 1A 45 DF A3
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Distinguish video/webm from audio/webm by DocType when cheaply reachable.
    const head = ascii(bytes, 0, Math.min(bytes.length, 64));
    if (head.includes("weba")) return "audio/webm";
    return "video/webm";
  }

  return null;
}

const KIND_OF: Record<string, Kind> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/webm": "audio",
  "audio/mp4": "audio",
};

// Containers whose leading bytes are identical whether the payload is audio or
// video. Browsers write DocType "webm" (not "weba") for audio/webm recordings,
// so sniffing cannot — and must not — use the audio/video kind split to reject a
// legitimate recording upload. Both members of a family are on the allowlist, so
// accepting a cross-kind match *within* a family still refuses any foreign bytes
// (an HTML/XML polyglot is neither a Matroska nor an ISO-BMFF container).
const CONTAINER_FAMILY: Record<string, string> = {
  "video/webm": "matroska",
  "audio/webm": "matroska",
  "video/mp4": "isobmff",
  "audio/mp4": "isobmff",
  "video/quicktime": "isobmff",
};

/**
 * True when the declared content type is corroborated by the file's real
 * leading bytes. We require the same *kind* (image/video/audio) and, where we
 * confidently detected a concrete MIME, that it equals the declared type.
 */
export function signatureMatches(declaredContentType: string, bytes: Uint8Array): boolean {
  const declaredKind = KIND_OF[declaredContentType];
  if (!declaredKind) return false; // type not in our allowlist at all
  const detected = sniffMediaType(bytes);
  if (!detected) return false; // unrecognised → refuse
  if (KIND_OF[detected] === declaredKind) return true; // unambiguous
  // Different concrete types are still fine when they share one container (see
  // CONTAINER_FAMILY): audio/webm recorded by the browser really is a WebM.
  const declaredFamily = CONTAINER_FAMILY[declaredContentType];
  const detectedFamily = CONTAINER_FAMILY[detected];
  return Boolean(declaredFamily) && declaredFamily === detectedFamily;
}
