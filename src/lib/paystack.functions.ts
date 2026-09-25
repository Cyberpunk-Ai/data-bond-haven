import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { quoteTip, minorToMajor, type ChargedTip } from "@/lib/money";

type PlanTier = "plus" | "pro";
type BillingCycle = "monthly" | "annual";

/**
 * NOTE: `*.functions.ts` and route files are reachable from the client bundle,
 * so every server-only module (`env.server`, `client.server`) is imported
 * lazily *inside* a handler — never at module top level. `@/lib/money` is pure
 * and safe to import statically.
 */

async function paystackConfig() {
  const { env } = await import("@/lib/env.server");
  return env().paystack;
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

/**
 * Prices come from the single source of truth (`plan_limits`) so the pricing
 * page and checkout can never disagree. USD is what we advertise; the merchant
 * account settles in PAYSTACK_CURRENCY, so we charge the local equivalent.
 */
async function planUsdPrice(plan: PlanTier, cycle: BillingCycle): Promise<number> {
  const { data, error } = await (
    await admin()
  )
    .from("plan_limits")
    .select("price_usd_monthly, price_usd_annual")
    .eq("plan", plan)
    .maybeSingle();
  if (error || !data) {
    throw new Error("This plan is unavailable right now. Please try again shortly.");
  }
  const usd = Number(cycle === "annual" ? data.price_usd_annual : data.price_usd_monthly);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("That plan price is not configured.");
  return usd;
}

async function paystack(path: string, init?: RequestInit) {
  const key = (await paystackConfig()).secretKey;
  if (!key) throw new Error("Payments are not configured yet.");
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body?.status === false) {
    throw new Error(body?.message || `Payment provider error (${res.status})`);
  }
  return body;
}

async function profileIdFor(supabase: any, userId: string): Promise<string> {
  const { data } = await supabase
    .from("profiles")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (!data?.id) throw new Error("Complete your profile first.");
  return String(data.id);
}

/** Turn a USD amount into the settlement-currency charge we send to Paystack. */
function chargeFromUsd(usd: number, usdRate: number): ChargedTip {
  return quoteTip({ usd, rate: usdRate });
}

export const startPaystackCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { plan: PlanTier; cycle: BillingCycle; origin: string }) => {
    if (input.plan !== "plus" && input.plan !== "pro") throw new Error("Unknown plan");
    if (input.cycle !== "monthly" && input.cycle !== "annual") throw new Error("Unknown cycle");
    if (!/^https?:\/\//.test(input.origin)) throw new Error("Invalid origin");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId, claims } = context as any;
    const profileId = await profileIdFor(supabase, userId);

    const { currency, usdRate } = await paystackConfig();
    const email = claims?.email ?? `${profileId}@users.noreply.app`;
    const usd = await planUsdPrice(data.plan, data.cycle);
    const charge = chargeFromUsd(usd, usdRate);

    const reference = `sub_${crypto.randomUUID().replace(/-/g, "")}`;

    const init = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: charge.minorSettlement,
        currency,
        reference,
        callback_url: `${data.origin}/billing/callback`,
        metadata: {
          kind: "plan",
          profile_id: profileId,
          plan: data.plan,
          billing_cycle: data.cycle,
        },
      }),
    });
    const authUrl = init.data?.authorization_url as string | undefined;
    if (!authUrl) throw new Error("We couldn't open a secure checkout. Please try again.");

    // Record what we intend to charge, authoritatively, so settlement compares
    // the provider's amount against a stored expectation — not client metadata.
    const { error: insertErr } = await (await admin()).from("payments").insert({
      user_id: profileId,
      reference,
      kind: "plan",
      plan: data.plan,
      billing_cycle: data.cycle,
      amount: charge.majorSettlement,
      amount_minor: charge.minorSettlement,
      expected_amount_minor: charge.minorSettlement,
      currency,
      exchange_rate: usdRate,
      quoted_amount_usd: usd,
      email,
      status: "pending",
      authorization_url: authUrl,
    });
    if (insertErr) {
      console.error("Could not record pending payment:", insertErr);
      throw new Error("We couldn't start that checkout. Please try again.");
    }

    return { authorizationUrl: authUrl, reference };
  });

/**
 * Starts a real, paid tip. The tip is only recorded for the creator once
 * Paystack confirms the charge (callback or webhook), via the shared
 * `settle_paystack_transaction` function.
 */
