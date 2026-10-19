import { describe, expect, it } from "vitest";

import { signedInFromCookieHeader } from "@/lib/auth-hint";

// The `/` route's server loader turns this cookie into a pre-render redirect to
// `/feed`, so a false positive would hide the landing page from signed-out
// visitors (and a false negative would bring the flash back). Lock both edges.
describe("signedInFromCookieHeader", () => {
  it("recognises the hint when set", () => {
    expect(signedInFromCookieHeader("spaces.signed_in=1")).toBe(true);
    expect(signedInFromCookieHeader("theme=dark; spaces.signed_in=1")).toBe(true);
    expect(signedInFromCookieHeader("spaces.signed_in=1; other=x")).toBe(true);
    expect(signedInFromCookieHeader("a=b; spaces.signed_in=1; c=d")).toBe(true);
  });

  it("ignores an absent or cleared hint", () => {
    expect(signedInFromCookieHeader(null)).toBe(false);
    expect(signedInFromCookieHeader(undefined)).toBe(false);
    expect(signedInFromCookieHeader("")).toBe(false);
    expect(signedInFromCookieHeader("theme=dark")).toBe(false);
    expect(signedInFromCookieHeader("spaces.signed_in=0")).toBe(false);
    expect(signedInFromCookieHeader("spaces.signed_in=")).toBe(false);
  });

  it("does not match lookalike cookie names or values", () => {
    // substring collisions must not trip the routing decision
    expect(signedInFromCookieHeader("xspaces.signed_in=1")).toBe(false);
    expect(signedInFromCookieHeader("spaces.signed_inx=1")).toBe(false);
    expect(signedInFromCookieHeader("spaces.signed_in=10")).toBe(false);
    expect(signedInFromCookieHeader("spaces.signed_in=11; other=x")).toBe(false);
  });
});
