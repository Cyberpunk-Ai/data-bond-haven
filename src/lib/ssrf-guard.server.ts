import { promises as dns } from "dns";
import { isIP } from "net";

/**
 * Server-side request forgery (SSRF) guard.
 *
 * Outbound fetches to user-supplied URLs (webhook endpoints entered in the
 * Developer Portal) run from the application server, which sits inside the
 * private network and can reach cloud instance-metadata services. A plain
 * string deny-list is insufficient because a hostname can resolve to an
 * internal address.
 *
 * What this guard does, and what it does not claim:
 *   • resolves the host *before* connecting and rejects the URL if ANY resolved
 *     record is in a blocked range;
 *   • hands the request over itself (`safeExternalFetch`), with redirects
 *     refused — following a `302` to `http://169.254.169.254` would otherwise
 *     walk straight past the check on the operator-approved first hop;
 *   • bounds the connection with a timeout so a stalled listener cannot pin a
 *     worker.
 *
 * It does NOT pin the TCP connection to the address it just checked, so a
 * DNS-rebinding host can still answer differently between this lookup and the
 * socket connect. Closing that needs a custom connector/`lookup` hook in the
 * HTTP client (undici `Agent` with a pinned `connect`), not a URL check —
 * tracked as the follow-up that would replace `safeExternalFetch`'s fetch call,
 * not its callers.
 */

// CIDR blocks that must never be reachable from the app server: loopback,
// private RFC1918, carrier-grade NAT, link-local (incl. cloud metadata at
// 169.254.169.254), and "this host on this network".
const BLOCKED_IPV4_CIDRS: Array<{ base: string; bits: number }> = [
  { base: "0.0.0.0", bits: 8 },
  { base: "10.0.0.0", bits: 8 },
  { base: "100.64.0.0", bits: 10 },
  { base: "127.0.0.0", bits: 8 },
  { base: "169.254.0.0", bits: 16 },
  { base: "172.16.0.0", bits: 12 },
  { base: "192.168.0.0", bits: 16 },
];

const BLOCKED_IPV4: Array<{ base: number; mask: number }> = BLOCKED_IPV4_CIDRS.map(
  ({ base, bits }) => ({
    base: ipToInt(base),
    mask: (0xffffffff << (32 - bits)) >>> 0,
  }),
);

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + (Number(part) & 0xff), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return true; // malformed / not v4 → treat as unsafe
  const n = ipToInt(ip);
  if (BLOCKED_IPV4.some(({ base, mask }) => (n & mask) === (base & mask))) return true;
  // Carrier-grade NAT + broadcast + "this host on this network".
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(v) !== 6) return true; // not a valid v6 literal → unsafe
  if (v === "::" || v === "::1") return true;
  // Unique-local fc00::/7 and link-local fe80::/10.
  const first = Number.parseInt(v.split(":")[0] ?? "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address.replace(/^\[|\]$/g, ""));
  if (kind === 4) return isBlockedIpv4(address);
  if (kind === 6) return isBlockedIpv6(address);
  return true; // not an IP literal → caller must resolve first
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const ALLOW_INSECURE_LOOPBACK_DEV =
  (process.env["NODE_ENV"] ?? process.env["APP_ENV"] ?? "") !== "production";

/**
 * Validate a user-supplied outbound URL. Throws `UnsafeUrlError` when the URL
 * is not https, the host is not resolvable, or any resolved address is in a
 * blocked private/link-local/metadata range. `http://localhost` is permitted
 * only outside production to keep local webhook testing workable.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  return (await checkSafeUrl(raw)).url;
}

/**
 * `assertSafeUrl` plus the addresses behind the name, for callers that want to
 * log or pin what was actually checked.
 */
export async function checkSafeUrl(raw: string): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("The URL is not valid.");
  }

  const isLoopbackName =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";

  if (url.protocol === "https:") {
    // ok
  } else if (url.protocol === "http:" && ALLOW_INSECURE_LOOPBACK_DEV && isLoopbackName) {
    // Dev-only loopback exemption, deliberately not resolved: the host name is
    // reported as-is because nothing was looked up.
    return { url, addresses: [url.hostname] };
  } else {
    throw new UnsafeUrlError("Only https:// endpoints are allowed.");
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError("Credentials in the URL are not allowed.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw new UnsafeUrlError("The hostname could not be resolved.");
    }
  }

  if (addresses.length === 0) throw new UnsafeUrlError("The hostname has no addresses.");
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new UnsafeUrlError("That address is not reachable from the platform.");
    }
  }
  return { url, addresses };
}

/**
 * The only outbound helper callers should use for a user-supplied URL: checks
 * the address *and* issues the request, so a handler cannot fetch a URL it never
 * validated or let a redirect carry the request somewhere the guard refused.
 *
 * `redirect: "error"` is deliberate — a receiver that answers a webhook POST
 * with a 3xx is not the contract (it must answer 2xx), and following it would
 * send the customer's HMAC signature and payload to a second, unchecked host.
 */
export async function safeExternalFetch(
  raw: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const { url } = await checkSafeUrl(raw);
  try {
    return await fetch(url.toString(), {
      ...init,
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/redirect/i.test(message)) {
      throw new UnsafeUrlError("That endpoint redirects; webhook receivers must answer directly.");
    }
    throw err;
  }
}
