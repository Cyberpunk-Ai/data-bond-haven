import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

/**
 * Client helper for media that the browser cannot fetch with an Authorization
 * header. `<audio>`, `<video>` and `<img>` subresource loads carry cookies, not
 * bearer tokens, so private objects (Space recordings, DM attachments) need the
 * signed URL that `/api/media/token` mints. Public objects are returned as-is.
 */

interface CachedUrl {
  url: string;
  /** Epoch ms after which the token must be re-minted. */
  refreshAt: number;
}

const cache = new Map<string, CachedUrl>();
const inflight = new Map<string, Promise<string | null>>();
/** Refresh this early so a long-running player never hits an expired token. */
const REFRESH_SKEW_MS = 60_000;

export function isPrivateMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^\/api\/public\/media\/(recordings|messages|stories)\//.test(url);
}

/**
 * Resolve a playable/displayable URL for `url`. Returns the original URL for
 * public objects and a freshly minted signed URL for private ones.
 */
export async function authorizedMediaUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  if (!isPrivateMediaUrl(url)) return url;

  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.refreshAt > now) return hit.url;

  const pending = inflight.get(url);
  if (pending) return pending;

  const task = (async () => {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return null;
    const res = await fetch("/api/media/token", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      console.warn("media token notice:", res.status);
      return null;
    }
    const json = (await res.json()) as { url?: string; expiresAt?: number | null };
    if (!json?.url) return null;
    const expiresAt = typeof json.expiresAt === "number" ? json.expiresAt : now + 5 * 60_000;
    cache.set(url, { url: json.url, refreshAt: Math.max(now, expiresAt - REFRESH_SKEW_MS) });
    return json.url;
  })().finally(() => {
    inflight.delete(url);
  });

  inflight.set(url, task);
  return task;
}

/** Drop a cached token (e.g. after the element reports an access error). */
export function invalidateMediaUrl(url: string) {
  cache.delete(url);
}

/**
 * Hook: turn a stored media URL into one a media element can actually load.
 * `error` is a short, human-safe reason for display when minting fails.
 */
export function useAuthorizedMediaUrl(url: string | null | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(isPrivateMediaUrl(url));
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = useCallback(async (target: string | null | undefined) => {
    if (!target) {
      setSrc(null);
      setLoading(false);
      return;
    }
    if (!isPrivateMediaUrl(target)) {
      setSrc(target);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const resolved = await authorizedMediaUrl(target);
    if (!mounted.current) return;
    if (resolved) {
      setSrc(resolved);
    } else {
      setError("This recording could not be streamed.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void request(url);
  }, [url, request]);

  return {
    src,
    loading,
    error,
    /** Re-mint after an expiry mid-playback. */
    refresh: () => {
      if (url) invalidateMediaUrl(url);
      return request(url);
    },
  };
}
