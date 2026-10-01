// @vitest-environment node
/**
 * Money and quota decisions must come from configuration, not from a fallback.
 *
 * Three findings from the audit shared one shape: the code that spent real
 * money or real third-party credits answered "I can't confirm the limit" by
 * inventing a number —
 *   * `withdrawalFeeBps` returned 5% whenever `plan_limits` could not be read,
 *     so a Pro creator (1%) would be over-charged on a ledger row that stays in
 *     the books forever;
 *   * the AI quota was compared against `PLAN_DETAILS` — a copy that ships in
 *     the client bundle — so lowering a quota in the console changed the
 *     pricing page but not enforcement;
 *   * nothing bounded checkout attempts, so every click minted a Paystack
 *     transaction and a `pending` payments row that only the supporter's bank
 *     can ever clear.
 * Each is now a refusal with a readable message, which is what these pin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { aiDailyLimitOrThrow, feeBpsOrThrow } from "@/lib/plan-limits";

const limiter = vi.hoisted(() => ({
  allowed: true,
  calls: [] as Array<{ bucket: string; limit: number; windowSeconds: number }>,
}));

vi.mock("@/lib/identity.server", () => ({
  checkRateLimit: vi.fn(async (bucket: string, limit: number, windowSeconds: number) => {
    limiter.calls.push({ bucket, limit, windowSeconds });
    return limiter.allowed;
  }),
  bearerToken: () => null,
  identityFromRequest: async () => null,
  resolveIdentity: async () => null,
  verifySessionToken: async () => null,
}));

const { CHECKOUT_RATE_LIMIT, CHECKOUT_RATE_WINDOW_SECONDS, assertCheckoutAllowed } =
  await import("@/lib/checkout-guard.server");

beforeEach(() => {
  limiter.allowed = true;
  limiter.calls = [];
});

describe("assertCheckoutAllowed", () => {
  it("lets a normal supporter through and counts them per profile", async () => {
    await expect(assertCheckoutAllowed("tip", "profile-1")).resolves.toBeUndefined();
    expect(limiter.calls).toEqual([
      {
        bucket: "checkout:tip:profile-1",
        limit: CHECKOUT_RATE_LIMIT,
        windowSeconds: CHECKOUT_RATE_WINDOW_SECONDS,
      },
    ]);
    expect(CHECKOUT_RATE_LIMIT).toBe(10);
  });

  it("refuses with a human reason when the window is full", async () => {
    limiter.allowed = false;
    await expect(assertCheckoutAllowed("plan", "profile-1")).rejects.toThrow(/too many checkouts/i);
  });

  it("keeps plan and tip budgets separate", async () => {
    limiter.allowed = true;
    await assertCheckoutAllowed("plan", "same-profile");
    await assertCheckoutAllowed("tip", "same-profile");
    expect(limiter.calls.map((c) => c.bucket)).toEqual([
      "checkout:plan:same-profile",
      "checkout:tip:same-profile",
    ]);
  });
});

describe("feeBpsOrThrow", () => {
  it("accepts a configured rate, including a genuine zero", () => {
    expect(feeBpsOrThrow(300, "plus")).toBe(300);
    expect(feeBpsOrThrow(0, "free")).toBe(0);
    expect(feeBpsOrThrow(10_000, "free")).toBe(10_000);
    expect(feeBpsOrThrow("100", "plus")).toBe(100);
    expect(feeBpsOrThrow(333.4, "plus")).toBe(333);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["text", "five percent"],
    ["a negative rate", -1],
    ["more than 100%", 10_001],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a boolean", true],
    ["an object", {}],
  ])("refuses %s instead of charging an invented fee", (label, value) => {
    expect(() => feeBpsOrThrow(value, "pro")).toThrow(
      new Error(
        "We couldn't confirm the withdrawal fee for the pro plan. Please try again in a moment.",
      ),
    );
    expect(label).toBeTruthy();
  });

  it("names the plan in the message without leaking table names", () => {
    expect(() => feeBpsOrThrow(null, "plus")).toThrow(/plus plan/);
    expect(() => feeBpsOrThrow(null, "plus")).not.toThrow(/plan_limits|profile/);
  });
});

describe("aiDailyLimitOrThrow", () => {
  it.each([
    [0, 0],
    [5, 5],
    [9999, 9999],
    ["100", 100],
  ])("keeps a configured %i allowance", (value, expected) => {
    expect(aiDailyLimitOrThrow(value)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["blank", " "],
    ["text", "many"],
    ["a fraction", 2.5],
    ["a negative", -1],
  ])("refuses %s rather than treating it as unlimited", (label, value) => {
    expect(() => aiDailyLimitOrThrow(value)).toThrow(/couldn't confirm your AI drafting limit/i);
    expect(label).toBeTruthy();
  });
});

describe("the call-sites actually use the guards", () => {
  // Source-level, because the behaviour needs a provider, a database and a paid
  // transaction to observe. Every assertion below failed before this rework.
  const paystack = readFileSync("src/lib/paystack.functions.ts", "utf8");
  const payouts = readFileSync("src/lib/payouts.functions.ts", "utf8");
  const ai = readFileSync("src/lib/ai.functions.ts", "utf8");

  const between = (source: string, from: string, to: string) =>
    source.slice(source.indexOf(from), source.indexOf(to));

  it("counts a plan checkout before asking Paystack to open one", () => {
    const handler = between(
      paystack,
      "export const startPaystackCheckout",
      "export const startTipCheckout",
    );
    const guard = handler.indexOf('assertCheckoutAllowed("plan"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handler.indexOf('"/transaction/initialize"'));
  });

  it("counts a tip checkout before asking Paystack to open one", () => {
    const handler = between(
      paystack,
      "export const startTipCheckout",
      "export const confirmPaystackPayment",
    );
    const guard = handler.indexOf('assertCheckoutAllowed("tip"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handler.indexOf('"/transaction/initialize"'));
  });

  it("never imports the server-only guard eagerly (this file ships to the client)", () => {
    expect(paystack).toMatch(
      /const \{ assertCheckoutAllowed.*\} = await import\("@\/lib\/checkout-guard\.server"\)/s,
    );
    expect(paystack).not.toMatch(/^import .*from "@\/lib\/checkout-guard\.server"/m);
  });

  it("withdraws against the configured fee only — the old fallback is gone", () => {
    expect(payouts).not.toMatch(/FALLBACK_FEE_BPS|const bps = Number\(limits\.fee_bps\)/);
    expect(payouts).toMatch(/return feeBpsOrThrow\(limits\.fee_bps, limits\.plan\);/);
    // The withdrawal path reads the fee from plan_limits like every other tier.
    expect(payouts).toMatch(/getPlanLimits\(profileId\)/);
  });

  it("enforces the AI quota from plan_limits, not from the bundled plan copy", () => {
    const quota = between(ai, "async function consumeQuota", "async function chat");
    expect(quota).toMatch(/await getPlanLimits\(profile\.id\)/);
    expect(quota).toMatch(/aiDailyLimitOrThrow\(limits\.ai_drafts_per_day\)/);
    expect(quota).not.toMatch(/limits\.aiDraftsPerDay/);
    // PLAN_DETAILS keeps its job as presentation only (the plan's display name).
    expect(quota).toMatch(/PLAN_DETAILS\[limits\.plan\]\?\.name/);
  });
});
