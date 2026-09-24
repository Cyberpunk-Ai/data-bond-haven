/**
 * Moderation and system-settings actions. These all run on the server, verify
 * that the caller really is staff, and write an audit-trail row for every
 * change so nothing can be done invisibly.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function getAdmin() {
  const mod = await import("@/integrations/supabase/client.server");
  return mod.supabaseAdmin;
}

/** Confirms the caller is an admin or moderator and returns who they are. */
async function assertStaff(context: any) {
  const { supabase, userId } = context;
  const [{ data: isAdmin }, { data: isMod }] = await Promise.all([
    supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
    supabase.rpc("has_role", { _user_id: userId, _role: "moderator" }),
  ]);
  if (!isAdmin && !isMod) throw new Error("You don't have moderation access.");

  const admin = await getAdmin();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, display_name, username")
    .eq("auth_user_id", userId)
    .maybeSingle();

  return {
    admin,
    isAdmin: !!isAdmin,
    actorId: (profile?.id as string | undefined) ?? null,
    actorName:
      (profile?.display_name as string | undefined) || (profile?.username as string) || "Staff",
    actorRole: isAdmin ? "admin" : "moderator",
  };
}

type Staff = Awaited<ReturnType<typeof assertStaff>>;

async function writeAudit(
  staff: Staff,
  action: string,
  targetType: string,
  targetId: string,
  details: string,
  severity: "info" | "warning" | "danger" = "info",
) {
  await staff.admin.from("audit_logs").insert({
    actor_id: staff.actorId,
    actor_name: staff.actorName,
    actor_role: staff.actorRole,
    action,
    target_type: targetType,
    target_id: targetId,
    details,
    severity,
  });
}

/** Suspend, reinstate, verify, warn or change the plan of a member. */
export const moderateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        profileId: z.string().uuid(),
        status: z.enum(["active", "suspended", "banned"]).optional(),
        verified: z.boolean().optional(),
        warningCount: z.number().int().min(0).max(50).optional(),
        plan: z.enum(["free", "plus", "pro"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const staff = await assertStaff(context);

    const patch: {
      status?: string;
      warning_count?: number;
      verified?: boolean;
      plan?: string;
    } = {};
    if (data.status !== undefined) patch.status = data.status;
    if (data.warningCount !== undefined) patch.warning_count = data.warningCount;
    if (data.verified !== undefined) {
      if (!staff.isAdmin) throw new Error("Only administrators can change verification.");
      patch.verified = data.verified;
    }
    if (data.plan !== undefined) {
      if (!staff.isAdmin) throw new Error("Only administrators can change someone's plan.");
      patch.plan = data.plan;
    }
    if (Object.keys(patch).length === 0) throw new Error("Nothing to change.");

    const { data: updated, error } = await staff.admin
      .from("profiles")
      .update(patch)
      .eq("id", data.profileId)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("That member no longer exists.");

    // A plan granted from the console is a real, comped subscription.
    if (data.plan !== undefined) {
      await staff.admin.from("subscriptions").upsert(
        {
          user_id: data.profileId,
          plan: data.plan,
          status: data.plan === "free" ? "canceled" : "active",
          provider: "manual",
          renews_at:
            data.plan === "free" ? null : new Date(Date.now() + 30 * 86400000).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
      await staff.admin.from("notifications").insert({
        recipient_id: data.profileId,
        actor_id: staff.actorId,
        type: "system",
        body:
          data.plan === "free"
            ? "Your plan was changed to Free by the Spaces1 team."
            : `Your account was upgraded to ${data.plan === "pro" ? "Pro" : "Plus"} by the Spaces1 team.`,
      });
    }

    const what = Object.entries(patch)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(", ");
    await writeAudit(
      staff,
      "user.update",
      "user",
      data.profileId,
      what,
      data.status && data.status !== "active" ? "danger" : "warning",
    );

    return updated;
  });

/** Hide or permanently remove a post. */
export const moderatePost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ postId: z.string().uuid(), action: z.enum(["hide", "unhide", "delete"]) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const staff = await assertStaff(context);

    if (data.action === "delete") {
      const { error } = await staff.admin.from("posts").delete().eq("id", data.postId);
      if (error) throw new Error(error.message);
      await writeAudit(
        staff,
        "post.force_delete",
        "post",
        data.postId,
        "Post removed by moderator",
        "danger",
      );
      return { ok: true, hidden: true, deleted: true };
    }

    const hidden = data.action === "hide";
    const { error } = await staff.admin.from("posts").update({ hidden }).eq("id", data.postId);
    if (error) throw new Error(error.message);
    await writeAudit(
      staff,
      hidden ? "post.hide" : "post.unhide",
      "post",
      data.postId,
      hidden ? "Post hidden from feeds" : "Post restored to feeds",
      "warning",
    );
    return { ok: true, hidden, deleted: false };
  });

/** Resolve or dismiss a report from the moderation queue. */
export const resolveReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        reportId: z.string().uuid(),
        status: z.enum(["pending", "reviewing", "resolved", "dismissed"]),
        actionTaken: z.string().max(300).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const staff = await assertStaff(context);

    const { data: updated, error } = await staff.admin
      .from("reports")
      .update({ status: data.status, action_taken: data.actionTaken ?? null })
      .eq("id", data.reportId)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("That report no longer exists.");

    await writeAudit(
      staff,
      `report.${data.status}`,
      "report",
      data.reportId,
      data.actionTaken ?? `Marked ${data.status}`,
      "warning",
    );
    return updated;
  });

/** Ends a live audio room. */
export const terminateSpace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ spaceId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const staff = await assertStaff(context);
    const { error } = await staff.admin
      .from("spaces")
      .update({ live: false })
      .eq("id", data.spaceId);
    if (error) throw new Error(error.message);
    await writeAudit(
      staff,
      "space.terminate",
      "space",
      data.spaceId,
      "Space ended by staff",
      "danger",
    );
    return { ok: true };
  });

/** Save the platform-wide settings. Administrators only. */
export const saveSystemSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        maintenance_mode: z.boolean(),
        registration_enabled: z.boolean(),
        stories_enabled: z.boolean(),
        spaces_audio_enabled: z.boolean(),
        ai_generation_enabled: z.boolean(),
        auto_mod_strictness: z.string().max(20),
        max_upload_size_mb: z.number().int().min(1).max(500),
        rate_limit_requests_per_min: z.number().int().min(1).max(10000),
        announcement_banner: z.object({
          active: z.boolean(),
          message: z.string().max(300),
          type: z.string().max(20),
          dismissible: z.boolean(),
        }),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const staff = await assertStaff(context);
    if (!staff.isAdmin) throw new Error("Only administrators can change system settings.");

    const { error } = await staff.admin
      .from("system_settings")
      .upsert({ id: 1, ...data, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) throw new Error(error.message);

    await writeAudit(
      staff,
      "settings.update",
      "system",
      "settings",
      "System settings updated",
      "warning",
    );
    return data;
  });
