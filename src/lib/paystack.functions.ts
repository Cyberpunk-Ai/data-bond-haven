import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type PlanTier = "plus" | "pro";
type BillingCycle = "monthly" | "annual";

/**
 * Prices are advertised in USD but the merchant account settles in KES, so we
 * charge the KES equivalent. Values are whole shillings; the handler converts
 * them to the smallest unit (cents) that Paystack expects.
 */
const PRICES: Record<PlanTier, Record<BillingCycle, number>> = {
  plus: { monthly: 1170, annual: 10920 },
  pro: { monthly: 3770, annual: 35880 },
};

/** USD is what we advertise; the merchant account settles in KES. */
const USD_TO_KES = Number(process.env["PAYSTACK_USD_RATE"] ?? 130);

function money(plan: PlanTier, cycle: BillingCycle) {
  return PRICES[plan][cycle];
}

function paystackKey() {
  const key = process.env["PAYSTACK_SECRET_KEY"];
  if (!key) throw new Error("Payments are not configured yet.");
  return key;
}

async function paystack(path: string, init?: RequestInit) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${paystackKey()}`,
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

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!profile) throw new Error("Complete your profile before upgrading.");

    const email = claims?.email ?? `${profile.id}@users.noreply.app`;
    const currency = process.env["PAYSTACK_CURRENCY"] || "KES";
    const amount = money(data.plan, data.cycle) * 100;
    const reference = `sub_${crypto.randomUUID().replace(/-/g, "")}`;

    const init = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount,
        currency,
        reference,
        callback_url: `${data.origin}/billing/callback`,
        metadata: {
          profile_id: profile.id,
          plan: data.plan,
          billing_cycle: data.cycle,
        },
      }),
    });

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("payments").insert({
      user_id: profile.id,
      reference,
      plan: data.plan,
      billing_cycle: data.cycle,
      amount,
      currency,
      email,
      status: "pending",
      authorization_url: init.data?.authorization_url ?? null,
    });

    return {
      authorizationUrl: init.data?.authorization_url as string,
      reference,
    };
  });

/**
 * Starts a real, paid tip. The tip is only recorded for the creator once
 * Paystack confirms the charge (callback or webhook).
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
      if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
        throw new Error("Tip amount must be between $1 and $1000.");
      }
      if (!input.recipientUsername) throw new Error("Pick someone to tip.");
      if (!/^https?:\/\//.test(input.origin)) throw new Error("Invalid origin");
      return { ...input, amount: Math.round(amount * 100) / 100 };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId, claims } = context as any;

    const { data: me } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!me?.id) throw new Error("Complete your profile before sending a tip.");
    const myProfileId = String(me.id);

    const cleanUsername = data.recipientUsername.replace(/^@/, "");
    const { data: recipient } = await supabase
      .from("profiles")
      .select("id, username")
      .eq("username", cleanUsername)
      .maybeSingle();
    if (!recipient?.id) throw new Error("We couldn't find that creator.");
    const recipientId = String(recipient.id);

    if (recipientId === myProfileId) throw new Error("You can't tip yourself.");

    const email = claims?.email ?? `${myProfileId}@users.noreply.app`;
    const currency = process.env["PAYSTACK_CURRENCY"] || "KES";
    const amount = Math.round(data.amount * USD_TO_KES) * 100;
    const reference = `tip_${crypto.randomUUID().replace(/-/g, "")}`;

    const init = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount,
        currency,
        reference,
        callback_url: `${data.origin}/billing/callback`,
        metadata: {
          kind: "tip",
          profile_id: myProfileId,
          recipient_id: recipientId,
          recipient_username: cleanUsername,
          tip_usd: data.amount,
          note: (data.message ?? "").slice(0, 240),
          post_id: data.postId ?? null,
        },
      }),
    });
    const authUrl = init.data?.authorization_url as string | undefined;
    if (!authUrl) throw new Error("We couldn't open a secure checkout. Please try again.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("payments").insert({
      user_id: myProfileId,
      reference,
      plan: "tip",
      billing_cycle: "one_time",
      amount,
      currency,
      email,
      status: "pending",
      authorization_url: authUrl,
      raw: { recipient_username: cleanUsername, recipient_id: recipientId, tip_usd: data.amount },
    });

    return {
      authorizationUrl: authUrl,
      reference,
    };
  });

/** Confirms a Paystack reference and activates the plan. Safe to call twice. */
export const confirmPaystackPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { reference: string }) => {
    if (!input.reference || input.reference.length > 128) throw new Error("Invalid reference");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!profile?.id) throw new Error("Sign in to confirm this payment.");
    const profileId = String(profile.id);

    let tx: any = {};
    let meta: any = {};
    let success = true;

    try {
      const verified = await paystack(`/transaction/verify/${encodeURIComponent(data.reference)}`);
      tx = verified.data ?? {};
      meta = tx.metadata ?? {};
      success = tx.status === "success";
    } catch (verifyErr) {
      // Never grant a plan or record a tip we could not verify with Paystack.
      console.error("Paystack verify failed:", verifyErr);
      throw new Error(
        "We couldn't confirm that payment with the payment provider. Nothing was charged to your plan — please try again.",
      );
    }

    if (meta.profile_id && String(meta.profile_id) !== profileId) {
      throw new Error("This payment belongs to another account.");
    }

    const isTip = meta.kind === "tip" || data.reference.startsWith("tip_");
    const plan = (meta.plan as PlanTier) ?? "plus";
    const cycle = (meta.billing_cycle as BillingCycle) ?? "annual";

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;

    // The webhook may already have settled this reference; don't record it twice.
    const { data: existing } = await admin
      .from("payments")
      .select("status")
      .eq("reference", data.reference)
      .maybeSingle();
    const alreadySettled = existing?.status === "success";

    await admin
      .from("payments")
      .update({
        status: success ? "success" : (tx.status ?? "failed"),
        raw: tx,
        // Never erase a previously recorded settlement timestamp.
        ...(success ? { paid_at: tx.paid_at ?? new Date().toISOString() } : {}),
      })
      .eq("reference", data.reference);

    if (!success) {
      return { status: tx.status ?? "failed", kind: isTip ? "tip" : "plan", plan, cycle };
    }

    if (isTip) {
      if (!alreadySettled && meta.recipient_id) {
        // The `t_tips_after` trigger emits the 'tip' notification, so we only
        // record the tip row here and must not insert a second notification.
        const { error: tipErr } = await admin.from("tips").insert({
          from_user_id: profileId,
          to_user_id: meta.recipient_id,
          amount: meta.tip_usd,
          message: meta.note ?? "",
          post_id: meta.post_id ?? null,
        });
        if (tipErr) console.error("Tip recording failed:", tipErr);
      }

      return {
        status: "success" as const,
        kind: "tip" as const,
        plan,
        cycle,
        recipient: meta.recipient_username as string,
        amount: Number(meta.tip_usd ?? 0),
      };
    }

    const { error: planErr } = await admin.from("profiles").update({ plan }).eq("id", profileId);
    const { error: subErr } = await admin.from("subscriptions").upsert(
      {
        user_id: profileId,
        plan,
        billing_cycle: cycle,
        status: "active",
        provider: "paystack",
        provider_customer_id: tx.customer?.customer_code ?? null,
        renews_at: new Date(Date.now() + (cycle === "annual" ? 365 : 30) * 86400000).toISOString(),
        payment_method: tx.authorization
          ? {
              brand: tx.authorization.card_type ?? tx.authorization.channel ?? "card",
              last4: tx.authorization.last4 ?? "",
              exp: `${tx.authorization.exp_month ?? ""}/${tx.authorization.exp_year ?? ""}`,
            }
          : {},
      },
      { onConflict: "user_id" },
    );
    if (planErr || subErr) {
      console.error("Plan activation failed:", planErr ?? subErr);
      throw new Error(
        "Your payment went through but we couldn't activate the plan. Please contact support — nothing else was charged.",
      );
    }

    return { status: "success" as const, kind: "plan" as const, plan, cycle };
  });

export const listMyPayments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context as any;
    const { data } = await supabase
      .from("payments")
      .select("id, reference, plan, billing_cycle, amount, currency, status, paid_at, created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    return data ?? [];
  });
