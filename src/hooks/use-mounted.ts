import { useEffect, useState } from "react";

// Once the client has painted at least one component, the server/client split
// is over for this JS session. A fresh page load (a real reload) starts a new
// module instance, so this stays `false` until that first paint — hydration
// safety is preserved. It only short-circuits *SPA* remounts.
let hasPaintedOnce = false;

/** True only after the first client paint. SSR and the very first client render
 * both see `false`, so anything gated behind it renders a neutral placeholder on
 * the server and swaps in real user data afterwards — this avoids the auth-driven
 * hydration mismatch where SSR knows the visitor as a guest but the client has
 * already resolved a session. */
export function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Like `useMounted`, but sticky across the whole client session: `true` for any
 * component that mounts after the first paint has already happened. Use it for
 * persistent chrome (the AppShell sidebar avatar / name, the right rail) that
 * remounts on every SPA navigation — otherwise each page swap re-runs the
 * false→true flip and repaints the placeholder avatar for a frame, which reads
 * as flicker. A genuine reload still starts `false` (module state resets), so
 * the hydration guard that `useMounted` exists for is untouched.
 */
export function useMountedStable() {
  const [mounted, setMounted] = useState(hasPaintedOnce);
  useEffect(() => {
    hasPaintedOnce = true;
    setMounted(true);
  }, []);
  return mounted;
}
