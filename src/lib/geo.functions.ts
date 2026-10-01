import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { GeocoderUnavailable, MAX_GEOCODER_QUERY_CHARS, searchPlaces } from "@/lib/geocoder.server";
import { checkRateLimit } from "@/lib/identity.server";

/**
 * Type-ahead for the composer's location label, served by the app's own origin.
 *
 * The browser cannot call the geocoder itself: the CSP's `connect-src` is a
 * host allowlist, and a lookup that is not on it is refused in production with
 * nothing but a console error — the picker then looks like "no results" for
 * every query. Proxying through here keeps the policy tight and the feature
 * honest, and lets the request carry the identifying User-Agent OpenStreetMap
 * asks for (a browser fetch cannot override that header).
 *
 * See `src/lib/geocoder.server.ts` for the upstream call and its bounds.
 */
export const locationSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        query: z.string().max(MAX_GEOCODER_QUERY_CHARS),
        limit: z.number().int().min(1).max(10).default(6),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    // 40 lookups a minute per account: the picker debounces at 300ms, so this
    // only bites someone hammering the composer, and it protects the shared
    // upstream quota (Nominatim allows one request a second per client).
    const allowed = await checkRateLimit(`geo:${context.userId}`, 40, 60);
    if (!allowed) {
      throw new Error("Too many location searches — wait a moment and try again.");
    }

    try {
      return { places: await searchPlaces(data.query, data.limit), degraded: false };
    } catch (err) {
      if (!(err instanceof GeocoderUnavailable)) throw err;
      // Nothing matched is different from nothing answered: tell the caller
      // which one it is so the UI can fall back to its preset list truthfully.
      console.warn("[geo]", err.message);
      return { places: [], degraded: true };
    }
  });
