/**
 * Real creator earnings and withdrawals.
 *
 * For safety this app never asks for, sends or stores bank, mobile-money or
 * card details. A withdrawal is simply a request: the creator confirms an
 * amount within their available balance and staff review and pay it out,
 * recording the outcome here.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Server-only modules are imported lazily inside handlers: this file is
// reachable from the client bundle, so top-level `.server.ts` imports are not
// allowed. `@/lib/money`-style pure modules may be imported statically.
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

/** Smallest withdrawal we accept, in the settlement (payout) currency. */
export const MINIMUM_PAYOUT = 10;

async function payoutCurrency() {
  const { env } = await import("@/lib/env.server");
  return env().paystack.currency;
}

async function myProfileId(supabase: any, userId: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (!data?.id) throw new Error("Complete your profile first.");
  return String(data.id);
}

/**
 * The authoritative balance, summed in the database with no row limit — this
 * replaces the old `computeLedger` that `.limit(100)`-ed tips and could show an
 * inflated available balance (permitting withdrawal of money never earned).
 */
async function earningsSnapshot(supabase: any, profileId: string) {
  const { data, error } = await supabase.rpc("earnings_snapshot", { _profile: profileId });
  if (error) {
    console.error("earnings_snapshot failed:", error);
    throw new Error("We couldn't load your earnings right now. Please try again.");
  }
  const row = (Array.isArray(data) ? data[0] : data) ?? {};
  return {
    totalEarnings: Number(row.gross_amount ?? 0),
    fees: Number(row.fees_amount ?? 0),
    net: Number(row.net_amount ?? 0),
    withdrawn: Number(row.withdrawn_amount ?? 0),
    pendingBalance: Number(row.available_amount ?? 0),
    currency: String(row.currency ?? (await payoutCurrency())),
  };
}

/** Everything the monetization screen needs, straight from the database. */
export const getEarnings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    const profileId = await myProfileId(supabase, userId);
    // Balance is an untruncated database aggregate; the lists below are only
    // the recent activity for display (a bounded scan is fine there).
    const [snapshot, tipsRes, payoutsRes, settingsRes] = await Promise.all([
      earningsSnapshot(supabase, profileId),
      supabase
        .from("tips")
        .select("id, from_user_id, amount, message, created_at, post_id")
        .eq("to_user_id", profileId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("payouts")
        .select("id, amount, status, reference, failure_reason, created_at")
        .eq("user_id", profileId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("monetization_settings")
        .select("min_tip, tips_enabled, subscriptions_enabled")
        .eq("user_id", profileId)
        .maybeSingle(),
    ]);

    const tipRows = (tipsRes.data ?? []) as any[];
    const payoutRows = (payoutsRes.data ?? []) as any[];

    const senderIds = Array.from(new Set(tipRows.map((t) => String(t.from_user_id))));
    let senders: Record<string, any> = {};
    if (senderIds.length) {
      const { data } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", senderIds);
      senders = Object.fromEntries(((data ?? []) as any[]).map((p) => [String(p.id), p]));
    }

    const settingsRow = settingsRes.data;

    return {
      totalEarnings: snapshot.totalEarnings,
      pendingBalance: snapshot.pendingBalance,
      currency: snapshot.currency,
      minimumPayout: MINIMUM_PAYOUT,
      tips: tipRows.map((t) => {
        const sender = senders[String(t.from_user_id)];
        return {
          id: String(t.id),
          amount: Number(t.amount ?? 0),
          message: t.message || "",
          createdAt: t.created_at,
          senderName: sender?.display_name ?? "Supporter",
          senderUsername: sender?.username ?? "supporter",
          senderAvatar: sender?.avatar_url ?? undefined,
        };
      }),
      payouts: payoutRows.map((p) => ({
        id: String(p.id),
        amount: Number(p.amount ?? 0),
        status: String(p.status ?? "pending"),
        reference: p.reference ?? null,
        failureReason: p.failure_reason ?? null,
        createdAt: p.created_at,
      })),
      settings: {
        minimumTip: Number(settingsRow?.min_tip ?? 1),
        tipsEnabled: settingsRow?.tips_enabled ?? true,
        subscriptionsEnabled: settingsRow?.subscriptions_enabled ?? false,
      },
    };
  });

/** Saves the creator's own tip settings. */
export const saveTipSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { minimumTip: number; tipsEnabled: boolean }) => {
    const minimumTip = Number(input.minimumTip);
    if (!Number.isFinite(minimumTip) || minimumTip < 0.5 || minimumTip > 1000) {
      throw new Error("Choose a minimum tip between 0.5 and 1000.");
    }
    return { minimumTip: Math.round(minimumTip * 100) / 100, tipsEnabled: !!input.tipsEnabled };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const profileId = await myProfileId(supabase, userId);

    const { error } = await supabase.from("monetization_settings").upsert(
      {
        user_id: profileId,
        min_tip: data.minimumTip,
        tips_enabled: data.tipsEnabled,
      },
      { onConflict: "user_id" },
    );
    if (error) {
      console.error("Could not save tip settings:", error);
      throw new Error("We couldn't save those tip settings. Please try again.");
    }
    return data;
  });

