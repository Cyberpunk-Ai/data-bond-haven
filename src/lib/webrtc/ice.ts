/**
 * Shared ICE-server builder (M4 — plan §7.4 dedup + §S4 ephemeral TURN).
 *
 * `useSpaceAudio` and `useCallSession` each had their own copy of this — with
 * subtly different null-handling for username/credential — reading static TURN
 * credentials out of the browser bundle. Both now await this one function,
 * which combines public STUN with short-lived TURN fetched from the server.
 *
 * Credentials are memoised for a little under their TTL so a burst of
 * connections (a mesh of WebRTC peers) doesn't hammer the credential endpoint.
 */
import { getTurnCredentials } from "@/lib/turn.functions";

const PUBLIC_STUN: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

// Refresh a minute before the ~60 min default expiry.
const CACHE_MS = 55 * 60 * 1000;

let cached: { servers: RTCIceServer[]; expiresAt: number } | null = null;

/**
 * Resolve the ICE server list for a new RTCPeerConnection. Falls back to
 * STUN-only when TURN is unconfigured or the credential endpoint is unreachable,
 * so calls still work on the open internet — just not behind symmetric NATs.
 */
export async function buildIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.servers;

  let servers = PUBLIC_STUN;
  try {
    const res = await getTurnCredentials({});
    const turn = (res?.iceServers ?? [])
      .filter((s) => s.urls?.length && s.username && s.credential)
      .map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));
    if (turn.length > 0) servers = [...PUBLIC_STUN, ...turn];
  } catch {
    // STUN-only fallback; the ephemeral credential service is best-effort.
  }

  cached = { servers, expiresAt: now + CACHE_MS };
  return servers;
}
