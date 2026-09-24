/**
 * Server-only staff helpers. Import these with `await import(...)` from inside a
 * server-function handler so the service-role client never reaches the browser.
 */

export async function assertStaff(context: any) {
  const { supabase, userId } = context;
  const [{ data: isAdmin }, { data: isMod }] = await Promise.all([
    supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
    supabase.rpc("has_role", { _user_id: userId, _role: "moderator" }),
  ]);
  if (!isAdmin && !isMod) throw new Error("You don't have moderation access.");

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
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

export async function writeAudit(
  staff: Awaited<ReturnType<typeof assertStaff>>,
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
