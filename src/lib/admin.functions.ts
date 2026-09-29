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

/**
 * Which object store the platform is writing to right now, plus a live
 * credential probe. Administrators only, and deliberately without secrets: the
 * bucket name and endpoint host only. This is what tells you that the R2 (or
 * B2 / Spaces / MinIO) credentials you just added were actually picked up.
 */
export const getStorageStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const mod = await import("@/lib/storage/index.server");
    return await mod.storageStatus();
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

    // Access changes are the most sensitive thing an admin does, so they belong
    // in the same audit trail as post deletions and payout decisions.
    const { data: actor } = await admin
      .from("profiles")
      .select("id, display_name, username")
      .eq("auth_user_id", actorAuthId)
      .maybeSingle();
    const { error: auditError } = await admin.from("audit_logs").insert({
      actor_id: actor?.id ?? null,
      actor_name: actor?.display_name || actor?.username || "Administrator",
      actor_role: "admin",
      action: dbRole ? "access.grant" : "access.revoke",
      target_type: "user",
      target_id: target.id,
      details: `${target.username} set to ${dbRole ?? "user"}`,
      severity: dbRole === "admin" ? "warning" : "info",
    });
    if (auditError) console.error("access audit write failed:", auditError.message);

    return { profileId: target.id, username: target.username, role: dbRole ?? "user" };
  });

/**
 * Copy over the objects that still only exist in a retired bucket, so media
 * keeps working after `STORAGE_PROVIDER` moves to R2 (or back to Supabase) even
 * once the old store's credentials leave the environment. Keys are preserved,
 * existing objects are never overwritten and nothing is deleted, so this is
 * idempotent — each call is bounded, so run it until it reports `exhausted`.
 * Administrators only, and a real copy is audited.
 */
export const relocateLegacyMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        dryRun: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(200 * 1024 * 1024)
          .default(32 * 1024 * 1024),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const actorAuthId = await assertAdmin(context);
    const mod = await import("@/lib/storage/relocate.server");
    const reports = await mod.relocateLegacyMedia(data);
    const moved = reports.reduce((sum, report) => sum + report.copied, 0);

    if (!data.dryRun && moved > 0) {
      const admin = await getAdmin();
      const { data: actor } = await admin
        .from("profiles")
        .select("id, display_name, username")
        .eq("auth_user_id", actorAuthId)
        .maybeSingle();
      const { error: auditError } = await admin.from("audit_logs").insert({
        actor_id: actor?.id ?? null,
        actor_name: actor?.display_name || actor?.username || "Administrator",
        actor_role: "admin",
        action: "storage.relocate",
        // The whole bucket is the target, so there is no single row id here and
        // `audit_logs.target_id` is NOT NULL — the route reads from the details.
        target_type: "media",
        target_id: "",
        details: reports.map((report) => mod.describeRelocate(report)).join("; "),
        severity: "info",
      });
      if (auditError) console.error("storage relocation audit write failed:", auditError.message);
    }

    return {
      dryRun: data.dryRun,
      reports: reports.map((report) => ({
        ...report,
        summary: mod.describeRelocate(report, data.dryRun),
      })),
    };
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
