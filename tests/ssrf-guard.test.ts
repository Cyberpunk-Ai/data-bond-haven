import { describe, it, expect } from "vitest";
import { isBlockedAddress, assertSafeUrl, UnsafeUrlError } from "@/lib/ssrf-guard.server";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local/metadata and CGN ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.5.5",
      "192.168.0.9",
      "169.254.169.254", // cloud instance metadata endpoint
      "100.64.0.1", // carrier-grade NAT
      "0.0.0.0",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("allows public routable addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it("blocks IPv6 loopback, link-local and unique-local", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("fd12:3456::7890")).toBe(true); // ULA fc00::/7
  });

  it("blocks IPv4-mapped IPv6 into a private range", () => {
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  it("rejects non-https schemes", async () => {
    await expect(assertSafeUrl("http://example.com/hook")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl("ftp://example.com")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects embedded credentials", async () => {
    await expect(assertSafeUrl("https://user:pass@example.com/")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("rejects a literal private-IP target", async () => {
    await expect(assertSafeUrl("https://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });
});
