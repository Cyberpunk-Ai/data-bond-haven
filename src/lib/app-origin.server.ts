/**
 * Which origins this deployment trusts as its own public address.
 *
 * Payments (`/billing/callback`) and any other provider redirect we hand to a
 * third party must point back at *our* site. Taking the value the browser
 * reported (`window.location.origin`) is not enough: a caller can post any
 * origin they like and the payment page would then bounce the user to a
 * look-alike domain after they pay. So the candidate is checked against the
 * operator's allowlist plus the origin this very request arrived on, and a
 * mismatch silently degrades to the request's own origin.
 *
 * Production configuration is one env key — `ALLOWED_API_ORIGINS` — which is
 * already required for the Developer API's CORS, so spaces1.com needs no extra
 * setting: `ALLOWED_API_ORIGINS=https://spaces1.com,https://www.spaces1.com`.
 */

/** Origins that are always fine locally, on any port. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function normalize(value: string | null | undefined): string | null {
  const text = value?.trim().replace(/\/+$/, "");
  if (!text) return null;
  if (!/^https?:\/\//.test(text)) return null;
  try {
    const url = new URL(text);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function isLoopback(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Operator allowlist, shared with the Developer API so one key configures both. */
function allowedOrigins(): Set<string> {
  const raw = process.env["ALLOWED_API_ORIGINS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((o) => normalize(o))
      .filter((o): o is string => Boolean(o)),
  );
}

/**
 * The origin this request actually arrived on, reconstructed from proxy headers
 * (the app runs behind a TLS-terminating reverse proxy in production, so the
 * `host` header alone would say `http://127.0.0.1:3000`).
 */
export function requestOrigin(headers: Headers): string | null {
  const fromHeader = normalize(headers.get("origin"));
  if (fromHeader && fromHeader !== "null") return fromHeader;

  const host =
    headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    headers.get("host")?.split(",")[0]?.trim();
  if (!host) return null;
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const production = (process.env["APP_ENV"] ?? process.env["NODE_ENV"]) === "production";
  const scheme = (forwardedProto || (production ? "https" : "http")).replace(/:$/, "");
  return normalize(`${scheme}://${host}`);
}

/** Is this origin one we are willing to redirect a user back to? */
export function isTrustedOrigin(origin: string | null, selfOrigin: string | null): boolean {
  const candidate = normalize(origin);
  if (!candidate) return false;
  // Serving the request proves that origin is a live address of this app —
  // including preview deployments, which is why dev needs no env entry.
  if (selfOrigin && candidate === selfOrigin) return true;
  if (isLoopback(candidate)) return true;
  return allowedOrigins().has(candidate);
}

/**
 * Resolve a client-reported origin to a safe absolute base for provider
 * callbacks. Never throws for a legitimate same-origin caller.
 */
export function trustedCallbackOrigin(
  candidate: string | undefined,
  headers: Headers,
): { origin: string; fallbackUsed: boolean } {
  const self = requestOrigin(headers);
  const requested = normalize(candidate);
  if (requested && isTrustedOrigin(requested, self)) {
    return { origin: requested, fallbackUsed: false };
  }
  if (self) {
    if (requested) {
      console.warn(
        `[payments] ignored untrusted callback origin "${requested}" in favour of "${self}"`,
      );
    }
    return { origin: self, fallbackUsed: true };
  }
  // No way to derive our own address (no Origin/Host header) — the only safe
  // answer is the explicitly configured allowlist, if there is one.
  const [first] = [...allowedOrigins()];
  if (first) return { origin: first, fallbackUsed: true };
  throw new Error("This deployment has no configured public URL for payment redirects.");
}
