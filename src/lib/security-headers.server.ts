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
  // Prefer the runtime env, but fall back to the value Vite inlined into the
  // server bundle at build time (import.meta.env.VITE_*). Without that, a
  // production run that doesn't export SUPABASE_URL would emit a connect-src
  // missing the Supabase host and the browser would block all data calls.
  const url =
    process.env["SUPABASE_URL"] ??
    process.env["VITE_SUPABASE_URL"] ??
    (import.meta.env?.VITE_SUPABASE_URL as string | undefined) ??
    "";
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

function buildCsp(enforce: boolean): string {
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

  // TanStack Start's SSR injects inline bootstrap scripts (the stream barrier
  // and scroll-restoration) that carry no nonce/hash, and the scroll payload is
  // request-specific so it can't be pre-hashed. A no-inline script-src therefore
  // blocks hydration and blanks the whole app in production, so we must allow
  // inline scripts. Modern browsers ignore 'unsafe-inline' the moment any
  // nonce/hash is present, so this only takes effect for the current
  // nonce-less setup and does not weaken a future nonce rollout.
  const scriptSrc = "'self' 'unsafe-inline' 'wasm-unsafe-eval'";

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
    // Browsers ignore this directive inside a report-only policy and log a
    // console error every navigation; only ship it when actually enforcing.
    ...(enforce ? [`upgrade-insecure-requests`] : []),
  ].join("; ");
}

/**
 * Non-production previews are legitimately embedded (the editor's preview and
 * internal staging iframes), so `frame-ancestors 'none'` / X-Frame-Options DENY
 * are only applied in production. Everything else is applied everywhere so the
 * staging surface exercises the same policy.
 */
export function securityHeaders(): Record<string, string> {
  const enforce = isProduction() && !truthy(process.env["CSP_REPORT_ONLY"]);
  const cspKey = enforce ? "content-security-policy" : "content-security-policy-report-only";

  const headers: Record<string, string> = {
    [cspKey]: buildCsp(enforce),
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
