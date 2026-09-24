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

/** Smallest withdrawal we accept, in the payout currency. */
export const MINIMUM_PAYOUT = 10;

function payoutCurrency() {
  return process.env["PAYSTACK_CURRENCY"] || "KES";
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

/** Tips received minus everything already withdrawn (excluding failed requests). */
async function computeLedger(supabase: any, profileId: string) {
  const [{ data: tips }, { data: payouts }] = await Promise.all([
    supabase
      .from("tips")
      .select("id, from_user_id, amount, message, created_at, post_id")
      .eq("to_user_id", profileId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("payouts")
      .select("*")
      .eq("user_id", profileId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const tipRows = (tips ?? []) as any[];
  const payoutRows = (payouts ?? []) as any[];

  const totalEarnings = tipRows.reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
  const withdrawn = payoutRows
    .filter((p) => p.status !== "failed" && p.status !== "reversed" && p.status !== "declined")
    .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);

  return {
    totalEarnings: Math.round(totalEarnings * 100) / 100,
    pendingBalance: Math.round(Math.max(0, totalEarnings - withdrawn) * 100) / 100,
    tips: tipRows,
    payouts: payoutRows,
  };
}

/** Everything the monetization screen needs, straight from the database. */
export const getEarnings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    const profileId = await myProfileId(supabase, userId);
    const ledger = await computeLedger(supabase, profileId);

    const senderIds = Array.from(new Set(ledger.tips.map((t) => String(t.from_user_id))));
    let senders: Record<string, any> = {};
    if (senderIds.length) {
      const { data } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", senderIds);
      senders = Object.fromEntries(((data ?? []) as any[]).map((p) => [String(p.id), p]));
    }

    const { data: settingsRow } = await supabase
      .from("monetization_settings")
      .select("min_tip, tips_enabled, subscriptions_enabled")
      .eq("user_id", profileId)
      .maybeSingle();

    return {
      totalEarnings: ledger.totalEarnings,
      pendingBalance: ledger.pendingBalance,
      currency: payoutCurrency(),
      minimumPayout: MINIMUM_PAYOUT,
      tips: ledger.tips.map((t) => {
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
      payouts: ledger.payouts.map((p) => ({
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
    const ledger = await computeLedger(supabase, profileId);

    const amount = Math.round((data.amount ?? ledger.pendingBalance) * 100) / 100;
    if (!(amount > 0)) throw new Error("You don't have anything to withdraw yet.");
    if (amount > ledger.pendingBalance) throw new Error("That's more than your available balance.");
    if (amount < MINIMUM_PAYOUT) {
      throw new Error(`The smallest withdrawal is ${payoutCurrency()} ${MINIMUM_PAYOUT}.`);
    }
    if (ledger.payouts.some((p) => p.status === "pending" || p.status === "reviewing")) {
      throw new Error("You already have a withdrawal waiting for review.");
    }

    const reference = `po_${crypto.randomUUID().replace(/-/g, "")}`;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any).from("payouts").insert({
      user_id: profileId,
      amount,
      method: "review",
      status: "pending",
      currency: payoutCurrency(),
      reference,
      failure_reason: null,
      destination: data.note ? data.note : null,
    });
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
