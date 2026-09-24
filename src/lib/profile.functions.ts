import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function handleFrom(email: string | undefined, fallback: string) {
  const base = (email?.split("@")[0] || fallback).replace(/[^a-z0-9_]/gi, "").toLowerCase();
  return base.slice(0, 18) || "member";
}

/**
 * Guarantees the signed-in auth user has a `profiles` row. Runs with admin
 * rights because a brand-new user has no profile yet, so RLS policies that key
 * off `current_profile_id()` cannot let them insert one themselves.
 */
export const ensureMyProfile = createServerFn({ method: "POST" })
  .inputValidator((input: { displayName?: string } | undefined) => input ?? {})
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { userId, claims } = context;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const lookup = async () => {
      const { data: row } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("auth_user_id", userId)
        .maybeSingle();
      return (row?.id as string | undefined) ?? null;
    };

    const existing = await lookup();
    if (existing) return { id: existing, created: false };

    const email = (claims as { email?: string } | null)?.email;
    const handle = handleFrom(email, "member");

    for (let attempt = 0; attempt < 5; attempt++) {
      const username =
        attempt === 0 ? handle : `${handle}${Math.floor(Math.random() * 9000 + 1000)}`;
      const { data: row, error } = await supabaseAdmin
        .from("profiles")
        .insert({
          auth_user_id: userId,
          username,
          display_name: data.displayName?.trim() || handle,
        })
        .select("id")
        .maybeSingle();

      if (!error && row) return { id: row.id as string, created: true };

      // Another request (or a retry) may have created the row first.
      const raced = await lookup();
      if (raced) return { id: raced, created: false };

      // Only a username clash is worth retrying; anything else is fatal.
      if (error && !/profiles_username/i.test(error.message)) {
        throw new Error(error.message);
      }
    }

    throw new Error("Could not create your profile. Please try again.");
  });
