/**
 * Read the signed-in host's Space replay storage, so the room can tell them the
 * truth before they press Record: a live broadcast costs no storage, and this is
 * how much of their *replay* budget the replays they already keep have used.
 *
 * Numbers come from the server (`plan_limits` + `media_objects`), never from
 * anything the browser claims — the same source the upload endpoint refuses a
 * recording against.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface SpaceStorageSnapshot {
  plan: string;
  canRecord: boolean;
  roomMaxBytes: number;
  quotaBytes: number;
  usedBytes: number;
  replays: number;
}

export const getSpaceStorageState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SpaceStorageSnapshot> => {
    const { supabase, userId } = context as any;
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!profile?.id) throw new Error("Sign in to check your Space storage.");

    const { readSpaceStorage } = await import("@/lib/space-storage.server");
    const state = await readSpaceStorage(String(profile.id));
    return {
      plan: state.plan,
      canRecord: state.canRecord,
      roomMaxBytes: state.roomMaxBytes,
      quotaBytes: state.quotaBytes,
      usedBytes: state.usedBytes,
      replays: state.replays,
    };
  });
