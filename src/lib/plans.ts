export type PlanTier = "free" | "plus" | "pro";
export type BillingCycle = "monthly" | "annual";

export interface PlanLimitSpecs {
  aiDraftsPerDay: number;
  spacesMaxListeners: number;
  spacesAudioQuality: string;
  spacesRecording: boolean;
  mediaUploadMaxMb: number;
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
    features: ["Unlimited posts & stories", "Join communities", "Basic analytics"],
    limits: {
      aiDraftsPerDay: 5,
      spacesMaxListeners: 10,
      spacesAudioQuality: "Standard Mono",
      spacesRecording: false,
      mediaUploadMaxMb: 10,
      analyticsLevel: "Basic",
      monetization: false,
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
    features: ["Everything in Free", "Advanced analytics", "Monetization tools", "Custom branding"],
    limits: {
      aiDraftsPerDay: 100,
      spacesMaxListeners: 250,
      spacesAudioQuality: "HD Stereo (128 kbps)",
      spacesRecording: true,
      mediaUploadMaxMb: 100,
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
      "Monetization tools: Tips, subscriber funding & payouts",
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
      "Team workspaces & multi-member collaboration",
      "Priority 24/7 support & fast ticket response",
      "Full API access & developer webhooks",
      "Unlimited Gemini AI drafts, threads & story synthesis",
      "Host Spaces for 1,000+ live listeners & co-hosts",
      "1GB RAW media uploads & 320kbps spatial audio recording",
    ],
  },
};

export interface ComparisonPerk {
  name: string;
  description: string;
  category:
    "Core Features" | "Analytics & Growth" | "Monetization" | "Spaces & Media" | "Badges & Support";
  free: string | boolean;
  plus: string | boolean;
  pro: string | boolean;
  highlight?: boolean;
}

export const COMPARISON_PERKS: ComparisonPerk[] = [
  // Core Features
  {
    name: "Posts & Stories",
    description: "Publish feeds, updates, and ephemeral 24-hour visual stories",
    category: "Core Features",
    free: "Unlimited",
    plus: "Unlimited",
    pro: "Unlimited",
  },
  {
    name: "Communities",
    description: "Join public, topic-based, and creator groups",
    category: "Core Features",
    free: "Unlimited",
    plus: "Unlimited",
    pro: "Unlimited",
  },
  {
    name: "Gemini AI Drafts",
    description: "AI-assisted content generation, viral hooks, and rewrites",
    category: "Core Features",
    free: "5 / day",
    plus: "100 / day",
    pro: "Unlimited",
    highlight: true,
  },
  {
    name: "Team Workspaces",
    description: "Shared brand accounts, team member invites, and role controls",
    category: "Core Features",
    free: false,
    plus: false,
    pro: true,
    highlight: true,
  },

  // Analytics & Growth
  {
    name: "Analytics Level",
    description: "Insights into impressions, reach, profile views, and follower growth",
    category: "Analytics & Growth",
    free: "Basic view counts",
    plus: "Advanced Reach & Trends",
    pro: "Team Studio & Export",
    highlight: true,
  },
  {
    name: "Audience Demographics",
    description: "Breakdown of follower geography, active hours, and top interests",
    category: "Analytics & Growth",
    free: false,
    plus: true,
    pro: true,
  },

  // Monetization
  {
    name: "Monetization Tools",
    description: "Creator tips, direct fan funding, and subscriber revenue",
    category: "Monetization",
    free: false,
    plus: true,
    pro: true,
    highlight: true,
  },
  {
    name: "Platform Fee",
    description: "Percentage retained on creator payouts",
    category: "Monetization",
    free: "N/A",
    plus: "5%",
    pro: "0% (Keep 100%)",
  },

  // Spaces & Media
  {
    name: "Live Audio Spaces Capacity",
    description: "Maximum simultaneous listeners in your hosted rooms",
    category: "Spaces & Media",
    free: "10 listeners",
    plus: "250 listeners",
    pro: "1,000+ listeners",
    highlight: true,
  },
  {
    name: "Audio Broadcast Quality",
    description: "Bitrate and sound fidelity for speakers and musical jams",
    category: "Spaces & Media",
    free: "Standard Mono",
    plus: "HD Stereo (128 kbps)",
    pro: "Spatial Lossless (320 kbps)",
  },
  {
    name: "Space Recordings",
    description: "Save past broadcasts for replay and podcast downloads",
    category: "Spaces & Media",
    free: false,
    plus: true,
    pro: true,
  },
  {
    name: "Media Upload Limit",
    description: "Maximum file size for photos, 4K videos, and attachments",
    category: "Spaces & Media",
    free: "10 MB",
    plus: "100 MB",
    pro: "1 GB",
  },

  // Badges & Support
  {
    name: "Profile Badge",
    description: "Clean authenticity badge displayed across profile, feed, and comments",
    category: "Badges & Support",
    free: "Clean Member",
    plus: "✨ Plus Badge",
    pro: "👑 Pro Badge",
    highlight: true,
  },
  {
    name: "Custom Branding",
    description: "Custom profile gradient auras, highlight cards, and branding accents",
    category: "Badges & Support",
    free: false,
    plus: true,
    pro: true,
    highlight: true,
  },
  {
    name: "Developer API Access",
    description: "REST & Webhook endpoints to publish posts and read analytics programmatically",
    category: "Badges & Support",
    free: false,
    plus: false,
    pro: true,
    highlight: true,
  },
  {
    name: "Support Level",
    description: "Dedicated assistance and resolution channels",
    category: "Badges & Support",
    free: "Community Help",
    plus: "Priority Email",
    pro: "24/7 Priority Support",
  },
];

export interface InvoiceItem {
  id: string;
  date: string;
  amount: number;
  plan: PlanTier;
  cycle: BillingCycle;
  status: "paid" | "refunded" | "pending";
}

export const SAMPLE_INVOICES: InvoiceItem[] = [];
