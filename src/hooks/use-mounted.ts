import { useEffect, useState } from "react";

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
