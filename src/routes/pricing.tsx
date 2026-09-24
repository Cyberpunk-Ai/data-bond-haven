import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  Sparkles,
  Check,
  Zap,
  Radio,
  ShieldCheck,
  DollarSign,
  ArrowRight,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
} from "lucide-react";
import { AppShell } from "@/components/social/AppShell";
import { useAuth } from "@/lib/auth-state";
import { type PlanTier } from "@/lib/plans";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/pricing")({
  validateSearch: (search: Record<string, unknown>): { plan?: string } => ({
    plan: search.plan ? String(search.plan) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Plans & Perks — Spaces1" },
      {
        name: "description",
        content:
          "Simple, transparent plans designed for creators, live audio hosts, and media teams.",
      },
      { property: "og:title", content: "Plans & Perks — Spaces1" },
      {
        property: "og:description",
        content:
          "Simple, transparent plans designed for creators, live audio hosts, and media teams.",
      },
    ],
  }),
  component: PricingPage,
});

function PricingPage() {
  const [annual, setAnnual] = useState(false);
  const { isLoggedIn } = useAuth();
  const { currentPlan, cancelSubscription } = usePlan();
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const requestedPlan = params.get("plan") || params.get("tier");
      if (requestedPlan === "plus" || requestedPlan === "pro") {
        openUpgradeModal(requestedPlan === "plus" ? "Upgrade to Plus" : "Upgrade to Pro");
      }
    }
  }, []);

  // Exact plans structure and copy matching the homepage pricing
  const plans = [
    {
      id: "free" as PlanTier,
      name: "Free",
      tagline: "For getting started",
      monthly: 0,
      features: ["Unlimited posts & stories", "Join communities", "Basic analytics"],
      cta: "Get Started",
      style:
        "border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-muted/40 text-foreground",
      popular: false,
    },
    {
      id: "plus" as PlanTier,
      name: "Plus",
      tagline: "For growing creators",
      monthly: 9,
      features: [
        "Everything in Free",
        "Advanced analytics",
        "Monetization tools",
        "Custom branding",
      ],
      cta: "Get Started",
      style:
        "border border-violet-200 dark:border-violet-500/30 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30",
      popular: true,
    },
    {
      id: "pro" as PlanTier,
      name: "Pro",
      tagline: "For serious teams",
      monthly: 29,
      features: ["Everything in Plus", "Team workspaces", "Priority support", "API access"],
      cta: "Contact Sales",
      style:
        "border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-muted/40 text-foreground",
      popular: false,
    },
  ];

  const handlePlanAction = async (tier: PlanTier) => {
    if (!isLoggedIn) {
      window.location.href = "/auth";
      return;
    }

    if (tier === currentPlan) {
      toast.info(`You are currently on the ${tier.toUpperCase()} plan.`);
      return;
    }

    if (tier === "free") {
      if (
        confirm(
          "Are you sure you want to switch to the Free plan? You will retain all your past posts and followers.",
        )
      ) {
        try {
          await cancelSubscription();
          toast.success("Account set to Free plan.");
        } catch (err) {
          console.error("Failed to cancel subscription:", err);
          toast.error(
            err instanceof Error ? err.message : "Could not switch to Free. Please try again.",
          );
        }
      }
      return;
    }

    openUpgradeModal(tier === "plus" ? "Upgrade to Plus" : "Upgrade to Pro");
  };

  // Small creative perks highlights
  const creativePerks = [
    {
      icon: Sparkles,
      title: "Verified Badges",
      desc: "Distinctive creator badges across comments, feeds, and live rooms.",
    },
    {
      icon: Radio,
      title: "HD Audio Spaces",
      desc: "Broadcast stereo audio with high listener limits and live recording.",
    },
    {
      icon: DollarSign,
      title: "Creator Tips & Subs",
      desc: "Monetize directly with low 0–5% platform fees and transparent payouts.",
    },
    {
      icon: ShieldCheck,
      title: "Team & API Control",
      desc: "Collaborative workspaces, role management, and developer API keys.",
    },
  ];

  const faqs = [
    {
      q: "Can I switch or cancel my plan at any time?",
      a: "Yes! You can switch between plans or cancel anytime with one click in Settings. When cancelled, you retain access until the end of your billing cycle and then cleanly transition to the Free plan without losing posts or followers.",
    },
    {
      q: "How does the annual discount work?",
      a: "Selecting annual billing provides a 20% discount on both Plus ($7/mo billed annually) and Pro ($23/mo billed annually) plans.",
    },
    {
      q: "When are creator badges activated?",
      a: "Verified Plus and Pro badges are applied instantly to your avatar, profile, and posts immediately upon activating your plan.",
    },
  ];

  return (
    <AppShell title="Plans & Perks">
      <div className="relative isolate overflow-hidden min-h-[calc(100vh-4rem)]">
        {/* Creative Ambient Background Glows */}
        <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 -translate-x-1/2 transform-gpu blur-3xl sm:-top-80">
          <div
            className="aspect-[1155/678] w-[68rem] bg-gradient-to-tr from-brand to-brand-pink opacity-20 dark:opacity-15"
            style={{
              clipPath:
                "polygon(74.1% 44.1%, 100% 61.6%, 97.5% 26.9%, 85.5% 0.1%, 80.7% 2%, 72.5% 32.5%, 60.2% 62.4%, 52.4% 68.1%, 47.5% 58.3%, 45.2% 34.5%, 27.5% 76.7%, 0.1% 64.9%, 17.9% 100%, 27.6% 76.8%, 76.1% 97.7%, 74.1% 44.1%)",
            }}
          />
        </div>

        <div className="mx-auto max-w-6xl px-4 py-12 md:py-16 space-y-16">
          {/* Header Section matching Homepage Typography & Voice */}
          <div className="mx-auto max-w-3xl text-center space-y-4">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 border border-brand/20 px-3.5 py-1 text-xs font-bold text-violet-700 dark:text-violet-300 shadow-xs">
              <Sparkles className="h-3.5 w-3.5 text-brand" />
              <span>Transparent & Simple</span>
            </div>

            <h1 className="text-4xl font-extrabold sm:text-5xl md:text-6xl tracking-tight text-foreground">
              Simple, <span className="gradient-text">fair</span> pricing
            </h1>
            <p className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Start free. Upgrade when you're ready to go further.
            </p>

            {/* Toggle Annual/Monthly Switcher (Exact Homepage Component) */}
            <div className="pt-2 flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => setAnnual(false)}
                className={`text-sm font-semibold transition-colors cursor-pointer ${
                  !annual ? "text-foreground font-bold" : "text-muted-foreground"
                }`}
              >
                Monthly
              </button>

              <button
                type="button"
                onClick={() => setAnnual(!annual)}
                aria-label="Toggle annual billing"
                className={`relative h-7 w-12 rounded-full transition-colors cursor-pointer focus:outline-hidden ${
                  annual ? "bg-brand" : "bg-muted-foreground/30"
                }`}
              >
                <span
                  className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-md transition-all ${
                    annual ? "left-6" : "left-1"
                  }`}
                />
              </button>

              <button
                type="button"
                onClick={() => setAnnual(true)}
                className={`text-sm font-semibold transition-colors cursor-pointer flex items-center ${
                  annual ? "text-foreground font-bold" : "text-muted-foreground"
                }`}
              >
                Annual
                <span className="ml-2 rounded-full bg-violet-100 dark:bg-violet-950/60 px-2 py-0.5 text-xs font-bold text-violet-700 dark:text-violet-300">
                  Save 20%
                </span>
              </button>
            </div>
          </div>

          {/* Pricing Cards (Exact Homepage 3-Card Design & Copy with Smart Applet Interactivity) */}
          <div className="grid gap-8 md:grid-cols-3 items-stretch">
            {plans.map((p) => {
              const price = annual ? Math.round(p.monthly * 0.8) : p.monthly;
              const isCurrent = isLoggedIn && currentPlan === p.id;

              return (
                <div
                  key={p.name}
                  className={`glass-panel relative flex h-full flex-col rounded-3xl p-8 md:p-10 transition-all duration-300 ${
                    p.popular
                      ? "shadow-glow ring-2 ring-brand/30 border-violet-500/40"
                      : "shadow-soft"
                  }`}
                >
                  {p.popular && (
                    <span className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-brand to-brand-pink px-4 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-soft">
                      Most popular
                    </span>
                  )}

                  <h3 className="mb-2 text-2xl font-bold tracking-tight text-foreground">
                    {p.name}
                  </h3>
                  <p className="mb-6 text-sm text-muted-foreground">{p.tagline}</p>

                  <p className="mb-8 text-5xl font-extrabold tracking-tight text-foreground">
                    ${price}
                    <span className="text-base font-medium text-muted-foreground">
                      /mo{annual && price > 0 ? ", billed annually" : ""}
                    </span>
                  </p>

                  <ul className="mb-10 flex-1 space-y-3.5 text-foreground/90">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-center gap-3 text-sm font-medium">
                        <Check className="h-4 w-4 shrink-0 text-brand stroke-[2.5]" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    onClick={() => handlePlanAction(p.id)}
                    disabled={isCurrent}
                    className={`block w-full rounded-full py-3.5 text-center text-sm font-bold transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] cursor-pointer ${
                      isCurrent
                        ? "bg-muted text-muted-foreground cursor-default border border-border/80 shadow-none"
                        : p.popular
                          ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft hover:brightness-105"
                          : p.style
                    }`}
                  >
                    {isCurrent ? (
                      <span className="inline-flex items-center justify-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        Current Plan
                      </span>
                    ) : !isLoggedIn ? (
                      p.cta
                    ) : p.id === "free" ? (
                      "Switch to Free"
                    ) : (
                      `Upgrade to ${p.name}`
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Clean Creative Feature Badges */}
          <div className="pt-4 border-t border-border/60">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {creativePerks.map((perk) => {
                const Icon = perk.icon;
                return (
                  <div
                    key={perk.title}
                    className="rounded-2xl border border-border/70 bg-card/60 backdrop-blur-xs p-5 shadow-xs transition-all hover:border-border hover:shadow-soft"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand mb-3">
                      <Icon className="h-4.5 w-4.5" />
                    </div>
                    <h4 className="text-sm font-bold text-foreground mb-1">{perk.title}</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed">{perk.desc}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Simple Clean FAQ Accordion */}
          <div className="max-w-2xl mx-auto space-y-4 pt-2">
            <div className="text-center space-y-1 mb-6">
              <h3 className="text-2xl font-bold tracking-tight text-foreground">
                Common Questions
              </h3>
              <p className="text-xs text-muted-foreground">
                Everything you need to know about our plans.
              </p>
            </div>

            <div className="space-y-2.5">
              {faqs.map((faq, index) => {
                const isOpen = openFaq === index;
                return (
                  <div
                    key={faq.q}
                    className="rounded-2xl border border-border/70 bg-card/70 overflow-hidden transition-all shadow-xs"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : index)}
                      className="flex w-full items-center justify-between p-4.5 text-left font-bold text-xs sm:text-sm hover:bg-muted/30 transition-colors cursor-pointer"
                    >
                      <span className="text-foreground">{faq.q}</span>
                      {isOpen ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
                      )}
                    </button>
                    {isOpen && (
                      <div className="border-t border-border/60 p-4.5 pt-2.5 text-xs sm:text-sm text-muted-foreground leading-relaxed">
                        {faq.a}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Creative Minimalist Banner */}
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-brand via-purple-600 to-brand-pink p-8 sm:p-10 text-center text-white shadow-soft">
            <div className="relative z-10 max-w-xl mx-auto space-y-3">
              <h3 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                Start sharing your story today.
              </h3>
              <p className="text-xs sm:text-sm text-white/90 leading-relaxed">
                Join our vibrant creator network and unlock powerful audio, publishing, and
                community tools.
              </p>
              <div className="pt-2 flex justify-center">
                <button
                  type="button"
                  onClick={() => handlePlanAction("plus")}
                  className="rounded-full bg-white px-7 py-3 text-xs sm:text-sm font-bold text-violet-700 hover:bg-gray-100 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-soft cursor-pointer flex items-center gap-2"
                >
                  <span>Explore Plus Plan</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
