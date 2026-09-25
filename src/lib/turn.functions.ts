/**
 * Client-facing ephemeral TURN endpoint (M4 — plan §S4).
 *
 * Authenticated so a stranger can't drive the relay-credential service, and it
 * returns only the short-lived ICE servers — never the shared secret. The
 * browser WebRTC hooks call this via `lib/webrtc/ice.ts`.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getTurnCredentials = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async (): Promise<{
      iceServers: Array<{ urls: string[]; username: string; credential: string }>;
    }> => {
      // Server-only module imported lazily: this file is reachable from the client
      // bundle, so a top-level `.server.ts` import is not allowed.
      const { getTurnIceServers } = await import("@/lib/turn.server");
      return { iceServers: await getTurnIceServers() };
    },
  );
