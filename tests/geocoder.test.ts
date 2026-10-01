import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvForTests } from "@/lib/env.server";
import {
  GeocoderUnavailable,
  MAX_GEOCODER_QUERY_CHARS,
  formatPlaceLabel,
  searchPlaces,
} from "@/lib/geocoder.server";

/**
 * Location search runs on the server. It used to be a browser `fetch` straight
 * at the geocoder, which the CSP's `connect-src` allowlist refuses in production
 * — the composer's picker then looked like it had no results for anything. These
 * tests describe the replacement contract: what goes upstream, and how a
 * failure is reported instead of being dressed up as an empty result set.
 */
const MANAGED = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "API_KEY_PEPPER",
  "GEOCODER_URL",
  "APP_NAME",
  "SUPPORT_EMAIL",
] as const;

const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MANAGED) {
    ORIGINAL[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SUPABASE_URL = "https://probe.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_probe";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_probe";
  process.env.API_KEY_PEPPER = "0".repeat(64);
  process.env.APP_NAME = "ProbeNet";
  process.env.SUPPORT_EMAIL = "ops@probe.test";
  __resetEnvForTests();
});

afterEach(() => {
  for (const key of MANAGED) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetEnvForTests();
  vi.unstubAllGlobals();
});

/** Install a fake upstream and return the calls it received. */
function upstream(reply: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return reply();
    }),
  );
  return calls;
}

function json(rows: unknown, init?: ResponseInit) {
  return () => new Response(JSON.stringify(rows), { status: 200, ...init });
}

describe("searchPlaces", () => {
  it("asks the configured endpoint and identifies the app, as OSM requires", () => {
    process.env.GEOCODER_URL = "https://geo.example.org/v1/search?style=compact";
    __resetEnvForTests();
    const calls = upstream(json([{ display_name: "Kilimani, Nairobi, Kenya, extra" }]));

    return searchPlaces("kilimani", 4).then((places) => {
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0].url);
      expect(`${url.origin}${url.pathname}`).toBe("https://geo.example.org/v1/search");
      expect(url.searchParams.get("style")).toBe("compact"); // operator params survive
      expect(url.searchParams.get("format")).toBe("json");
      expect(url.searchParams.get("limit")).toBe("4");
      expect(url.searchParams.get("q")).toBe("kilimani");
      expect(new Headers(calls[0].init?.headers).get("User-Agent")).toBe(
        "ProbeNet/1.0 (post location labels; ops@probe.test)",
      );
      expect(places).toEqual(["Kilimani, Nairobi, Kenya"]);
    });
  });

  it("defaults to the public Nominatim endpoint and six results", async () => {
    const calls = upstream(json([]));
    await searchPlaces("nairobi");
    const url = new URL(calls[0].url);
    expect(url.host).toBe("nominatim.openstreetmap.org");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("limit")).toBe("6");
  });

  it("parameter-encodes the typed text instead of gluing it onto a query string", async () => {
    const calls = upstream(json([]));
    await searchPlaces("nairobi & kenya? 100%");
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("q")).toBe("nairobi & kenya? 100%");
    expect(calls[0].url).not.toContain("&limit=6&q=nairobi & ");
  });

  it("does not call upstream for a query too short to mean anything", async () => {
    const calls = upstream(json([]));
    expect(await searchPlaces("  n  ")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("refuses an over-long query before spending a request on it", async () => {
    const calls = upstream(json([]));
    const huge = "a".repeat(MAX_GEOCODER_QUERY_CHARS + 1);
    await expect(searchPlaces(huge)).rejects.toThrow(/too long/);
    expect(calls).toHaveLength(0);
  });

  it("clamps the result count into a sane range", async () => {
    const calls = upstream(json([]));
    await searchPlaces("qa", 9999);
    await searchPlaces("qq", 0);
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("10");
    expect(new URL(calls[1].url).searchParams.get("limit")).toBe("1");
  });

  it("reports an outage as an outage, never as zero matches", async () => {
    upstream(() => new Response("rate limited", { status: 429 }));
    await expect(searchPlaces("nairobi")).rejects.toBeInstanceOf(GeocoderUnavailable);

    upstream(() => {
      throw new Error("socket hang up");
    });
    await expect(searchPlaces("nairobi")).rejects.toBeInstanceOf(GeocoderUnavailable);

    upstream(json("not an array" as unknown as [], { headers: { "content-type": "text/plain" } }));
    await expect(searchPlaces("nairobi")).rejects.toBeInstanceOf(GeocoderUnavailable);
  });

  it("tolerates rows that carry no usable name", async () => {
    upstream(json([{ display_name: 42 }, null, { display_name: ",," }, {}]));
    expect(await searchPlaces("nairobi")).toEqual([]);
  });

  it("says so when the endpoint answers in a shape it was never documented to", async () => {
    upstream(json({ error: "nothing" } as unknown as []));
    await expect(searchPlaces("nairobi")).rejects.toBeInstanceOf(GeocoderUnavailable);
  });

  it("refuses to point the proxy at a non-HTTP geocoder", () => {
    process.env.GEOCODER_URL = "file:///etc/passwd";
    __resetEnvForTests();
    upstream(json([]));
    return expect(searchPlaces("nairobi")).rejects.toThrow(/http\(s\)/);
  });
});

describe("formatPlaceLabel", () => {
  it("keeps the first segments and trims the padding", () => {
    expect(formatPlaceLabel(" Westlands , Nairobi , Kenya , Kenya")).toBe(
      "Westlands, Nairobi, Kenya",
    );
    expect(formatPlaceLabel("Nakuru")).toBe("Nakuru");
    expect(formatPlaceLabel("a,,,,b")).toBe("a, b");
    expect(formatPlaceLabel("", 3)).toBe("");
  });
});
