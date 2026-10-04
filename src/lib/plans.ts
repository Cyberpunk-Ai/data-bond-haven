export type PlanTier = "free" | "plus" | "pro";
export type BillingCycle = "monthly" | "annual";

export interface PlanLimitSpecs {
  aiDraftsPerDay: number;
  spacesMaxListeners: number;
  spacesAudioQuality: string;
  spacesRecording: boolean;
  mediaUploadMaxMb: number;
  /**
   * MB of stored Space replays this plan may keep at once. A live broadcast
   * costs nothing — only a saved recording fills this budget. Mirrors
   * `plan_limits.spaces_storage_mb` (migration 20260930000093), which is the
   * copy the server and the database actually enforce.
   */
  spacesStorageMb: number;
  analyticsLevel: "Basic" | "Advanced" | "Team / Studio";
  monetization: boolean;
  customBranding: boolean;
  teamWorkspaces: boolean;
  apiAccess: boolean;
  supportLevel: string;
}

export interface PlanDetails {
  id: PlanTier;
  name: string;
  tagline: string;
  badge: string | null;
  badgeText: string;
  badgeColor: string;
  priceMonthly: number;
  priceAnnual: number; // Monthly rate when billed annually (20% off)
  annualBilledTotal: number;
  popular?: boolean;
  ctaText: string;
  features: string[];
  limits: PlanLimitSpecs;
  keyPerks: string[];
}

export const PLAN_DETAILS: Record<PlanTier, PlanDetails> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "For getting started",
    badge: null,
    badgeText: "Free",
    badgeColor: "bg-muted text-muted-foreground border border-border/80",
    priceMonthly: 0,
    priceAnnual: 0,
    annualBilledTotal: 0,
    popular: false,
    ctaText: "Get Started",
    features: [
      "Unlimited posts & stories",
      "Join communities",
      "Basic analytics",
      "Receive tips & withdrawals (5% fee)",
    ],
    limits: {
      aiDraftsPerDay: 5,
      spacesMaxListeners: 10,
      spacesAudioQuality: "Standard Mono",
      spacesRecording: false,
      mediaUploadMaxMb: 10,
      spacesStorageMb: 250,
      analyticsLevel: "Basic",
      monetization: true,
      customBranding: false,
      teamWorkspaces: false,
      apiAccess: false,
      supportLevel: "Community",
    },
    keyPerks: [
      "Unlimited posts & 24h stories",
      "Join public & topic communities",
      "Basic views and likes analytics",
      "5 AI-assisted post drafts / day",
      "Listen to live audio Spaces",
      "Standard Direct Messaging",
    ],
  },
  plus: {
    id: "plus",
    name: "Plus",
    tagline: "For growing creators",
    badge: "✨ Plus",
    badgeText: "Plus",
    badgeColor:
      "bg-gradient-to-r from-violet-500 to-pink-500 text-white font-bold border-0 shadow-xs",
    priceMonthly: 9,
    priceAnnual: 7, // 20% off $9 = ~$7.2 -> $7
    annualBilledTotal: 84,
    popular: true,
    ctaText: "Upgrade to Plus",
    features: [
      "Everything in Free",
      "Advanced analytics",
      "Reduced 3% withdrawal fee",
      "Custom branding",
    ],
    limits: {
      aiDraftsPerDay: 100,
      spacesMaxListeners: 250,
      spacesAudioQuality: "HD Stereo (128 kbps)",
      spacesRecording: true,
      mediaUploadMaxMb: 100,
      spacesStorageMb: 1024,
      analyticsLevel: "Advanced",
      monetization: true,
      customBranding: true,
      teamWorkspaces: false,
      apiAccess: false,
      supportLevel: "Priority Email",
    },
    keyPerks: [
      "✨ Clean Plus creator badge across your profile & comments",
      "Everything in Free included",
      "Advanced reach, demographics & engagement analytics",
      "Reduced withdrawal fee: keep 97% of what you earn",
      "Custom branding: Profile aura & theme accents",
      "100 AI drafts/day with viral hook & audience tones",
      "Host live Spaces for up to 250 listeners with HD audio",
      "100MB 4K media uploads & space recording",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "For serious teams",
    badge: "👑 Pro",
    badgeText: "Pro",
    badgeColor:
      "bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold border-0 shadow-xs",
    priceMonthly: 29,
    priceAnnual: 23, // 20% off $29 = ~$23.2 -> $23
    annualBilledTotal: 276,
    popular: false,
    ctaText: "Upgrade to Pro",
    features: ["Everything in Plus", "Team workspaces", "Priority support", "API access"],
    limits: {
      aiDraftsPerDay: 9999,
      spacesMaxListeners: 1000,
      spacesAudioQuality: "Lossless Spatial (320 kbps)",
      spacesRecording: true,
      mediaUploadMaxMb: 1024,
      spacesStorageMb: 5120,
      analyticsLevel: "Team / Studio",
      monetization: true,
      customBranding: true,
      teamWorkspaces: true,
      apiAccess: true,
      supportLevel: "24/7 Priority Support",
    },
    keyPerks: [
      "👑 Clean Pro gold badge across your profile & spaces",
      "Everything in Plus included",
      "Lowest withdrawal fee: keep 99% of what you earn",
      "Team workspaces & multi-member collaboration",
      "Priority 24/7 support & fast ticket response",
      "Full API access & developer webhooks",
      "Unlimited AI Sparks drafts, threads & story synthesis",
      "Host Spaces for 1,000+ live listeners & co-hosts",
      "1GB RAW media uploads & 320kbps spatial audio recording",
    ],
  },
};

// --- server functions (plan lifecycle) ---
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Downgrades the caller to the free plan. Safe to call repeatedly. */
export const cancelMySubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!profile?.id) throw new Error("Sign in to manage your subscription.");

    const { adminDb } = await import("@/integrations/supabase/client.server");
    const admin = adminDb();
    // Both writes have to land: the UI reads `profiles.plan` for what the account
    // can do, `subscriptions` for what it will be billed. Either one failing on
    // its own silently left a "canceled" screen over a still-charging subscription
    // (or a free plan that still renewed), and supabase-js reports that as success.
    const { error: subError } = await admin
      .from("subscriptions")
      .upsert(
        { user_id: profile.id, plan: "free", billing_cycle: "monthly", status: "canceled" },
        { onConflict: "user_id" },
      );
    if (subError) throw new Error(subError.message || "Could not cancel the subscription.");

    const { error: planError } = await admin
      .from("profiles")
      .update({ plan: "free" })
      .eq("id", profile.id);
    if (planError) {
      // Put the billing record back the way it was rather than leave the two rows
      // disagreeing about what this account pays.
      const { error: undoError } = await admin
        .from("subscriptions")
        .update({ status: "active" })
        .eq("user_id", profile.id);
      // If the undo itself was refused we are exactly where this branch exists to
      // prevent — a canceled billing record over a plan that still says "plus".
      // The caller is told the cancel failed; this says the state is worse than
      // "nothing happened".
      if (undoError)
        console.error(
          "cancelSubscription rollback failed, subscriptions row left canceled:",
          undoError.message,
        );
      throw new Error(planError.message || "Could not cancel the subscription.");
    }
    return { plan: "free" as PlanTier };
  });
