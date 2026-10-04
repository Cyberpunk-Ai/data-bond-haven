import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  hashApiKey,
  newApiToken,
  signPayload,
  requireCronSecret,
  apiCorsHeaders,
} from "@/lib/api-auth.server";
import { env, __resetEnvForTests } from "@/lib/env.server";

describe("hashApiKey", () => {
  beforeEach(() => {
    delete process.env["API_KEY_PEPPER"];
  });

  it("refuses to hash without a strong pepper (no unsalted fallback)", () => {
    expect(() => hashApiKey("sp1_live_deadbeef")).toThrow(/API_KEY_PEPPER/);
    process.env["API_KEY_PEPPER"] = "too-short";
    expect(() => hashApiKey("sp1_live_deadbeef")).toThrow(/32 characters/);
  });

  it("is a keyed HMAC-SHA256 over the pepper once a strong pepper is set", () => {
    const pepper = "k".repeat(64);
    process.env["API_KEY_PEPPER"] = pepper;
    const token = "sp1_live_" + "a".repeat(48);
    const expected = createHmac("sha256", pepper).update(token).digest("hex");
    expect(hashApiKey(token)).toBe(expected);
    // Different token → different digest; same token → stable digest.
    expect(hashApiKey(token)).toBe(hashApiKey(token));
    expect(hashApiKey(token + "1")).not.toBe(expected);
  });
});

describe("newApiToken", () => {
  it("mints a Spaces1-prefixed 48-hex token (not a Stripe-shaped key)", () => {
    const token = newApiToken();
    expect(token).toMatch(/^sp1_live_[a-f0-9]{48}$/);
    expect(token.startsWith("sk_live_")).toBe(false);
  });
});

describe("signPayload", () => {
  it("is deterministic and timestamp-sensitive", () => {
    const a = signPayload("secret", '{"x":1}', "1700000000");
    const b = signPayload("secret", '{"x":1}', "1700000000");
    const c = signPayload("secret", '{"x":1}', "1700000001");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("env()", () => {
  beforeEach(() => {
    __resetEnvForTests();
  });

  it("throws when a required Supabase secret is missing", () => {
    for (const k of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      delete process.env[k];
    }
    expect(() => env()).toThrow(/SUPABASE_URL/);
  });

  it("parses canonical values and the CORS allowlist", () => {
    process.env["SUPABASE_URL"] = "https://x.supabase.co";
    process.env["SUPABASE_PUBLISHABLE_KEY"] = "sb_publishable_abc";
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = "jwt-service";
    process.env["APP_ENV"] = "development";
    process.env["ALLOWED_API_ORIGINS"] = "https://a.test, https://b.test/";
    const e = env();
    expect(e.supabaseUrl).toBe("https://x.supabase.co");
    expect(e.allowedApiOrigins).toEqual(["https://a.test", "https://b.test"]);
  });
});

function requestWithAuth(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request("http://localhost/api/cron/anything", { headers });
}

describe("requireCronSecret", () => {
  beforeEach(() => {
    delete process.env["CRON_SECRET"];
  });

  it("fails closed when the secret is unset, even against a supplied bearer", () => {
    // An unset CRON_SECRET must never compare equal to any header — otherwise
    // every scheduler route is wide open until an operator remembers to set it.
    expect(requireCronSecret(requestWithAuth("anything"))).toBe(false);
    expect(requireCronSecret(requestWithAuth(null))).toBe(false);
  });

  it("rejects a missing or empty bearer even when the secret is set", () => {
    process.env["CRON_SECRET"] = "s3cr3t-value";
    expect(requireCronSecret(requestWithAuth(null))).toBe(false);
    expect(requireCronSecret(requestWithAuth(""))).toBe(false);
  });

  it("accepts the exact secret and rejects anything else without throwing", () => {
    process.env["CRON_SECRET"] = "s3cr3t-value";
    expect(requireCronSecret(requestWithAuth("s3cr3t-value"))).toBe(true);
    expect(requireCronSecret(requestWithAuth("wrong"))).toBe(false);
    // Different length must be rejected via the length guard, not by letting
    // timingSafeEqual throw on mismatched buffers.
    expect(() => requireCronSecret(requestWithAuth("short"))).not.toThrow();
    expect(requireCronSecret(requestWithAuth("short"))).toBe(false);
  });
});

describe("apiCorsHeaders", () => {
  const ORIGINAL = process.env["ALLOWED_API_ORIGINS"];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["ALLOWED_API_ORIGINS"];
    else process.env["ALLOWED_API_ORIGINS"] = ORIGINAL;
  });

  it("never echoes `*` and returns no headers when the allowlist is empty", () => {
    delete process.env["ALLOWED_API_ORIGINS"];
    expect(apiCorsHeaders("*")).toEqual({});
    expect(apiCorsHeaders("https://any.test")).toEqual({});
  });

  it("omits CORS headers for an absent or non-allowlisted origin", () => {
    process.env["ALLOWED_API_ORIGINS"] = "https://a.test,https://b.test";
    expect(apiCorsHeaders(null)).toEqual({});
    expect(apiCorsHeaders("https://evil.test")).toEqual({});
  });

  it("echoes an allowlisted origin (tolerating a trailing slash), never a wildcard", () => {
    process.env["ALLOWED_API_ORIGINS"] = "https://a.test/";
    const headers = apiCorsHeaders("https://a.test");
    expect(headers["access-control-allow-origin"]).toBe("https://a.test");
    expect(headers["access-control-allow-origin"]).not.toBe("*");
    expect(headers["vary"]).toBe("Origin");
    // A request carrying the allowlisted origin with a trailing slash still
    // matches after normalization and echoes its own value back.
    expect(apiCorsHeaders("https://a.test/")["access-control-allow-origin"]).toBe(
      "https://a.test/",
    );
  });
});
