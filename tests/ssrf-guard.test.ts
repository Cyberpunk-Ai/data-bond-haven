import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeUrl,
  isBlockedAddress,
  safeExternalFetch,
  UnsafeUrlError,
} from "@/lib/ssrf-guard.server";

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

/**
 * `safeExternalFetch` exists because checking a URL and then fetching it
 * somewhere else is not a guard. These cases pin the two halves: nothing leaves
 * the process for an address the deny-list refuses, and the request that does
 * leave cannot be redirected.
 *
 * Public IP literals are used as hosts so the guard takes its literal branch and
 * the test never depends on DNS.
 */
describe("safeExternalFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureFetch(reply: () => Response | Promise<Response>) {
    const calls: { input: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return reply();
      }),
    );
    return calls;
  }

  const HOOKS = [
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.1.2.3/hook",
    "https://[::1]/hook",
    "http://example.com/hook", // plain http is only excused on loopback, in dev
    "https://user:pass@93.184.216.34/hook",
  ];

  it.each(HOOKS)("refuses to dial %s at all", async (target) => {
    const calls = captureFetch(() => new Response("never", { status: 200 }));
    await expect(safeExternalFetch(target, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(calls).toEqual([]);
  });

  it("posts to an allowed endpoint without following redirects", async () => {
    const calls = captureFetch(() => new Response("ok", { status: 200 }));
    const res = await safeExternalFetch("https://93.184.216.34/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"event":"post.created"}',
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("https://93.184.216.34/hook");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe('{"event":"post.created"}');
    expect(calls[0].init?.redirect).toBe("error");
    expect(calls[0].init?.referrerPolicy).toBe("no-referrer");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the caller's signature headers intact while doing so", async () => {
    const calls = captureFetch(() => new Response("ok"));
    await safeExternalFetch("https://93.184.216.34/hook", {
      method: "POST",
      headers: { "x-webhook-signature": "sha256=deadbeef", "x-webhook-id": "d1" },
      body: "{}",
    });
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("x-webhook-signature")).toBe("sha256=deadbeef");
    expect(headers.get("x-webhook-id")).toBe("d1");
  });

  it("names the redirect when the receiver bounces instead of answering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError('Failed to fetch: redirect policy "error" prevented following');
      }),
    );
    await expect(
      safeExternalFetch("https://93.184.216.34/hook", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/redirects; webhook receivers must answer directly/);
  });

  it("passes a plain connection failure through as itself, for the retry path", async () => {
    const boom = new TypeError("socket hang up");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw boom;
      }),
    );
    await expect(
      safeExternalFetch("https://93.184.216.34/hook", { method: "POST", body: "{}" }),
    ).rejects.toBe(boom);
  });

  it("still exports the bare check for save-time validation", async () => {
    const url = await assertSafeUrl("https://93.184.216.34/hook");
    expect(url.host).toBe("93.184.216.34");
    await expect(assertSafeUrl("https://169.254.169.254/")).rejects.toBeInstanceOf(UnsafeUrlError);
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
