/**
 * Application-wide security headers.
 *
 * `server.ts` is the single choke point every request flows through, so it is
 * the right place to attach CSP/HSTS/framing headers regardless of which route
 * produced the response. The CSP is deliberately allowlisted to the origins the
 * app actually talks to; report-only mode is available for the first deploy
 * week via `CSP_REPORT_ONLY=true`.
 */

function truthy(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function isProduction(): boolean {
  const env = process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "";
  return env === "production";
}

/** Host (without protocol) of the Supabase project, for connect-src. */
function supabaseHost(): string | null {
  const url = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"] ?? "";
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

function buildCsp(): string {
  const sb = supabaseHost();
  const connectTargets = [
    "'self'",
    sb ? `https://${sb}` : "",
    sb ? `wss://${sb}` : "",
    "https://api.paystack.co",
    "https://connect.paystack.co",
  ]
    .filter(Boolean)
    .join(" ");

  // In dev, Vite/Start inject inline scripts and open a websocket HMR channel.
  const scriptSrc = isProduction()
    ? "'self' 'wasm-unsafe-eval'"
    : "'self' 'unsafe-inline' 'wasm-unsafe-eval'";

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    `img-src 'self' data: blob: https:`,
    `media-src 'self' blob: https:`,
    `connect-src ${connectTargets}`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self' https://paystack.com`,
    `upgrade-insecure-requests`,
  ].join("; ");
}

/**
 * Non-production previews are legitimately embedded (the Lovable preview and
 * internal staging iframes), so `frame-ancestors 'none'` / X-Frame-Options DENY
 * are only applied in production. Everything else is applied everywhere so the
 * staging surface exercises the same policy.
 */
export function securityHeaders(): Record<string, string> {
  const cspKey = isProduction() && !truthy(process.env["CSP_REPORT_ONLY"])
    ? "content-security-policy"
    : "content-security-policy-report-only";

  const headers: Record<string, string> = {
    [cspKey]: buildCsp(),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy":
      "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()",
  };

  if (isProduction()) {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains; preload";
    headers["x-frame-options"] = "DENY";
  }

  return headers;
}

/** Apply the headers to a response without clobbering route-set ones. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
