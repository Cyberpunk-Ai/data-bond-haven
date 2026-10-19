import { createServerFn } from "@tanstack/react-start";

import { signedInFromCookieHeader } from "@/lib/auth-hint";

/**
 * Server-only read of the signed-in routing hint cookie.
 *
 * The `/` landing route needs to know, during SSR, whether this device has a
 * session — but a route file ships to the client bundle, where the
 * `@tanstack/react-start/server` request API is blocked. Wrapping the read in a
 * server function keeps the request access on the server (the handler never
 * reaches the client graph) while the loader stays a normal isomorphic loader.
 *
 * It reads only the hint cookie, never the Supabase session, and returns a
 * boolean routing suggestion — it grants no access. `/feed` still verifies the
 * real session independently.
 */
export const readSignedInHint = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  return signedInFromCookieHeader(getRequest().headers.get("cookie"));
});