/**
 * Records a withdrawal request for staff review. No account details are asked
 * for or stored — payment is arranged outside the app.
 */
export const requestPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { amount?: number; note?: string }) => ({
    amount: input?.amount != null ? Number(input.amount) : undefined,
    note: (input?.note ?? "").slice(0, 280),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const profileId = await myProfileId(supabase, userId);

    // Withdrawals are a monetization feature — enforce it server-side, not in
    // the UI (plan §5).
    const { requirePlanCapability, UpgradeRequiredError } = await import("@/lib/plan-guard.server");
    try {
      await requirePlanCapability(profileId, "monetization");
    } catch (err) {
      if (err instanceof UpgradeRequiredError) {
        throw new Error("Upgrade to a paid plan to withdraw your earnings.");
      }
      throw err;
    }

    const snapshot = await earningsSnapshot(supabase, profileId);
    const amount = Math.round((data.amount ?? snapshot.pendingBalance) * 100) / 100;
    if (!(amount > 0)) throw new Error("You don't have anything to withdraw yet.");
    if (amount > snapshot.pendingBalance) {
      throw new Error("That's more than your available balance.");
    }
    if (amount < MINIMUM_PAYOUT) {
      throw new Error(`The smallest withdrawal is ${snapshot.currency} ${MINIMUM_PAYOUT}.`);
    }

    const reference = `po_${crypto.randomUUID().replace(/-/g, "")}`;
    const { error } = await (await admin()).from("payouts").insert({
      user_id: profileId,
      amount,
      amount_minor: Math.round(amount * 100),
      method: "review",
      status: "pending",
      currency: snapshot.currency,
      reference,
      failure_reason: null,
      destination: data.note ? data.note : null,
    });
    // The partial unique index `payouts_one_open_per_user` makes a second open
    // withdrawal impossible even under a concurrent double-click race.
    if (error && (error as any).code === "23505") {
      throw new Error("You already have a withdrawal waiting for review.");
    }
    if (error) {
      console.error("Could not record payout request:", error);
      throw new Error("We couldn't start that withdrawal. Please try again.");
    }

    return { reference, amount, status: "pending" as const };
  });

/** Staff: every withdrawal request, newest first. */
export const listPayoutRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertStaff } = await import("./staff.server");
    const staff = await assertStaff(context);

    const { data } = await staff.admin
      .from("payouts")
      .select(
        "id, user_id, amount, currency, status, reference, failure_reason, destination, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);

    const rows = (data ?? []) as any[];
    const ids = Array.from(new Set(rows.map((r) => String(r.user_id))));
    let people: Record<string, any> = {};
    if (ids.length) {
      const { data: profiles } = await staff.admin
        .from("profiles")
        .select("id, username, display_name")
        .in("id", ids);
      people = Object.fromEntries(((profiles ?? []) as any[]).map((p) => [String(p.id), p]));
    }

    return rows.map((r) => ({
      id: String(r.id),
      amount: Number(r.amount ?? 0),
      currency: String(r.currency ?? "KES"),
      status: String(r.status ?? "pending"),
      reference: r.reference ?? null,
      note: r.destination ?? null,
      failureReason: r.failure_reason ?? null,
      createdAt: r.created_at,
      creatorName: people[String(r.user_id)]?.display_name ?? "Creator",
      creatorUsername: people[String(r.user_id)]?.username ?? "creator",
    }));
  });

/** Staff: mark a withdrawal paid or declined. Always audit-logged. */
export const reviewPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; decision: "paid" | "declined"; note?: string }) => {
    if (!input?.id) throw new Error("Missing withdrawal");
    if (input.decision !== "paid" && input.decision !== "declined") {
      throw new Error("Choose paid or declined.");
    }
    return { id: input.id, decision: input.decision, note: (input.note ?? "").slice(0, 280) };
  })
  .handler(async ({ data, context }) => {
    const { assertStaff, writeAudit } = await import("./staff.server");
    const staff = await assertStaff(context);

    const { data: row } = await staff.admin
      .from("payouts")
      .select("id, user_id, amount, currency, status")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("That withdrawal no longer exists.");
    if (row.status === "paid" || row.status === "declined") {
      throw new Error("That withdrawal was already reviewed.");
    }

    const { error } = await staff.admin
      .from("payouts")
      .update({
        status: data.decision,
        failure_reason: data.decision === "declined" ? data.note || "Declined by staff" : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error("We couldn't update that withdrawal. Please try again.");

    await staff.admin.from("notifications").insert({
      recipient_id: row.user_id,
      actor_id: staff.actorId,
      type: "payout",
      body:
        data.decision === "paid"
          ? `your withdrawal of ${row.currency} ${Number(row.amount).toFixed(2)} was paid out`
          : `your withdrawal was declined${data.note ? `: ${data.note}` : ""}`,
    });

    await writeAudit(
      staff,
      data.decision === "paid" ? "payout.paid" : "payout.declined",
      "payout",
      String(data.id),
      `${row.currency} ${Number(row.amount).toFixed(2)}${data.note ? ` — ${data.note}` : ""}`,
      data.decision === "paid" ? "info" : "warning",
    );

    return { status: data.decision };
  });
