import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { hashApiKey, newApiToken, signPayload } from "@/lib/api-auth.server";
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
