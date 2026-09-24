import { useEffect, useState } from "react";

import { PLAN_DETAILS, type BillingCycle, type PlanTier } from "@/lib/plans";
import { currentUser, setCurrentUser, subscribeProfiles } from "@/lib/profile-service";
import { supabase } from "@/integrations/supabase/client";
import { attachRemoteRecord, signedInProfileId } from "@/lib/remote-store";

interface PlanUsage {
  aiDraftsToday: number;
  day: string;
}

interface StoredPlanState {
  cycle: BillingCycle;
  usage: PlanUsage;
  paymentMethod?: { brand: string; last4: string; exp: string };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function read(): StoredPlanState {
  const fallback: StoredPlanState = {
    cycle: "monthly",
    usage: { aiDraftsToday: 0, day: today() },
  };
  // The real counter lives in the database per account; nothing is cached here.
  return fallback;
}

let state = read();
const listeners = new Set<() => void>();

const remote = attachRemoteRecord<StoredPlanState>({
  table: "subscriptions",
  fromRow: (row) => ({
    cycle: (row.billing_cycle ?? "monthly") as BillingCycle,
    usage: {
      aiDraftsToday: row.ai_usage_date === today() ? Number(row.ai_drafts_used ?? 0) : 0,
      day: today(),
    },
  }),
  toRow: (s) => ({
    billing_cycle: s.cycle,
    plan: (currentUser.plan as PlanTier) || "free",
    ai_drafts_used: s.usage.aiDraftsToday,
    ai_usage_date: s.usage.day,
  }),
  apply: (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  },
});

function commit(next: Partial<StoredPlanState>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
  remote.push(state);
}

/** Opens the global upgrade modal, optionally naming the locked feature. */
export function openUpgradeModal(featureHint?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("spaces:open-upgrade-modal", { detail: { featureHint } }));
}

export function usePlan() {
  const [, force] = useState(0);

  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    listeners.add(rerender);
    const unsubscribe = subscribeProfiles(rerender);
    return () => {
      listeners.delete(rerender);
      unsubscribe();
    };
  }, []);

  const currentPlan: PlanTier = (currentUser.plan as PlanTier) || "free";
  const planDetails = PLAN_DETAILS[currentPlan] ?? PLAN_DETAILS.free;

  async function upgradePlan(
    plan: PlanTier,
    cycle: BillingCycle = "monthly",
    paymentMethod?: { brand: string; last4: string; exp: string },
  ) {
    commit(paymentMethod ? { cycle, paymentMethod } : { cycle });
    setCurrentUser({ ...currentUser, plan });
    const userId = signedInProfileId();
    if (userId) {
      await supabase.from("profiles").update({ plan }).eq("id", userId);
      await (supabase as any).from("subscriptions").upsert({
        user_id: userId,
        plan,
        billing_cycle: cycle,
        status: "active",
        renews_at: new Date(Date.now() + (cycle === "annual" ? 365 : 30) * 86400000).toISOString(),
      });
    }
  }

  function recordAiDraftUsage() {
    const usage = state.usage.day === today() ? state.usage : { aiDraftsToday: 0, day: today() };
    commit({ usage: { day: usage.day, aiDraftsToday: usage.aiDraftsToday + 1 } });
  }

  async function updateBillingCycle(cycle: BillingCycle) {
    commit({ cycle });
    const userId = signedInProfileId();
    if (userId) {
      await (supabase as any)
        .from("subscriptions")
        .upsert({ user_id: userId, plan: currentPlan, billing_cycle: cycle, status: "active" });
    }
  }

  async function cancelSubscription() {
    setCurrentUser({ ...currentUser, plan: "free" });
    const userId = signedInProfileId();
    if (userId) {
      await supabase.from("profiles").update({ plan: "free" }).eq("id", userId);
      await (supabase as any)
        .from("subscriptions")
        .upsert({ user_id: userId, plan: "free", billing_cycle: state.cycle, status: "canceled" });
    }
  }

  return {
    currentPlan,
    planDetails,
    cycle: state.cycle,
    billingCycle: state.cycle,
    updateBillingCycle,
    cancelSubscription,
    isUltra: currentPlan === "pro",
    usage: state.usage,
    paymentMethod: state.paymentMethod ?? null,
    isPlus: currentPlan === "plus" || currentPlan === "pro",
    isPro: currentPlan === "pro",
    upgradePlan,
    recordAiDraftUsage,
    openUpgradeModal,
  };
}
