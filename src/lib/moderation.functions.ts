/**
 * Moderation and system-settings actions. These all run on the server, verify
 * that the caller really is staff, and write an audit-trail row for every
 * change so nothing can be done invisibly.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { appConfig } from "@/lib/config";

/** Server-only feature-flag helpers, imported lazily so the service-role
 *  client behind them never reaches a bundle that ships to a browser. */
async function getFlags() {
  const mod = await import("@/lib/feature-flags.server");
  return mod;
}

/** Confirms the caller is an admin or moderator and returns who they are.
 * Delegates to the single implementation in `staff.server` — this used to be a
 * copy of it, and copies of an authorization check are how one side drifts. */
async function assertStaff(context: any) {
  const { assertStaff: shared } = await import("@/lib/staff.server");
  return shared(context);
}

type Staff = Awaited<ReturnType<typeof assertStaff>>;

/** Records a staff action in the audit trail. Delegates to the one implementation
 * in `staff.server` — payouts, admin and moderation all log through it, and a
 * second copy is how one of them ends up silently dropping its rows. */
async function writeAudit(
  staff: Staff,
  action: string,
  targetType: string,
  targetId: string,
  details: string,
  severity: "info" | "warning" | "danger" = "info",
) {
  const { writeAudit: shared } = await import("@/lib/staff.server");
  return shared(staff, action, targetType, targetId, details, severity);
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

    // Locking yourself out would strand the console (no other admin may be
    // around to undo it), so a staff member can't ban/suspend their own account.
    if (
      (data.status === "banned" || data.status === "suspended") &&
      staff.actorId &&
      data.profileId === staff.actorId
    ) {
      throw new Error("You can't suspend or ban your own account.");
    }

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

    // A status change is only useful if it actually reaches the person it's
    // about: tell them in-app (a notification the recipient's realtime bell
    // picks up instantly) and, for a ban/suspension, cut their auth session off
    // server-side so they can't keep acting on a stale token.
    if (data.status !== undefined) {
      const messageByStatus: Record<string, string> = {
        banned: `Your account has been banned for violating the ${appConfig.brand.name} Community Guidelines. You can no longer post, comment or message.`,
        suspended:
          "Your account has been temporarily suspended. Some actions are restricted until it is restored.",
        active: `Your account has been restored to good standing. Welcome back to ${appConfig.brand.name}.`,
        flagged:
          "Your account has been flagged for review. Please double-check the Community Guidelines.",
      };
      const { error: noticeError } = await staff.admin.from("notifications").insert({
        recipient_id: data.profileId,
        actor_id: staff.actorId,
        type: "system",
        body: messageByStatus[data.status] ?? `Your account status is now ${data.status}.`,
      });
      // The ban is enforced either way; a missing alert just means they find out
      // at their next sign-in, so record it rather than pretend it was delivered.
      if (noticeError) console.error("moderation notice not stored:", noticeError.message);

      // Enforce the ban/suspension at the auth layer too, not just the profile
      // row: RLS already blocks writes for non-active members, but revoking the
      // login (and, for bans, the sign-in itself) makes the change take effect
      // for the intended user immediately rather than on their next token bump.
      const restricted = data.status === "banned" || data.status === "suspended";
      const { data: targetProfile } = await staff.admin
        .from("profiles")
        .select("auth_user_id")
        .eq("id", data.profileId)
        .maybeSingle();
      if (targetProfile?.auth_user_id) {
        try {
          await staff.admin.auth.admin.updateUserById(targetProfile.auth_user_id as string, {
            app_metadata: restricted
              ? { access_status: data.status, restricted_at: new Date().toISOString() }
              : { access_status: "active" },
            ...(data.status === "banned" ? { ban_duration: "876000h" } : {}),
          });
        } catch (err) {
          // Session revocation is best-effort; the notification + profile flag
          // already landed and RLS keeps the account read-only regardless.
          console.error("moderation: auth session revoke failed:", err);
        }
      }
    }

    // A plan granted from the console is a real, comped subscription.
    if (data.plan !== undefined) {
      const { error: subError } = await staff.admin.from("subscriptions").upsert(
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
      if (subError) {
        // Half a grant is worse than none: the profile row already carries the new
        // plan, so the billing record has to agree with it. Say it failed and let
        // the operator retry — the whole handler is idempotent.
        throw new Error(subError.message || "Could not record that plan change.");
      }
      const { error: planNoticeError } = await staff.admin.from("notifications").insert({
        recipient_id: data.profileId,
        actor_id: staff.actorId,
        type: "system",
        body:
          data.plan === "free"
            ? `Your plan was changed to Free by the ${appConfig.brand.name} team.`
            : `Your account was upgraded to ${data.plan === "pro" ? "Pro" : "Plus"} by the ${appConfig.brand.name} team.`,
      });
      if (planNoticeError) console.error("plan-change notice not stored:", planNoticeError.message);
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

/** Hide or permanently remove a post; mark or clear its sensitive-media flag. */
export const moderatePost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        postId: z.string().uuid(),
        action: z.enum(["hide", "unhide", "delete", "mark_sensitive", "unmark_sensitive"]),
      })
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

    if (data.action === "mark_sensitive" || data.action === "unmark_sensitive") {
      const sensitive = data.action === "mark_sensitive";
      // Written here rather than through the `moderate_post_sensitivity()` RPC:
      // that function decides staff-ness from the caller's own JWT, and a
      // service-role request has none — `assertStaff` above is this path's
      // authorization, and it has already been satisfied.
      //
      // A staff decision also pins `sensitive_source`, which is what stops the
      // community-report trigger from overriding a moderator either way.
      const { error } = await staff.admin
        .from("posts")
        .update({
          is_sensitive: sensitive,
          sensitive_source: sensitive ? "staff" : null,
        })
        .eq("id", data.postId);
      if (error) throw new Error(error.message);
      await writeAudit(
        staff,
        sensitive ? "post.mark_sensitive" : "post.unmark_sensitive",
        "post",
        data.postId,
        sensitive
          ? "Media marked sensitive — readers with the filter on see it blurred"
          : "Sensitive flag cleared by staff",
        "warning",
      );
      return { ok: true, sensitive };
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
        // Vocabulary must match ModerationReport (types.ts) and the moderation
        // queue UI — "investigating", not "reviewing" (that is payouts' dialect).
        status: z.enum(["pending", "investigating", "resolved", "dismissed"]),
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
        announcement_banner: z
          .object({
            active: z.boolean(),
            message: z.string().max(300),
            type: z.string().max(20),
            // The admin tab edits this field too; without it zod silently
            // stripped the destination link on every save.
            link: z.string().max(500).optional(),
            dismissible: z.boolean(),
          })
          .refine((b) => !b.active || b.message.trim().length > 0, {
            message: "Announcement banner needs a message before it can go live.",
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

    // Drop this server's cached flags so the new configuration is enforced on
    // the very next request instead of up to its cache TTL later.
    try {
      (await getFlags()).invalidatePlatformFlags();
    } catch (err) {
      console.warn("[settings] flag cache invalidation skipped:", err);
    }
    return data;
  });
