/**
 * Server-side plan enforcement (M2 — plan §5).
 *
 * Before this module, almost every limit advertised in `plans.ts` was a
 * client-side render decision: the paywall was decorative and a free account
 * could mint Developer API keys. `requirePlanCapability` is the single
 * authoritative check. It reads the caller's plan *from the database* (never a
 * client-supplied string) and the capability matrix from the `plan_limits`
 * table (the single source of truth shared with checkout/pricing), then throws
 * a typed `UpgradeRequiredError` the UI can turn into an "Upgrade" prompt.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// The generated `Database` types predate `plan_limits`; use the untyped admin
// handle for these newer tables (regenerating types.ts is scheduled for M4).
const admin = supabaseAdmin as any;

export type PlanTier = "free" | "plus" | "pro";

export interface PlanLimits {
  plan: PlanTier;
  ai_drafts_per_day: number;
  spaces_max_listeners: number;
  spaces_recording: boolean;
  media_upload_max_mb: number;
  storage_quota_mb: number;
  analytics_level: string;
  monetization: boolean;
  custom_branding: boolean;
  team_workspaces: boolean;
  api_access: boolean;
  fee_bps: number;
}

/** Thrown when an action needs a higher plan. `upgradeTo` drives the CTA. */
export class UpgradeRequiredError extends Error {
  readonly code = "upgrade_required" as const;
  readonly status = 402;
  constructor(
    readonly capability: string,
    readonly currentPlan: PlanTier,
    message: string,
  ) {
    super(message);
    this.name = "UpgradeRequiredError";
  }
}

async function resolvePlan(profileId: string): Promise<PlanTier> {
  const { data: sub } = await admin
    .from("subscriptions")
    .select("plan, status")
    .eq("user_id", profileId)
    .maybeSingle();
  if (sub && sub.status === "active" && isPlanTier(sub.plan)) return sub.plan;

  const { data: profile } = await admin
    .from("profiles")
    .select("plan")
    .eq("id", profileId)
    .maybeSingle();
  return isPlanTier(profile?.plan) ? profile!.plan : "free";
}

function isPlanTier(v: unknown): v is PlanTier {
  return v === "free" || v === "plus" || v === "pro";
}

/** Read the plan + its capability row straight from `plan_limits`. */
export async function getPlanLimits(profileId: string): Promise<PlanLimits> {
  const plan = await resolvePlan(profileId);
  const { data, error } = await admin
    .from("plan_limits")
    .select("*")
    .eq("plan", plan)
    .maybeSingle();
  if (error || !data) {
    // Fail closed to the free tier rather than granting an unknown plan.
    const { data: free } = await admin.from("plan_limits").select("*").eq("plan", "free").single();
    if (!free) throw new Error("Plan configuration is missing (plan_limits empty).");
    return { ...(free as unknown as PlanLimits), plan: "free" };
  }
  return { ...(data as unknown as PlanLimits), plan: isPlanTier(data.plan) ? data.plan : plan };
}

/**
 * Throw unless the caller's plan grants `capability`. `needed` is compared
 * against numeric limits (e.g. an upload's byte size vs `media_upload_max_mb`);
 * for boolean capabilities any `needed > 0` simply requires the flag to be on.
 */
export async function requirePlanCapability(
  profileId: string,
  capability: keyof PlanLimits,
  needed = 1,
): Promise<PlanLimits> {
  const limits = await getPlanLimits(profileId);
  const value = limits[capability];

  if (typeof value === "boolean") {
    if (!value) {
      throw new UpgradeRequiredError(
        capability,
        limits.plan,
        `${humanCapability(capability)} is not included in the ${limits.plan} plan.`,
      );
    }
    return limits;
  }

  if (typeof value === "number") {
    if (needed > value) {
      throw new UpgradeRequiredError(
        capability,
        limits.plan,
        `The ${limits.plan} plan limit for ${humanCapability(capability)} is ${value}; this needs ${needed}.`,
      );
    }
    return limits;
  }

  // string (analytics_level) or unknown — treat as always-allowed presence.
  return limits;
}

function humanCapability(capability: string): string {
  switch (capability) {
    case "api_access":
      return "Developer API access";
    case "monetization":
      return "Monetization";
    case "spaces_recording":
      return "Space recording";
    case "team_workspaces":
      return "Team workspaces";
    case "custom_branding":
      return "Custom branding";
    case "media_upload_max_mb":
      return "media upload size";
    case "spaces_max_listeners":
      return "live Space listeners";
    case "ai_drafts_per_day":
      return "AI drafts";
    default:
      return capability.replace(/_/g, " ");
  }
}

/** Narrow an unknown thrown value to a user-facing upgrade message. */
export function isUpgradeRequired(err: unknown): err is UpgradeRequiredError {
  return err instanceof UpgradeRequiredError;
}
