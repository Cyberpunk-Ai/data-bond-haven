import React, { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { X, Sparkles, Crown, Check, CreditCard, Zap, ShieldCheck, ArrowRight } from "lucide-react";
import { type PlanTier, type BillingCycle, PLAN_DETAILS } from "@/lib/plans";
import { usePlan } from "@/lib/plan-state";
import { useAuth } from "@/lib/auth-state";
import { startPaystackCheckout } from "@/lib/paystack.functions";
import { openPaystackPayment } from "@/lib/paystack-checkout";
import { cn } from "@/lib/utils";

export function UpgradeModal() {
  const { currentPlan, cycle: defaultCycle, upgradePlan } = usePlan();
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [featureHint, setFeatureHint] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<"plus" | "pro">("plus");
  const [cycle, setCycle] = useState<BillingCycle>("annual");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const startCheckout = useServerFn(startPaystackCheckout);

  useEffect(() => {
    const handleOpen = (e: any) => {
      const hint = e.detail?.featureHint || null;
      setFeatureHint(hint);
      if (
        hint?.toLowerCase().includes("pro") ||
        hint?.toLowerCase().includes("team") ||
        hint?.toLowerCase().includes("api")
      ) {
        setSelectedPlan("pro");
      } else {
        setSelectedPlan("plus");
      }
      setIsSuccess(false);
      setIsOpen(true);
    };

    window.addEventListener("spaces:open-upgrade-modal", handleOpen);
    return () => {
      window.removeEventListener("spaces:open-upgrade-modal", handleOpen);
    };
  }, []);

  if (!isOpen) return null;

  const targetPlanDetails = PLAN_DETAILS[selectedPlan];
  const basePrice =
    cycle === "annual" ? targetPlanDetails.priceAnnual : targetPlanDetails.priceMonthly;
  const rawTotal =
    cycle === "annual" ? targetPlanDetails.annualBilledTotal : targetPlanDetails.priceMonthly;
  const finalTotal = rawTotal.toFixed(2);

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    setCheckoutError(null);
    setIsProcessing(true);
    try {
      const res = (await startCheckout({
        data: { plan: selectedPlan, cycle, origin: window.location.origin },
      })) as { authorizationUrl?: string; reference?: string };

      if (!res?.authorizationUrl || !res.reference) {
        throw new Error("We couldn't open a secure checkout. Please try again.");
      }

      // The plan is activated only after the provider confirms the payment.
      openPaystackPayment({
        authorizationUrl: res.authorizationUrl,
        reference: res.reference,
        onCancel: () => setIsProcessing(false),
      });
    } catch (err) {
      setIsProcessing(false);
      setCheckoutError(
        err instanceof Error ? err.message : "We couldn't start checkout. Please try again.",
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-3 sm:p-4 animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-3xl border border-white/10 bg-background shadow-2xl transition-all duration-300 [scrollbar-width:thin]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Glowing Top Gradient Bar */}
        <div
          className={cn(
            "h-2 w-full bg-gradient-to-r transition-all duration-500",
            selectedPlan === "pro"
              ? "from-amber-400 via-orange-500 to-amber-500"
              : "from-brand via-brand-pink to-purple-600",
          )}
        />

        <button
          onClick={() => setIsOpen(false)}
          className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-foreground/10 text-muted-foreground hover:bg-foreground/15 hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        {isSuccess ? (
          <div className="flex flex-col items-center justify-center p-12 text-center">
            <div
              className={cn(
                "flex h-20 w-20 items-center justify-center rounded-full shadow-glow animate-bounce",
                selectedPlan === "pro"
                  ? "bg-gradient-to-tr from-amber-500 to-orange-400 text-white"
                  : "bg-gradient-to-tr from-brand to-brand-pink text-white",
              )}
            >
              {selectedPlan === "pro" ? (
                <Crown className="h-10 w-10" />
              ) : (
                <Sparkles className="h-10 w-10" />
              )}
            </div>
            <h3 className="mt-6 text-2xl font-black">
              Welcome to Spaces1 {targetPlanDetails.name}!
            </h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-md">
              Your account has been upgraded. The {targetPlanDetails.badge} badge and full plan
              capabilities are now active immediately across the platform.
            </p>
            <div className="mt-6 flex items-center gap-2 rounded-full bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-500">
              <Check className="h-4 w-4" /> Subscription Active & Verified
            </div>
          </div>
        ) : (
          <div className="max-h-[90vh] overflow-y-auto p-6 md:p-8">
            {/* Header */}
            <div className="text-center">
              {featureHint ? (
                <div className="inline-flex items-center gap-2 rounded-full bg-brand/10 px-3.5 py-1 text-xs font-bold text-violet-700 dark:text-violet-300 mb-3 border border-brand/20">
                  <Zap className="h-3.5 w-3.5 text-brand" /> {featureHint}
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-brand/15 to-brand-pink/15 px-3.5 py-1 text-xs font-bold text-violet-700 dark:text-violet-300 mb-3">
                  <Sparkles className="h-3.5 w-3.5 text-brand" /> Unlock Clean Creator Power
                </div>
              )}
              <h2 className="text-2xl md:text-3xl font-black tracking-tight">
                Upgrade your Spaces Experience
              </h2>
              <p className="mt-1 text-xs md:text-sm text-muted-foreground">
                Unlock authenticity badges, high-capacity Spaces, and monetization.
              </p>
            </div>

            {/* Plan Selector Switcher */}
            <div className="mt-6 grid grid-cols-2 gap-3 p-1.5 rounded-2xl bg-foreground/5 border border-border/50">
              <button
                type="button"
                onClick={() => setSelectedPlan("plus")}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition-all",
                  selectedPlan === "plus"
                    ? "bg-background text-foreground shadow-md ring-1 ring-brand/30"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Sparkles className="h-4 w-4 text-brand" />
                <span>Plus Plan</span>
                <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[0.65rem] font-extrabold text-brand">
                  $7/mo
                </span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedPlan("pro")}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition-all",
                  selectedPlan === "pro"
                    ? "bg-background text-amber-500 shadow-md ring-1 ring-amber-500/40"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Crown className="h-4 w-4 text-amber-500" />
                <span>Pro Plan</span>
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.65rem] font-black text-amber-500">
                  $23/mo
                </span>
              </button>
            </div>

            {/* Billing Interval Toggle */}
            <div className="mt-4 flex items-center justify-center gap-3">
              <span
                className={cn(
                  "text-xs font-semibold",
                  cycle === "monthly" ? "text-foreground" : "text-muted-foreground",
                )}
              >
                Monthly
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={cycle === "annual"}
                onClick={() => setCycle(cycle === "annual" ? "monthly" : "annual")}
                className="relative h-6 w-12 rounded-full bg-foreground/15 p-0.5 transition-colors focus:outline-none"
              >
                <span
                  className={cn(
                    "block h-5 w-5 rounded-full bg-gradient-to-r from-brand to-brand-pink shadow transition-transform",
                    cycle === "annual" ? "translate-x-6" : "translate-x-0",
                  )}
                />
              </button>
              <span
                className={cn(
                  "text-xs font-semibold flex items-center gap-1.5",
                  cycle === "annual" ? "text-foreground font-bold" : "text-muted-foreground",
                )}
              >
                <span>Annual Billing</span>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.65rem] font-extrabold text-emerald-500 border border-emerald-500/20">
                  Save 20%
                </span>
              </span>
            </div>

            {/* Perks List */}
            <div className="mt-6 rounded-2xl border border-border/60 bg-foreground/[0.02] p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Included in {targetPlanDetails.name}
                </span>
                <span
                  className={cn(
                    "text-xs font-extrabold px-2 py-0.5 rounded-full",
                    targetPlanDetails.badgeColor,
                  )}
                >
                  {targetPlanDetails.badge}
                </span>
              </div>
              <ul className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                {targetPlanDetails.keyPerks.map((perk, i) => (
                  <li key={i} className="flex items-start gap-2 text-foreground/90 font-medium">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-500">
                      <Check className="h-2.5 w-2.5 stroke-[3]" />
                    </span>
                    <span>{perk}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Checkout Form */}
            <form onSubmit={handleCheckout} className="mt-6 space-y-4">
              {/* Secure payment notice */}
              <div className="rounded-2xl border border-border/60 p-3.5 space-y-2 bg-background">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5 font-semibold text-foreground">
                    <CreditCard className="h-4 w-4 text-brand" /> Secure checkout
                  </span>
                  <span className="flex items-center gap-1 text-[0.7rem]">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Powered by Paystack
                  </span>
                </div>
                <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
                  You'll be taken to Paystack's secure page to pay by card, bank transfer or mobile
                  money. Your card details never touch this app, and your plan activates the moment
                  the payment clears. Prices are shown in US dollars and charged as the equivalent
                  amount in Kenyan Shillings.
                </p>
              </div>
              {checkoutError && <p className="text-[0.7rem] text-rose-500">{checkoutError}</p>}

              {/* Price & Summary */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t border-border/50 pt-4">
                <div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-black">${finalTotal}</span>
                    <span className="text-xs text-muted-foreground">
                      /{cycle === "annual" ? "year" : "month"}
                    </span>
                  </div>
                  <p className="text-[0.68rem] text-muted-foreground">
                    {cycle === "annual"
                      ? `Equivalent to $${basePrice}/month. Billed annually.`
                      : "Billed monthly, cancel anytime."}
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={isProcessing}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-2xl px-6 py-3.5 text-sm font-extrabold text-white shadow-soft transition-all duration-300 hover:shadow-glow hover:brightness-105 active:scale-[0.98] disabled:opacity-50 cursor-pointer w-full sm:w-auto",
                    selectedPlan === "pro"
                      ? "bg-gradient-to-r from-amber-500 to-orange-500"
                      : "bg-gradient-to-r from-brand to-brand-pink",
                  )}
                >
                  {isProcessing ? (
                    <span>Activating Plan...</span>
                  ) : (
                    <>
                      <span>Upgrade to {targetPlanDetails.name}</span>
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
