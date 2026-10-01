import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  downloadErrorMessage,
  isPrivateMediaPath,
  isProxiedMediaUrl,
  planDownload,
  withMediaToken,
} from "@/lib/media-download";

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

/**
 * Folders the proxy will not serve to a stranger. The rule lives in
 * `media-download.ts` beside the download rules that have to agree with it, and
 * this module's own name for it is kept for existing importers.
 */
export const isPrivateMediaUrl = isPrivateMediaPath;

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

/** The `mt` capability out of a minted URL, if one was minted. */
function tokenFromMintedUrl(minted: string): string | null {
  try {
    return new URL(minted, "http://local.invalid").searchParams.get("mt");
  } catch {
    return null;
  }
}

function saveBlob(blob: Blob, name: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Releasing the URL too early cancels the save in some browsers; the spec
  // gives the task a turn to start before the blob can be reclaimed.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

/**
 * Save one media object to the user's device.
 *
 * A bare `<a href download>` could not do this for DM media: the stored path is
 * private, so the navigation arrived without a bearer token or a capability and
 * the proxy answered its fail-closed 404. Here the capability is minted first,
 * the bytes are fetched as an authenticated same-origin request, and the file is
 * handed to the browser as a blob — which is the one shape the `download`
 * attribute honours everywhere. If the fetch is not possible, the fallback href
 * still saves, because it carries `dl=1` and the proxy answers it with
 * `Content-Disposition: attachment`.
 *
 * Throws with user-facing copy; callers show it in a toast.
 */
export async function downloadMediaFile(url: string, name: string): Promise<void> {
  if (!url) throw new Error(downloadErrorMessage(null));

  // Anything we don't serve (an external link, a CDN we never routed through
  // the proxy) is opened rather than silently downloaded under a wrong name.
  if (!isProxiedMediaUrl(url) && /^https?:\/\//.test(url)) {
    window.open(url, "_blank", "noopener");
    return;
  }

  const minted = await authorizedMediaUrl(url);
  if (!minted) throw new Error(downloadErrorMessage(401));

  const plan = planDownload(url, name);
  const base = plan.saveHref ?? minted;
  // A private object needs its capability on the attachment URL as well; a
  // public one is minted as a plain proxy path and carries nothing.
  const token = tokenFromMintedUrl(minted);
  const target = withMediaToken(base, token);

  try {
    const res = await fetch(target);
    if (!res.ok) {
      // A 404 here is the object being gone, not a network hiccup, and telling
      // the user to try again would be a lie.
      throw new Error(downloadErrorMessage(res.status));
    }
    saveBlob(await res.blob(), plan.name);
    return;
  } catch (err) {
    if (err instanceof TypeError) {
      // Offline, aborted, or the storage backend refused the cross-origin fetch:
      // a plain navigation is still a download when the server says attachment.
      window.location.assign(target);
      return;
    }
    throw err;
  }
}

/**
 * Hook: turn a stored media URL into one a media element can actually load.
 * `error` is a short, human-safe reason for display when minting fails.
 */
export function useAuthorizedMediaUrl(url: string | null | undefined) {
  // A public object needs no capability, so it is usable on the first render.
  // Leaving it null until the effect ran is what made feed images blink.
  const [src, setSrc] = useState<string | null>(url && !isPrivateMediaUrl(url) ? url : null);
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
