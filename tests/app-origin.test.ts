import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isTrustedOrigin, requestOrigin, trustedCallbackOrigin } from "@/lib/app-origin.server";

const ORIGINAL = process.env.ALLOWED_API_ORIGINS;
const ORIGINAL_ENV = process.env.APP_ENV;

beforeEach(() => {
  process.env.ALLOWED_API_ORIGINS = "https://spaces1.com,https://www.spaces1.com";
  delete process.env.APP_ENV;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALLOWED_API_ORIGINS;
  else process.env.ALLOWED_API_ORIGINS = ORIGINAL;
  if (ORIGINAL_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_ENV;
});

function headers(init: Record<string, string>) {
  return new Headers(init);
}

describe("requestOrigin", () => {
  it("prefers the browser's Origin header", () => {
    expect(requestOrigin(headers({ origin: "https://spaces1.com/" }))).toBe("https://spaces1.com");
  });

  it("rebuilds the public address from proxy headers when no Origin is sent", () => {
    const h = headers({ "x-forwarded-host": "spaces1.com", "x-forwarded-proto": "https" });
    expect(requestOrigin(h)).toBe("https://spaces1.com");
  });

  it("assumes https behind a proxy in production, http otherwise", () => {
    const h = headers({ host: "127.0.0.1:3000" });
    expect(requestOrigin(h)).toBe("http://127.0.0.1:3000");
    process.env.APP_ENV = "production";
    expect(requestOrigin(h)).toBe("https://127.0.0.1:3000");
  });

  it("returns null with nothing to go on", () => {
    expect(requestOrigin(headers({}))).toBeNull();
  });
});

describe("isTrustedOrigin", () => {
  it("accepts the origin that served the request", () => {
    expect(isTrustedOrigin("https://spaces1.com", "https://spaces1.com")).toBe(true);
  });

  it("accepts allowlisted origins and loopback dev servers", () => {
    expect(isTrustedOrigin("https://www.spaces1.com", "https://spaces1.com")).toBe(true);
    expect(isTrustedOrigin("http://localhost:8080", null)).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:5173", null)).toBe(true);
  });

  it("rejects strangers and non-origins", () => {
    expect(isTrustedOrigin("https://pay_spaces1.com", "https://spaces1.com")).toBe(false);
    expect(isTrustedOrigin("https://spaces1.com.evil.test", "https://spaces1.com")).toBe(false);
    expect(isTrustedOrigin("javascript:alert(1)", null)).toBe(false);
    expect(isTrustedOrigin("//spaces1.com", null)).toBe(false);
    expect(isTrustedOrigin(null, null)).toBe(false);
  });
});

describe("trustedCallbackOrigin", () => {
  it("keeps a legitimate same-origin report", () => {
    const h = headers({ origin: "https://spaces1.com", host: "127.0.0.1:3000" });
    expect(trustedCallbackOrigin("https://spaces1.com", h)).toEqual({
      origin: "https://spaces1.com",
      fallbackUsed: false,
    });
  });

  it("swaps a forged origin for the real one instead of redirecting off-site", () => {
    const h = headers({ origin: "https://spaces1.com", host: "127.0.0.1:3000" });
    const res = trustedCallbackOrigin("https://attacker.test", h);
    expect(res.origin).toBe("https://spaces1.com");
    expect(res.fallbackUsed).toBe(true);
  });

  it("works with no Origin header at all (server-to-server / curl)", () => {
    const h = headers({ "x-forwarded-host": "spaces1.com", "x-forwarded-proto": "https" });
    expect(trustedCallbackOrigin("https://spaces1.com", h).origin).toBe("https://spaces1.com");
  });

  it("falls back to the configured allowlist when the request has no host info", () => {
    const res = trustedCallbackOrigin(undefined, headers({}));
    expect(res.origin).toBe("https://spaces1.com");
    expect(res.fallbackUsed).toBe(true);
  });

  it("refuses to invent a callback URL when nothing is configured", () => {
    delete process.env.ALLOWED_API_ORIGINS;
    expect(() => trustedCallbackOrigin("https://x.test", headers({}))).toThrow(
      /no configured public URL/,
    );
  });
});
