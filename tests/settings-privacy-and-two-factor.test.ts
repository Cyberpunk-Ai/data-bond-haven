import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  isFactorActive,
  normalizeRecoveryCode,
  totpCode,
  totpProvisioningUri,
  verifyTotp,
} from "@/lib/totp";
import {
  sensitiveMediaNotice,
  sensitiveRevealLabel,
  shouldBlurSensitive,
} from "@/lib/content-filter";
import { friendlyError } from "@/lib/error-messages";

/**
 * Two halves of the same promise, which is what Settings > Privacy is for:
 * a switch a person flips has to change something, or it must not be on screen.
 *
 * The "Filter sensitive content" and "Allow message requests" toggles are now
 * enforced (reader-side blur, and a database trigger that refuses the first
 * message of a closed thread). The "Two-factor authentication" switch was a
 * lie — nothing behind it existed — so its UI is gone while the backend is
 * built out first: real RFC 6238 codes, storage no client can read, and a
 * failure budget. Wiring that screen later is a UI task; getting the primitives
 * and the grants right now is what makes the eventual switch honest.
 */

// RFC 6238 Appendix B, Table 1: the shared test seed is the ASCII digits 1…20
// (20 bytes, HMAC-SHA1), and the codes below are the published 8-digit values
// truncated to the 6 digits every authenticator app actually shows.
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"], //       94287082
  [1111111109, "081804"], // 07081804
  [1111111111, "050471"], // 14050471
  [1234567890, "005924"], // 89005924
  [2000000000, "279037"], // 69279037
  [20000000000, "353130"], // 65353130
];

