/**
 * Ephemeral TURN credential minting (M4 — plan §S4).
 *
 * Static TURN credentials baked into the JS bundle are extractable by every
 * visitor and let them use the relay for free. Instead the server mints
 * short-lived (default ~1h) credentials per request and the shared secret never
 * reaches the browser. Two deployment shapes are supported, chosen by the scheme
 * of `TURN_REST_URL`:
 *
 *   • `turn:`/`stun:` URL  → coturn `use-auth-secret` (RFC 5766 turn:REST):
 *     username = `<expiryEpoch>:<nonce>`, credential = base64(HMAC-SHA1(secret,
 *     username)). The relay address itself is public; only the HMAC secret is
 *     private (`TURN_REST_API_KEY`).
 *   • `http(s)://` URL     → a hosted REST credential service (Twilio/Metered/
 *     Xirsys). We POST with HTTP Basic (`TURN_REST_USERNAME:TURN_REST_API_KEY`)
 *     and normalise the provider's JSON into `RTCIceServer`-shaped entries.
 *
 * No configuration ⇒ an empty list, and the caller falls back to public STUN.
 */
import { createHmac, randomBytes } from "crypto";

import { env } from "@/lib/env.server";

export interface TurnIceServer {
  urls: string[];
  username: string;
  credential: string;
}

/** coturn static-auth-secret HMAC (RFC 5766 time-limited username). */
function mintCoturn(relayUrl: string, secret: string, ttlSeconds: number): TurnIceServer {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expires}:${randomBytes(8).toString("hex")}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return {
    urls: relayUrl
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    username,
    credential,
  };
}

/** Normalise the many slightly-different REST provider shapes. */
function normalizeRestPayload(json: any): TurnIceServer[] {
  const out: TurnIceServer[] = [];
  const topLevelUser = json?.username;
  const topLevelCred = json?.credential ?? json?.password;

  const list = json?.iceServers;
  if (Array.isArray(list)) {
    for (const entry of list) {
      const urls = Array.isArray(entry?.urls)
        ? entry.urls.map(String)
        : entry?.urls
          ? [String(entry.urls)]
          : [];
      const username = entry?.username ?? topLevelUser;
      const credential = entry?.credential ?? entry?.password ?? topLevelCred;
      if (urls.length && username && credential) out.push({ urls, username, credential });
    }
  }

  if (out.length === 0 && json?.urls && topLevelUser && topLevelCred) {
    const urls = Array.isArray(json.urls) ? json.urls.map(String) : [String(json.urls)];
    out.push({ urls, username: String(topLevelUser), credential: String(topLevelCred) });
  }

  return out;
}

/** Fetch credentials from a hosted REST TURN service. */
async function fetchFromRestService(
  endpoint: string,
  username: string,
  apiKey: string,
  ttlSeconds: number,
): Promise<TurnIceServer[]> {
  const basic = Buffer.from(`${username}:${apiKey}`).toString("base64");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ttl: String(ttlSeconds) }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`TURN REST service responded ${res.status}`);
    return [];
  }
  return normalizeRestPayload(await res.json());
}

/** The active, short-lived TURN ICE servers (empty when TURN is unconfigured). */
export async function getTurnIceServers(): Promise<TurnIceServer[]> {
  const { restUrl, username, apiKey, ttlSeconds } = env().turn;
  if (!restUrl || !apiKey) return [];

  if (/^https?:\/\//i.test(restUrl)) {
    if (!username) {
      console.error("TURN_REST_USERNAME is required for a REST credential service.");
      return [];
    }
    try {
      return await fetchFromRestService(restUrl, username, apiKey, ttlSeconds);
    } catch (err) {
      console.error("TURN REST fetch failed:", err);
      return [];
    }
  }

  // coturn HMAC path — the relay URL is public, the apiKey is the shared secret.
  return [mintCoturn(restUrl, apiKey, ttlSeconds)];
}
