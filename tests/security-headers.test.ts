// @vitest-environment node
/**
 * The security headers every production response carries.
 *
 * There was no coverage here, and this is a file where a mistake is invisible
 * until the site breaks: a duplicated directive is silently dropped by the
 * browser, an over-wide one turns the allowlist into nothing, and a vendor the
 * CDN injects but the policy refuses logs a console error on every page view
 * while collecting no data at all — which is exactly how the Cloudflare Insights
 * beacon reported itself here.
 */
import { afterEach, describe, expect, it } from "vitest";

import { securityHeaders, withSecurityHeaders } from "@/lib/security-headers.server";

const ENFORCE_KEY = "content-security-policy";
const REPORT_KEY = "content-security-policy-report-only";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function policy(): string {
  const headers = securityHeaders();
  return headers[ENFORCE_KEY] ?? headers[REPORT_KEY] ?? "";
}

/** The value of one directive, or "" when the policy does not set it. */
function directive(name: string): string {
  return (
    policy()
      .split("; ")
      .find((part) => part.startsWith(`${name} `))
      ?.slice(name.length + 1) ?? ""
  );
}

describe("the script allowlist names hosts instead of opening them up", () => {
  it("permits the analytics beacon the CDN injects", () => {
    // Nothing in this repository writes that <script> tag: Cloudflare adds it at
    // the edge when Web Analytics is on. Refusing it is not a neutral choice —
    // it is a feature the operator enabled, silently not working, plus a console
    // error per navigation.
    expect(directive("script-src")).toContain("https://static.cloudflareinsights.com");
  });

  it("permits the endpoint the beacon reports to as well", () => {
    // Letting the script load and then blocking its POST is the same broken
    // outcome with one fewer error line, so both halves are pinned.
    expect(directive("connect-src")).toContain("https://cloudflareinsights.com");
  });

  it("keeps 'unsafe-inline' because the SSR bootstrap has no nonce to carry", () => {
    const src = directive("script-src");
    expect(src).toContain("'unsafe-inline'");
    expect(src).toContain("'self'");
    // WebRTC/audio work needs the wasm evaluator; dropping it breaks playback.
    expect(src).toContain("'wasm-unsafe-eval'");
  });

  it("refuses a wildcard that would make the directive pointless", () => {
    // A bare `https:` source means "any CDN anywhere may run code on this
    // origin", which is the opposite of why this file exists. Named hosts are
    // fine; scheme-wide grants and `*` are not.
    for (const source of directive("script-src").split(" ")) {
      expect(source).not.toMatch(/^[a-z][a-z0-9+.-]*:$/i);
      expect(source).not.toBe("*");
    }
    expect(directive("default-src")).toBe("'self'");
    expect(directive("object-src")).toBe("'none'");
  });
});

describe("the data endpoints the app actually calls", () => {
  it("carries the Supabase host in both its REST and realtime forms", () => {
    process.env.SUPABASE_URL = "https://projectref.supabase.co";
    const src = directive("connect-src");
    // Realtime is a websocket; allowing only https would let the app read and
    // silently never receive a live event.
    expect(src).toContain("https://projectref.supabase.co");
    expect(src).toContain("wss://projectref.supabase.co");
  });

  it("allows Paystack, including the redirect to hosted checkout", () => {
    const src = directive("connect-src");
    expect(src).toContain("https://api.paystack.co");
    expect(src).toContain("https://connect.paystack.co");
    expect(directive("form-action")).toContain("https://paystack.com");
  });

  it("survives a missing SUPABASE_URL rather than emitting a broken directive", () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    const src = directive("connect-src");
    expect(src.startsWith("'self'")).toBe(true);
    expect(src).not.toContain("undefined");
    expect(src).not.toContain("  ");
  });

  it("gives Spaces the permissions audio and screen share need", () => {
    const perms = securityHeaders()["permissions-policy"] ?? "";
    expect(perms).toContain("microphone=(self)");
    expect(perms).toContain("display-capture=(self)");
    expect(perms).toContain("camera=(self)");
  });
});

describe("report-only versus enforced", () => {
  it("never blocks in a preview, so staging exercises the same policy safely", () => {
    delete process.env.APP_ENV;
    process.env.NODE_ENV = "test";
    const headers = securityHeaders();
    expect(headers[ENFORCE_KEY]).toBeUndefined();
    expect(headers[REPORT_KEY]).toBeTruthy();
    // Previews are legitimately iframed (the editor, internal staging), so a hard
    // DENY here would break the very environment that tests this file.
    expect(headers["x-frame-options"]).toBeUndefined();
    expect(headers["strict-transport-security"]).toBeUndefined();
  });

  it("enforces, frames none and hsts strictly in production", () => {
    process.env.APP_ENV = "production";
    const headers = securityHeaders();
    expect(headers[ENFORCE_KEY]).toBeTruthy();
    expect(headers[REPORT_KEY]).toBeUndefined();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["strict-transport-security"]).toContain("includeSubDomains");
    expect(directive("frame-ancestors")).toBe("'none'");
  });

  it("steps back to report-only when the operator asks for it", () => {
    process.env.APP_ENV = "production";
    process.env.CSP_REPORT_ONLY = "true";
    const headers = securityHeaders();
    expect(headers[ENFORCE_KEY]).toBeUndefined();
    expect(headers[REPORT_KEY]).toBeTruthy();
  });

  it("omits upgrade-insecure-requests from a report-only policy", () => {
    // Browsers ignore the directive outside an enforced policy and log a console
    // error on every navigation saying so — noise that hides a real violation.
    delete process.env.APP_ENV;
    process.env.NODE_ENV = "test";
    expect(policy()).not.toContain("upgrade-insecure-requests");

    process.env.APP_ENV = "production";
    expect(policy()).toContain("upgrade-insecure-requests");
  });
});

describe("the policy string itself", () => {
  it("sets each directive exactly once", () => {
    // A repeated directive is not merged: the browser takes one of them, so a
    // second `script-src` would quietly discard the first.
    const names = policy()
      .split("; ")
      .map((part) => part.split(" ")[0]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("separates directives the way a CSP parser expects", () => {
    expect(policy()).toContain("; ");
    expect(policy()).not.toMatch(/;;/);
    expect(policy()).not.toContain("  ");
  });
});

describe("attaching the headers to a response", () => {
  it("adds them without clobbering what a route already set", async () => {
    const response = withSecurityHeaders(
      new Response("ok", {
        headers: { "content-security-policy": "default-src 'self'", "cache-control": "no-store" },
      }),
    );
    // A route that tightened its own policy did that on purpose.
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(await response.text()).toBe("ok");
  });
});
