import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type AppRole = "admin" | "moderator";

/** UI roles map onto the two real database roles. */
function toDbRole(uiRole: string): AppRole | null {
  if (uiRole === "admin" || uiRole === "superadmin") return "admin";
  if (uiRole === "moderator" || uiRole === "analyst" || uiRole === "community") return "moderator";
  return null;
}

async function getAdmin() {
  const mod = await import("@/integrations/supabase/client.server");
  return mod.supabaseAdmin;
}

async function assertAdmin(context: any) {
  const { supabase, userId } = context;
  const { data: isAdmin } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (!isAdmin) throw new Error("Only administrators can change access levels.");
  return userId as string;
}

/** Roles currently granted, keyed by profile id. */
export const listAccessLevels = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const admin = await getAdmin();

    const [{ data: roles }, { data: profiles }] = await Promise.all([
      admin.from("user_roles").select("user_id, role"),
      admin.from("profiles").select("id, auth_user_id"),
    ]);

    const byAuthId = new Map<string, string>();
    for (const p of profiles ?? []) {
      if (p.auth_user_id) byAuthId.set(p.auth_user_id as string, p.id as string);
    }

    const map: Record<string, AppRole> = {};
    for (const r of roles ?? []) {
      const profileId = byAuthId.get(r.user_id as string);
      if (!profileId) continue;
      // admin wins over moderator
      if (map[profileId] === "admin") continue;
      map[profileId] = r.role as AppRole;
    }
    return map;
  });

/** Grants or removes admin / moderator access for a member. */
export const setAccessLevel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ profileId: z.string().min(1), role: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const actorAuthId = await assertAdmin(context);
    const admin = await getAdmin();

    const { data: target } = await admin
      .from("profiles")
      .select("id, username, auth_user_id")
      .eq("id", data.profileId)
      .maybeSingle();

    if (!target?.auth_user_id) {
      throw new Error("This member hasn't finished signing up yet, so access can't be changed.");
    }
    if (target.auth_user_id === actorAuthId) {
      throw new Error("You can't change your own access level.");
    }

    const dbRole = toDbRole(data.role);

    await admin.from("user_roles").delete().eq("user_id", target.auth_user_id);
    if (dbRole) {
      const { error } = await admin
        .from("user_roles")
        .insert({ user_id: target.auth_user_id, role: dbRole });
      if (error) throw new Error(error.message);
    }

    return { profileId: target.id, username: target.username, role: dbRole ?? "user" };
  });

/** Does the signed-in person have console access? */
export const getMyAccessLevel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    const [{ data: isAdmin }, { data: isMod }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: userId, _role: "moderator" }),
    ]);
    return { isAdmin: !!isAdmin, isModerator: !!isMod };
  });
