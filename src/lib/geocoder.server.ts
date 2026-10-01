/**
 * Geocoder lookup, run on the server.
 *
 * The composer's location search used to call the geocoder directly from the
 * browser. That had two consequences: `connect-src` in the CSP is an allowlist
 * of origins a page may talk to, so the request was refused in production with a
 * console error and a picker that quietly looked like "no results"; and a
 * browser cannot set the identifying `User-Agent` that OpenStreetMap's usage
 * policy requires of every caller. Doing the lookup here fixes both — the
 * browser only ever calls our own origin, and the request that reaches the
 * geocoder carries this app's identity and no visitor IP.
 *
 * The endpoint is operator configuration (`GEOCODER_URL`, validated once in
 * `env.server.ts`), never user input, so there is no attacker-controlled URL
 * for this fetch to be steered into. The *query* is user input and is bounded,
 * trimmed and parameter-encoded below.
 */

import { env } from "@/lib/env.server";

/** Matches the composer input's `maxLength`, and Nominatim's own tolerance. */
export const MAX_GEOCODER_QUERY_CHARS = 120;

const REQUEST_TIMEOUT_MS = 6000;

/**
 * Shorten an OpenStreetMap `display_name` ("Kilimani, Nairobi, Kenya, ...") to
 * the first few segments, the way the composer's label has always looked.
 */
export function formatPlaceLabel(displayName: string, segments = 3): string {
  return displayName
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, segments)
    .join(", ");
}

/** The geocoder is configured but did not give a usable answer. */
export class GeocoderUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GeocoderUnavailable";
  }
}

/**
 * Ask the configured geocoder for `query` and return up to `limit` labels.
 * Throws `GeocoderUnavailable` for anything that is not a clean answer — a
 * timeout, a non-2xx, a body that is not the documented array — so the caller
 * can tell "the service did not answer" apart from "nothing matches".
 */
export async function searchPlaces(query: string, limit = 6): Promise<string[]> {
  const q = query.trim();
  // Code points, not UTF-16 units, so an emoji can't make a 119-character query
  // look legal here and illegal at the geocoder.
  if ([...q].length < 2) return [];
  if ([...q].length > MAX_GEOCODER_QUERY_CHARS) {
    throw new Error("That location search is too long.");
  }
  const capped = Math.min(Math.max(1, Math.floor(limit) || 1), 10);

  const { url, userAgent } = env().geocoder;
  const base = new URL(url);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("GEOCODER_URL must be an http(s) endpoint.");
  }
  base.searchParams.set("format", "json");
  base.searchParams.set("limit", String(capped));
  base.searchParams.set("q", q);

  let response: Response;
  try {
    response = await fetch(base.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/json", "User-Agent": userAgent },
    });
  } catch (err) {
    throw new GeocoderUnavailable(
      `Location search did not answer (${err instanceof Error ? err.name : "unknown"})`,
      { cause: err },
    );
  }
  if (!response.ok) {
    throw new GeocoderUnavailable(`Location search failed (${response.status})`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new GeocoderUnavailable("Location search returned something that is not JSON.", {
      cause: err,
    });
  }
  if (!Array.isArray(payload)) {
    // A geocoder that answers with an object is not answering in the documented
    // shape — say so instead of returning an empty list the UI would render as
    // "no place matches that name".
    throw new GeocoderUnavailable("Location search answered with an unexpected shape.");
  }

  return payload
    .map((row) =>
      row && typeof (row as { display_name?: unknown }).display_name === "string"
        ? formatPlaceLabel((row as { display_name: string }).display_name)
        : "",
    )
    .filter(Boolean)
    .slice(0, capped);
}