export const startTipCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      recipientUsername: string;
      amount: number;
      message?: string;
      postId?: string | null;
      origin: string;
    }) => {
      const amount = Number(input.amount);
      // Providers only require a small floor (Paystack clears sub-dollar charges in
      // most settlement currencies), so we allow tips from $0.10 upward.
      if (!Number.isFinite(amount) || amount < 0.1 || amount > 1000) {
        throw new Error("Tip amount must be between $0.10 and $1000.");
      }
      if (!input.recipientUsername) throw new Error("Pick someone to tip.");
      if (!/^https?:\/\//.test(input.origin)) throw new Error("Invalid origin");
      return { ...input, amount: Math.round(amount * 100) / 100 };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId, claims } = context as any;
    const profileId = await profileIdFor(supabase, userId);

    const cleanUsername = data.recipientUsername.replace(/^@/, "");
    const { data: recipient } = await supabase
      .from("profiles")
      .select("id, username")
      .eq("username", cleanUsername)
      .maybeSingle();
    if (!recipient?.id) throw new Error("We couldn't find that creator.");
    const recipientId = String(recipient.id);
    if (recipientId === profileId) throw new Error("You can't tip yourself.");

    const { currency, usdRate } = await paystackConfig();
    const email = claims?.email ?? `${profileId}@users.noreply.app`;
    const charge = chargeFromUsd(data.amount, usdRate);
    const reference = `tip_${crypto.randomUUID().replace(/-/g, "")}`;

    const init = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: charge.minorSettlement,
        currency,
        reference,
        callback_url: `${data.origin}/billing/callback`,
        metadata: { kind: "tip", profile_id: profileId, recipient_id: recipientId },
      }),
    });
    const authUrl = init.data?.authorization_url as string | undefined;
    if (!authUrl) throw new Error("We couldn't open a secure checkout. Please try again.");

    const { error: insertErr } = await (await admin()).from("payments").insert({
      user_id: profileId,
      reference,
      kind: "tip",
      plan: "tip",
      billing_cycle: "one_time",
      amount: charge.majorSettlement,
      amount_minor: charge.minorSettlement,
      expected_amount_minor: charge.minorSettlement,
      currency,
      exchange_rate: usdRate,
      quoted_amount_usd: data.amount,
      recipient_id: recipientId,
      tip_message: (data.message ?? "").slice(0, 240),
      tip_post_id: data.postId ?? null,
      email,
      status: "pending",
      authorization_url: authUrl,
    });
    if (insertErr) {
      console.error("Could not record pending tip:", insertErr);
      throw new Error("We couldn't start that tip. Please try again.");
    }

    return { authorizationUrl: authUrl, reference };
  });

/**
 * Confirms a Paystack reference and settles it. Delegates all state changes to
 * the single `settle_paystack_transaction` database function so the webhook and
 * this interactive path can never diverge. Safe to call repeatedly.
 */
export const confirmPaystackPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { reference: string }) => {
    if (!input.reference || input.reference.length > 128) throw new Error("Invalid reference");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const profileId = await profileIdFor(supabase, userId);

    // Confirm with the provider before settling anything. Never grant value we
    // could not verify.
    let verified: any;
    try {
      verified = await paystack(`/transaction/verify/${encodeURIComponent(data.reference)}`);
    } catch (verifyErr) {
      console.error("Paystack verify failed:", verifyErr);
      throw new Error(
        "We couldn't confirm that payment with the payment provider. Nothing was charged to your plan — please try again.",
      );
    }
    const tx = verified.data ?? {};

    if (tx.metadata?.profile_id && String(tx.metadata.profile_id) !== profileId) {
      throw new Error("This payment belongs to another account.");
    }

    const { data: result, error } = await (
      await admin()
    ).rpc("settle_paystack_transaction", {
      _reference: data.reference,
      _tx: tx,
    });
    if (error) {
      console.error("Settlement failed:", error);
      throw new Error("We couldn't finish confirming that payment. Please try again.");
    }

    const settled = (result ?? {}) as {
      status: string;
      kind?: string;
      plan?: PlanTier;
      cycle?: BillingCycle;
      amount?: number;
      provider_status?: string;
    };

    if (settled.status === "amount_mismatch" || settled.status === "currency_mismatch") {
      throw new Error("The payment amount didn't match what we expected. Nothing was credited.");
    }
    if (settled.status === "unknown_reference") {
      throw new Error("We couldn't find that payment.");
    }
    if (settled.status === "not_success") {
      return {
        status: settled.provider_status ?? "pending",
        kind: (settled.kind ?? (data.reference.startsWith("tip_") ? "tip" : "plan")) as
          "tip" | "plan",
        plan: settled.plan ?? "plus",
        cycle: settled.cycle ?? "monthly",
      };
    }

    const isTip = settled.kind === "tip" || data.reference.startsWith("tip_");
    if (isTip) {
      return {
        status: "success" as const,
        kind: "tip" as const,
        plan: (settled.plan ?? "plus") as PlanTier,
        cycle: (settled.cycle ?? "monthly") as BillingCycle,
        amount: Number(settled.amount ?? 0),
      };
    }
    return {
      status: "success" as const,
      kind: "plan" as const,
      plan: (settled.plan ?? "plus") as PlanTier,
      cycle: (settled.cycle ?? "monthly") as BillingCycle,
    };
  });

export const listMyPayments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context as any;
    const { data } = await supabase
      .from("payments")
      .select(
        "id, reference, kind, plan, billing_cycle, amount, amount_minor, currency, status, quoted_amount_usd, paid_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(25);
    return (data ?? []).map((p: any) => ({
      ...p,
      majorAmount:
        p.amount_minor != null ? minorToMajor(Number(p.amount_minor)) : Number(p.amount ?? 0),
    }));
  });