describe("TOTP is the real RFC 6238, not an approximation", () => {
  it("encodes and decodes the base32 the spec publishes", () => {
    expect(base32Encode(new TextEncoder().encode("12345678901234567890"))).toBe(RFC_SEED);
    expect([...base32Decode(RFC_SEED)].length).toBe(20);
    expect(new TextDecoder().decode(base32Decode(RFC_SEED))).toBe("12345678901234567890");
    // Authenticator apps hand secrets back with spaces and dashes, and lower
    // case is common in copy-paste.
    expect(base32Decode(rfcSpaced(RFC_SEED).toLowerCase())).toEqual(base32Decode(RFC_SEED));
  });

  it("produces every published test vector", async () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(await hotp(RFC_SEED, Math.floor(seconds / 30))).toBe(expected);
      expect(await totpCode(RFC_SEED, { now: seconds })).toBe(expected);
    }
  });

  it("accepts a code one step late or early, and no further", async () => {
    // Clocks drift, and a person reading a code off a phone beside a laptop is
    // routinely a few seconds behind. Two steps is where that stops being true.
    const now = 1_111_111_111;
    const code = await totpCode(RFC_SEED, { now });
    expect(await verifyTotp(code, RFC_SEED, { now })).toBe(true);
    expect(await verifyTotp(code, RFC_SEED, { now: now + 30 })).toBe(true);
    expect(await verifyTotp(code, RFC_SEED, { now: now - 30 })).toBe(true);
    expect(await verifyTotp(code, RFC_SEED, { now: now + 90 })).toBe(false);
    expect(await verifyTotp(code, RFC_SEED, { now: now - 90 })).toBe(false);
  });

  it("answers false instead of throwing at anything malformed", async () => {
    // This is called with whatever a text field holds. A thrown error would be
    // an outage on the sign-in path; a wrong answer is just a wrong answer.
    for (const junk of ["", "   ", "abc123", "12", "1234567", "six digits"]) {
      expect(await verifyTotp(junk, RFC_SEED)).toBe(false);
    }
    expect(await verifyTotp("287082", "!!! not base32 !!!")).toBe(false);
    expect(await verifyTotp(" 287082 ", RFC_SEED, { now: 59 })).toBe(true);
  });

  it("issues a secret with the shape every authenticator app expects", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
    // 20 bytes is RFC 6238's recommendation for SHA-1, and what apps accept.
    expect([...base32Decode(secret)].length).toBe(20);
  });

  it("builds a provisioning URI that survives a display name with punctuation", () => {
    const uri = totpProvisioningUri({
      secretBase32: RFC_SEED,
      accountName: "ada@example.com",
      issuer: "Spaces1 & Co",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${RFC_SEED}`);
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain("algorithm=SHA1");
    // `&` in an unencoded issuer would end the label and corrupt the QR code.
    expect(uri).not.toContain("Spaces1 & Co?");
    expect(uri).toContain("Spaces1%20%26%20Co");
  });
});

describe("recovery codes are a small credential store, not text", () => {
  it("generates readable, unambiguous, distinct codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
      // No `l`, `i`, `o`, `1` or `0`: these are read off a screen and typed.
      expect(code).not.toMatch(/[lio10]/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("hashes whatever the person typed to the same digest", async () => {
    const code = generateRecoveryCodes(1)[0];
    const digest = await hashRecoveryCode(code);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Case, spacing and the decorative dash are all noise: a code retyped from
    // a photograph has to match the one that was handed out.
    expect(await hashRecoveryCode(`  ${code.toUpperCase()} `)).toBe(digest);
    expect(await hashRecoveryCode(code.replace("-", ""))).toBe(digest);
    expect(await hashRecoveryCode(code.replace("-", " "))).toBe(digest);
    expect(await hashRecoveryCode("wrong-code")).not.toBe(digest);
    expect(normalizeRecoveryCode(" ABC-123 ")).toBe("abc123");
  });

  it("only counts a factor as protection once it has been proven", () => {
    // A secret that was issued but never confirmed must not gate a sign-in: the
    // account would be locked behind a factor nobody showed they could satisfy.
    expect(isFactorActive({ status: "active", verified_at: "2026-10-03T00:00:00Z" })).toBe(true);
    expect(isFactorActive({ status: "pending", verified_at: null })).toBe(false);
    expect(isFactorActive({ status: "active", verified_at: null })).toBe(false);
    expect(isFactorActive({ status: "disabled", verified_at: "2026-10-03T00:00:00Z" })).toBe(false);
    expect(isFactorActive(null)).toBe(false);
    expect(isFactorActive(undefined)).toBe(false);
  });
});

describe("the sensitive-content filter is a reader choice with named escapes", () => {
  const flagged = { is_sensitive: true, sensitive_source: "community", user_id: "author-1" };

  it("blurs only what has been flagged, and only for someone who asked", () => {
    expect(shouldBlurSensitive({ post: flagged, filterEnabled: true, viewerId: "me" })).toBe(true);
    expect(shouldBlurSensitive({ post: flagged, filterEnabled: false, viewerId: "me" })).toBe(
      false,
    );
    expect(
      shouldBlurSensitive({ post: { ...flagged, is_sensitive: false }, filterEnabled: true }),
    ).toBe(false);
  });

  it("never blurs the reader's own media, and never a revealed post", () => {
    expect(shouldBlurSensitive({ post: flagged, filterEnabled: true, viewerId: "author-1" })).toBe(
      false,
    );
    expect(
      shouldBlurSensitive({ post: flagged, filterEnabled: true, viewerId: "me", revealed: true }),
    ).toBe(false);
  });

  it("treats a column the query did not select as not sensitive", () => {
    // A feed page built before the migration (or a query that names its columns)
    // must show media, not smear every card in the list with a veil.
    expect(shouldBlurSensitive({ post: {}, filterEnabled: true, viewerId: "me" })).toBe(false);
    expect(shouldBlurSensitive({ post: null, filterEnabled: true })).toBe(false);
    expect(shouldBlurSensitive({ post: undefined, filterEnabled: true })).toBe(false);
    // A signed-out viewer ("guest") is not an author, so the flag still applies.
    expect(shouldBlurSensitive({ post: flagged, filterEnabled: true, viewerId: "guest" })).toBe(
      true,
    );
  });

  it("says who decided, and offers only the two honest buttons", () => {
    expect(sensitiveMediaNotice("staff")).toContain("moderators");
    expect(sensitiveMediaNotice("community")).toContain("people on Spaces1");
    expect(sensitiveMediaNotice(null)).toBe(sensitiveMediaNotice(undefined));
    expect(sensitiveRevealLabel(false)).toBe("Tap to reveal");
    expect(sensitiveRevealLabel(true)).toBe("Hide again");
  });

  it("turns the trigger's token into a sentence, everywhere", () => {
    expect(friendlyError("MESSAGE_REQUESTS_CLOSED")).toContain("only accept messages");
    expect(friendlyError(new Error("message_requests_closed"))).toBe(
      friendlyError("MESSAGE_REQUESTS_CLOSED"),
    );
  });
});

function rfcSpaced(value: string): string {
  return value.replace(/(.{4})(?!.+$)/g, "$1 ");
}

describe("the switch on screen is the rule in the database", () => {
  // Source-level: the enforcement lives in a trigger and in the browser's
  // decoder, neither of which a node test can run.
  const settings = readFileSync("src/routes/settings.tsx", "utf8");
  const requests = readFileSync("db/migrations/20261003000002_message_requests.sql", "utf8");
  const sensitive = readFileSync("db/migrations/20261003000003_sensitive_content.sql", "utf8");
  const card = readFileSync("src/components/social/PostCard.tsx", "utf8");

  it("leaves the second-factor switch off the screen until it can be turned on", () => {
    expect(settings.toLowerCase()).not.toContain("two-factor");
    expect(settings).not.toContain("two_factor");
    // …and the one security row that is still a promise keeps saying so.
    expect(settings).toContain('label="Login alerts"');
    expect(settings).toMatch(/label="Login alerts"[\s\S]{0,160}soon/);
  });

  it("wires both privacy toggles to real enforcement", () => {
    expect(settings).toMatch(/usePersistentToggle\(\s*"allow_message_requests",\s*true/);
    expect(settings).toMatch(/usePersistentToggle\("filter_sensitive", false/);
    expect(settings).toMatch(/label="Allow message requests"[\s\S]{0,200}allowMessageRequests/);
    expect(settings).toMatch(/label="Filter sensitive content"[\s\S]{0,200}filterSensitive/);
    expect(card).toContain('readToggle("filter_sensitive", false)');
  });

  it("refuses a closed request without refusing the thread it belongs to", () => {
    expect(requests).toContain("before insert on public.messages");
    expect(requests).toContain("MESSAGE_REQUESTS_CLOSED");
    expect(requests).toContain("'allow_message_requests'");
    // Default allow: the switch is off unless the account explicitly turned it
    // on, so an absent preferences row (or an absent key) changes nothing.
    expect(requests).toContain("v_allow is distinct from 'false'");
    // The three exemptions, each of which is a bug prevented: messaging
    // yourself, a sender the recipient follows, and — the one people hit first —
    // replying inside a thread the recipient started, which is not a request.
    expect(requests).toContain("v_recipient = new.sender_id");
    expect(requests).toContain("from public.follows");
    expect(requests).toContain("from public.messages m");
    expect(requests).toContain("m.sender_id = v_recipient");
  });

  it("earns the flag from three people, and lets staff overrule them", () => {
    expect(sensitive).toMatch(/count\(distinct reporter_id\)/);
    expect(sensitive).toMatch(/v_voices >= 3/);
    expect(sensitive).toContain("'inappropriate'");
    expect(sensitive).toMatch(/sensitive_source[^\n]*'staff'/);
    expect(sensitive).toContain("moderate_post_sensitivity");
    expect(sensitive).toContain("NOT_STAFF");
    // Staff override both ways: the community trigger skips a post a moderator
    // has already decided about, so a fresh report cannot re-blur what was cleared.
    expect(sensitive).toContain("sensitive_source is distinct from 'staff'");
  });
});
