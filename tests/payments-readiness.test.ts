import { afterEach, describe, expect, it } from "vitest";

import { paymentConfigReady } from "@/lib/paystack-api.server";
import { __resetEnvForTests } from "@/lib/env.server";

/**
 * The status page must be able to say "payments degraded" when charges cannot
 * actually be made. That happened for real: `API_KEY_PEPPER` was unset in
 * production, so `env()` threw inside every Paystack handler and each request
 * 500ed, while /api/public/health reported payments as operational because it
 * only mirrored the database check.
 *
 * These cases pin the two halves of that: an unusable server environment reads
 * as not-ready even with a perfectly good live Paystack key, and a complete
 * environment reads as ready.
 */

// APP_ENV always wins over NODE_ENV in env.server.ts, so the cases below only
// need to set APP_ENV and can leave the runner's NODE_ENV alone.
const MANAGED = [
  "APP_ENV",
  "API_KEY_PEPPER",
  "PAYSTACK_SECRET_KEY",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(
  MANAGED.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of MANAGED) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetEnvForTests();
});

/** Apply an environment and evaluate readiness through a fresh `env()` build. */
function readyWith(env: Record<string, string | undefined>): boolean {
  for (const key of MANAGED) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // env() memoises its result, so the contract is only re-checked on demand.
  __resetEnvForTests();
  return paymentConfigReady();
}

const PEPPER = "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4e5f60718293a4b5c6d7e8f90";

const SUPABASE = {
  SUPABASE_URL: "https://probe.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_probe",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_probe",
};

describe("paymentConfigReady", () => {
  it("accepts a complete production environment with a live key", () => {
    expect(
      readyWith({
        APP_ENV: "production",
        API_KEY_PEPPER: PEPPER,
        PAYSTACK_SECRET_KEY: "sk_live_probe",
        ...SUPABASE,
      }),
    ).toBe(true);
  });

  it("reports not-ready when the production pepper is missing, despite a valid live key", () => {
    // This is the exact misconfiguration that killed production payments while
    // the status page stayed green: env() throws before Paystack is ever called.
    expect(
      readyWith({
        APP_ENV: "production",
        PAYSTACK_SECRET_KEY: "sk_live_probe",
        ...SUPABASE,
      }),
    ).toBe(false);
  });

  it("reports not-ready when the pepper is too short to be usable", () => {
    expect(
      readyWith({
        APP_ENV: "production",
        API_KEY_PEPPER: "abc123",
        PAYSTACK_SECRET_KEY: "sk_live_probe",
        ...SUPABASE,
      }),
    ).toBe(false);
  });

  it("reports not-ready when a Supabase credential is missing", () => {
    expect(
      readyWith({
        APP_ENV: "production",
        API_KEY_PEPPER: PEPPER,
        PAYSTACK_SECRET_KEY: "sk_live_probe",
        SUPABASE_URL: SUPABASE.SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY: SUPABASE.SUPABASE_PUBLISHABLE_KEY,
      }),
    ).toBe(false);
  });

  it("rejects a test key in production", () => {
    expect(
      readyWith({
        APP_ENV: "production",
        API_KEY_PEPPER: PEPPER,
        PAYSTACK_SECRET_KEY: "sk_test_probe",
        ...SUPABASE,
      }),
    ).toBe(false);
  });

  it("reports not-ready when no Paystack key is configured at all", () => {
    expect(
      readyWith({
        APP_ENV: "production",
        API_KEY_PEPPER: PEPPER,
        ...SUPABASE,
      }),
    ).toBe(false);
  });

  it("allows a test key outside production", () => {
    expect(
      readyWith({
        APP_ENV: "development",
        PAYSTACK_SECRET_KEY: "sk_test_probe",
        ...SUPABASE,
      }),
    ).toBe(true);
  });
});
