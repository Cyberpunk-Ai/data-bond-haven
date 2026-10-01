/**
 * Real creator earnings and withdrawals — personal AND team (workspace).
 *
 * Payout safety model (see plan §1/§2/§3):
 *   * The raw bank / mobile-money account number is sent to Paystack ONCE to
 *     mint a `recipient_code` and then discarded. Only the token is kept, and
 *     only inside an AES-GCM envelope (`payout-vault.server`) plus a masked
 *     hint (bank name + last four) safe to show in the UI.
 *   * Withdrawals are disbursed automatically via Paystack Transfers against the
 *     stored token; the `transfer.*` webhook reconciles the final status.
 *   * Team money is its own ledger (`workspace_earnings_snapshot`); only the
 *     workspace Owner can set the payout account or withdraw the team's balance.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DISPLAY_CURRENCY, round2, toUsd, usdToSettlement } from "@/lib/money";
import { feeBpsOrThrow } from "@/lib/plan-limits";
import { accountNamesMatch, resolveBankCode } from "@/lib/payout-verify";

// Server-only modules are imported lazily inside handlers: this file is
// reachable from the client bundle, so top-level `.server.ts` imports are not
// allowed. `@/lib/money`-style pure modules may be imported statically.
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

/**
 * Smallest withdrawal we accept, in USD — the currency every balance on the
 * platform is advertised in. Kept low ($1) so creators can cash out small
 * amounts any time. The provider clears the transfer in the settlement
 * currency, so `requestPayout` converts this floor with `PAYSTACK_USD_RATE`.
 */
export const MINIMUM_PAYOUT = 1;

/**
 * The platform's take, charged ONCE when a creator withdraws (never per tip):
 * 5% free · 3% plus · 1% pro. Rates live in `plan_limits.fee_bps` — the same
 * single source of truth the pricing page and settlement read.
 *
 * There is deliberately no fallback value. A withdrawal moves real money and
 * writes the rate onto the ledger row, so inventing 5% for a Pro creator on a
 * 1% plan would over-charge them on a record that stays in the books forever
 * (and under-charge the other way round). If the rate cannot be read, the
 * request fails and the balance is untouched.
 */
async function withdrawalFeeBps(profileId: string): Promise<number> {
  const { getPlanLimits } = await import("@/lib/plan-guard.server");
  let limits: Awaited<ReturnType<typeof getPlanLimits>>;
  try {
    limits = await getPlanLimits(profileId);
  } catch (err) {
    // Still a refusal, just one the creator can read: the raw error here talks
    // about missing table rows, which is our problem and not something to show.
    console.error("Could not read plan_limits for a withdrawal:", err);
    throw new Error("We couldn't confirm your withdrawal fee. Please try again in a moment.");
  }
  return feeBpsOrThrow(limits.fee_bps, limits.plan);
}

async function payoutCurrency() {
  const { env } = await import("@/lib/env.server");
  return env().paystack.currency;
}

/** USD -> settlement-currency rate configured on the server. */
async function usdRate() {
  const { env } = await import("@/lib/env.server");
  return env().paystack.usdRate;
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
 * Shape one snapshot row into the two currencies the platform works in:
 * `usd` (top-level fields — what every screen and every amount the user types
 * means) and `settlement` (the local currency Paystack actually moves).
 */
function readSnapshot(row: any, rate: number, fallbackCurrency: string) {
  const settlement = {
    gross: Number(row.gross_amount ?? 0),
    fees: Number(row.fees_amount ?? 0),
    net: Number(row.net_amount ?? 0),
    withdrawn: Number(row.withdrawn_amount ?? 0),
    available: Number(row.available_amount ?? 0),
    currency: String(row.currency ?? fallbackCurrency),
  };
  const usd = {
    gross: Number(row.gross_usd ?? 0),
    fees: Number(row.fees_usd ?? 0),
    net: Number(row.net_usd ?? 0),
    withdrawn: Number(row.withdrawn_usd ?? 0),
    available: Number(row.available_usd ?? 0),
  };
  return {
    totalEarnings: usd.gross,
    fees: usd.fees,
    net: usd.net,
    withdrawn: usd.withdrawn,
    pendingBalance: usd.available,
    currency: DISPLAY_CURRENCY,
    tipCount: Number(row.tip_count ?? 0),
    rate,
    settlement,
  };
}

/**
 * The authoritative personal balance, summed in the database with no row limit.
 * Team tips are excluded server-side (`to_workspace_id is null`), so a team's
 * earnings can never leak into a member's personal balance.
 */
async function earningsSnapshot(supabase: any, profileId: string) {
  const [rate, fallbackCurrency] = await Promise.all([usdRate(), payoutCurrency()]);
  const { data, error } = await supabase.rpc("earnings_snapshot", {
    _profile: profileId,
    _usd_rate: rate,
  });
  if (error) {
    console.error("earnings_snapshot failed:", error);
    throw new Error("We couldn't load your earnings right now. Please try again.");
  }
  const row = (Array.isArray(data) ? data[0] : data) ?? {};
  return readSnapshot(row, rate, fallbackCurrency);
}

/** The team's authoritative balance. Owner-or-staff only (the RPC enforces it). */
async function workspaceSnapshot(supabase: any, workspaceId: string) {
  const [rate, fallbackCurrency] = await Promise.all([usdRate(), payoutCurrency()]);
  const { data, error } = await supabase.rpc("workspace_earnings_snapshot", {
    _workspace: workspaceId,
    _usd_rate: rate,
  });
  if (error) {
    console.error("workspace_earnings_snapshot failed:", error);
    throw new Error("We couldn't load the team's earnings right now. Please try again.");
  }
  const row = (Array.isArray(data) ? data[0] : data) ?? {};
  return readSnapshot(row, rate, fallbackCurrency);
}

/** {id, owner_id, name} for a workspace, read past RLS via the admin client. */
async function workspaceRow(db: any, workspaceId: string) {
  const { data } = await db
    .from("workspaces")
    .select("id, owner_id, name")
    .eq("id", workspaceId)
    .maybeSingle();
  return data as { id: string; owner_id: string; name: string } | null;
}

/**
 * The decrypted payout token for a scope (personal or team), or null if none is
 * configured / the envelope can't be read. Never returned to the client.
 */
async function loadPayoutToken(
  db: any,
  scope: { profileId: string; workspaceId?: string | null },
): Promise<{
  recipientCode: string;
  bankName: string | null;
  last4: string | null;
  currency: string | null;
} | null> {
  const { decryptRecipient } = await import("@/lib/payout-vault.server");
  const raw = scope.workspaceId
    ? await db
        .from("workspace_payout_details")
        .select("*")
        .eq("workspace_id", scope.workspaceId)
        .maybeSingle()
    : await db
        .from("monetization_settings")
        .select("paystack_details")
        .eq("user_id", scope.profileId)
        .maybeSingle();
  const row = (raw as any)?.data;
  if (!row) return null;
  const blob = scope.workspaceId ? row.recipient_encrypted : row.paystack_details?.recipient;
  const bankName = scope.workspaceId ? row.bank_name : (row.paystack_details?.bank_name ?? null);
  const last4 = scope.workspaceId
    ? row.account_last4
    : (row.paystack_details?.account_last4 ?? null);
  const currency = scope.workspaceId ? row.currency : (row.paystack_details?.currency ?? null);
  if (!blob || !blob.iv) return null;
  try {
    const secret = decryptRecipient(blob);
    return { recipientCode: secret.recipient_code ?? "", bankName, last4, currency };
  } catch {
    // Rotated pepper / tampering: treat as "no usable destination".
    return null;
  }
}

/**
 * The full decrypted destination for a scope, or null. Unlike `loadPayoutToken`
 * this returns the raw account fields (account number, holder, bank) because a
 * manual withdrawal must snapshot "pay THIS account" onto the request row. The
 * value never leaves the server: it is immediately re-encrypted into the row's
 * own `destination_enc` and only a staff-gated, audit-logged read can show it.
 */
async function loadPayoutSecret(
  db: any,
  scope: { profileId: string; workspaceId?: string | null },
): Promise<{
  recipientCode: string;
  bankCode: string | null;
  accountNumber: string | null;
  accountLast4: string | null;
  holderName: string | null;
  bankName: string | null;
  currency: string | null;
  channel: "nuban" | "mobile_money";
} | null> {
  const { decryptRecipient } = await import("@/lib/payout-vault.server");
  const raw = scope.workspaceId
    ? await db
        .from("workspace_payout_details")
        .select("*")
        .eq("workspace_id", scope.workspaceId)
        .maybeSingle()
    : await db
        .from("monetization_settings")
        .select("paystack_details")
        .eq("user_id", scope.profileId)
        .maybeSingle();
  const row = (raw as any)?.data;
  if (!row) return null;
  const blob = scope.workspaceId ? row.recipient_encrypted : row.paystack_details?.recipient;
  if (!blob || !blob.iv) return null;
  try {
    const s = decryptRecipient(blob);
    return {
      recipientCode: s.recipient_code ?? "",
      bankCode: s.bank_code ?? null,
      accountNumber: s.account_number ?? null,
      accountLast4:
        s.account_number_last4 ?? (s.account_number ? s.account_number.slice(-4) : null),
      holderName: s.holder_name ?? null,
      bankName: s.bank_name ?? null,
      currency: s.currency ?? null,
      channel: s.channel === "mobile_money" ? "mobile_money" : "nuban",
    };
  } catch {
    return null;
  }
}

/** A masked, UI-safe view of a stored payout destination. */
function maskedDestination(
  dest: { bankName: string | null; last4: string | null; currency: string | null } | null,
) {
  if (!dest) return { configured: false as const, bankName: null, last4: null, currency: null };
  return {
    configured: true as const,
    bankName: dest.bankName ?? null,
    last4: dest.last4 ?? null,
    currency: dest.currency ?? null,
  };
}

/** Everything the monetization screen needs, straight from the database. */
export const getEarnings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    const profileId = await myProfileId(supabase, userId);
    const [snapshot, tipsRes, payoutsRes, settingsRes] = await Promise.all([
      earningsSnapshot(supabase, profileId),
      supabase
        .from("tips")
        .select(
          "id, from_user_id, amount, message, created_at, post_id, exchange_rate, quoted_amount_usd",
        )
        .eq("to_user_id", profileId)
        .is("to_workspace_id", null)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("payouts")
        .select(
          "id, amount, amount_usd, exchange_rate, currency, status, reference, failure_reason, created_at",
        )
        .eq("user_id", profileId)
        .is("workspace_id", null)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("monetization_settings")
        .select("min_tip, tips_enabled, subscriptions_enabled, paystack_details")
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
    const payoutDest = maskedDestination(
      settingsRow?.paystack_details?.bank_name
        ? {
            bankName: settingsRow.paystack_details.bank_name,
            last4: settingsRow.paystack_details.account_last4 ?? null,
            currency: settingsRow.paystack_details.currency ?? null,
          }
        : null,
    );
    const feeBps = await withdrawalFeeBps(profileId);
    const open = payoutRows.find((p) =>
      ["pending", "reviewing", "processing"].includes(String(p.status)),
    );

    return {
      totalEarnings: snapshot.totalEarnings,
      pendingBalance: snapshot.pendingBalance,
      currency: snapshot.currency,
      minimumPayout: MINIMUM_PAYOUT,
      // Withdrawal-time take rate for this creator (5/3/1% by plan).
      feeBps,
      feePercent: feeBps / 100,
      // The local currency the provider actually transfers in, plus the rate
      // used — so a confirmation can say "$12.00 (≈ KES 1,560) is on its way".
      settlement: {
        currency: snapshot.settlement.currency,
        pendingBalance: snapshot.settlement.available,
        rate: snapshot.rate,
      },
      payoutDestination: payoutDest,
      openPayout: open ? { id: String(open.id), status: String(open.status) } : null,
      tips: tipRows.map((t) => {
        const sender = senders[String(t.from_user_id)];
        return {
          id: String(t.id),
          amount: toUsd({
            amount: Number(t.amount ?? 0),
            exchangeRate: t.exchange_rate,
            quotedUsd: t.quoted_amount_usd,
            usdRate: snapshot.rate,
          }),
          message: t.message || "",
          createdAt: t.created_at,
          senderName: sender?.display_name ?? "Supporter",
          senderUsername: sender?.username ?? "supporter",
          senderAvatar: sender?.avatar_url ?? undefined,
        };
      }),
      payouts: payoutRows.map((p) => ({
        id: String(p.id),
        amount: toUsd({
          amount: Number(p.amount ?? 0),
          exchangeRate: p.exchange_rate,
          quotedUsd: p.amount_usd,
          usdRate: snapshot.rate,
        }),
        settlementAmount: Number(p.amount ?? 0),
        settlementCurrency: String(p.currency ?? snapshot.settlement.currency),
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
 * Paystack's own bank/provider directory, proxied server side (the secret key
 * never reaches the browser). All countries, because people cash out from
 * everywhere — the UI turns this into a type-ahead list and this module uses it
 * to map a typed name back to the code the provider expects.
 */
async function providerBanks(): Promise<{ code: string; name: string; country: string }[]> {
  const { paystack } = await import("@/lib/paystack-api.server");
  const res = await paystack("/bank");
  const rows = (res?.data ?? []) as any[];
  return rows
    .filter((b) => b?.code && b?.name)
    .map((b) => ({
      code: String(b.code),
      name: String(b.name),
      country: String(b.country ?? ""),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 3000);
}

/**
 * Captures a payout account and exchanges it for a Paystack recipient token.
 * The raw account number is forwarded to Paystack once and NEVER stored; only
 * the encrypted token + a masked hint persist. Team destinations require the
 * workspace Owner (admins/editors cannot redirect a team's money).
 *
 * Verification order matters: `/bank/resolve` runs BEFORE `/transferrecipient`,
 * so an unverifiable or mis-typed destination can never become a stored
 * recipient — and the holder's name must agree with the bank's answer.
 */
export const savePayoutDestination = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      workspaceId?: string | null;
      type?: string;
      bank_code?: string;
      country?: string;
      account_number?: string;
      account_name?: string;
    }) => {
      const type = input.type === "mobile_money" ? "mobile_money" : "nuban";
      const account_number = String(input.account_number ?? "").replace(/\s+/g, "");
      const account_name = String(input.account_name ?? "").trim();
      // Free text on purpose: a supporter in Lagos, Nairobi or Manila types their
      // own bank's name. It is mapped to a provider code and verified below.
      const bank_code = String(input.bank_code ?? "")
        .trim()
        .replace(/\s+/g, " ");
      if (!/^\+?[A-Za-z0-9]{6,20}$/.test(account_number)) {
        throw new Error("Enter a valid account number (6–20 characters).");
      }
      if (account_name.length < 2 || account_name.length > 80) {
        throw new Error("Enter the account holder's full name.");
      }
      if (!/^[A-Za-z0-9_()&'. -]{1,60}$/.test(bank_code)) {
        throw new Error("Enter your bank or mobile-money provider.");
      }
      return {
        workspaceId: input.workspaceId ?? null,
        type: type as "nuban" | "mobile_money",
        bank_code,
        account_number,
        account_name,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const profileId = await myProfileId(supabase, userId);
    const adminClient = await admin();
    const db = adminClient;

    if (data.workspaceId) {
      const ws = await workspaceRow(db, data.workspaceId);
      if (!ws) throw new Error("We couldn't find that team.");
      if (String(ws.owner_id) !== profileId) {
        throw new Error("Only the team owner can set the payout account.");
      }
    }
    // Personal: no plan gate — every tier can receive payouts; the tier only
    // changes the withdrawal fee (plan_limits.fee_bps, charged in requestPayout).

    const { paystack, paystackConfig } = await import("@/lib/paystack-api.server");
    const { encryptRecipient } = await import("@/lib/payout-vault.server");
    const currency = paystackConfig().currency;

    // 1. Map the typed label to a real provider code ("Equity Bank" -> 011407).
    //    Anything that is already a code passes straight through; an unknown
    //    string is left for the provider to reject rather than guessed at.
    let bankCode = data.bank_code.toUpperCase();
    if (data.type === "nuban") {
      try {
        const mapped = resolveBankCode(data.bank_code, await providerBanks());
        if (mapped) bankCode = mapped;
      } catch (err) {
        // The directory is a convenience; resolve (below) is the real gate.
        console.error("Could not load the bank directory for lookup:", err);
      }
    }

    // 2. Verify the account with the provider. For a bank account this is a
    //    hard anti-typo gate — an account that does not resolve can never be
    //    stored. For mobile money worldwide many wallets do not answer the
    //    resolve endpoint the way banks do, and since disbursement is now done
    //    by hand, a non-resolving wallet is only a warning, not a dead end.
    let resolvedName = "";
    let resolvedBankName = "";
    try {
      const check = await paystack(
        `/bank/resolve?account_number=${encodeURIComponent(data.account_number)}&bank_code=${encodeURIComponent(bankCode)}`,
      );
      resolvedName = String(check?.data?.account_name ?? "").trim();
      resolvedBankName = String(check?.data?.bank?.name ?? "").trim();
    } catch (err) {
      const message = (err as Error)?.message ?? "";
      console.warn("Payout account could not be resolved:", message);
      if (data.type !== "mobile_money") {
        throw new Error(
          /invalid_bank_code|bank_code/i.test(message)
            ? "We couldn't match that bank with the payment provider. Enter the exact bank name from your statement."
            : message ||
                "The payment provider could not verify that account. Please check the details and try again.",
        );
      }
    }
    if (!resolvedName && data.type !== "mobile_money") {
      throw new Error(
        "The payment provider could not verify that account. Please check the number and bank.",
      );
    }

    // 3. When the provider answers with a name, it must match the name the
    //    person gave us (a masked answer still counts as a successful proof);
    //    when it answers with nothing (mobile money we couldn't resolve), we
    //    keep the holder's self-declared name for the operator to verify.
    let holderName = data.account_name;
    if (resolvedName) {
      const nameCheck = accountNamesMatch(resolvedName, data.account_name);
      if (!nameCheck.matched) {
        throw new Error(
          `That account is registered as ${resolvedName}. Update the name to match your bank statement exactly.`,
        );
      }
      holderName = nameCheck.skipped ? data.account_name : resolvedName;
    }

    // 4. Mint the provider recipient token only as a best-effort convenience —
    //    under manual disbursement it is not required to move money, so a
    //    country or wallet the provider cannot tokenize still saves fine.
    let recipientCode: string | undefined;
    try {
      const res = await paystack("/transferrecipient", {
        method: "POST",
        body: JSON.stringify({
          type: data.type,
          name: holderName,
          account_number: data.account_number,
          bank_code: bankCode,
          currency,
        }),
      });
      recipientCode = res?.data?.recipient_code as string | undefined;
      resolvedBankName =
        resolvedBankName || (res?.data?.details?.bank_name as string | undefined) || "";
    } catch (err) {
      console.warn("Provider recipient could not be minted (manual payout still OK):", err);
    }
    const bankName = resolvedBankName || data.bank_code;
    const last4 = data.account_number.slice(-4);

    const envelope = encryptRecipient({
      recipient_code: recipientCode,
      bank_code: bankCode,
      account_number_last4: last4,
      // Kept for manual disbursement: an operator pays this exact account when
      // the creator withdraws. Still only ever stored inside the AES-GCM
      // envelope, never in cleartext, and revealed only to audited staff.
      account_number: data.account_number,
      holder_name: holderName,
      bank_name: bankName,
      currency,
      channel: data.type,
    });

    if (data.workspaceId) {
      const { error } = await supabase.from("workspace_payout_details").upsert(
        {
          workspace_id: data.workspaceId,
          recipient_encrypted: envelope,
          bank_name: bankName,
          account_last4: last4,
          currency,
          updated_by: profileId,
        },
        { onConflict: "workspace_id" },
      );
      if (error) {
        console.error("Could not save team payout account:", error);
        throw new Error("We couldn't save that payout account. Please try again.");
      }
    } else {
      // Merge into paystack_details without clobbering any other keys.
      const { data: existing } = await db
        .from("monetization_settings")
        .select("paystack_details")
        .eq("user_id", profileId)
        .maybeSingle();
      const merged = {
        ...(typeof existing?.paystack_details === "object" && existing.paystack_details
          ? existing.paystack_details
          : {}),
        recipient: envelope,
        bank_name: bankName,
        account_last4: last4,
        currency,
      };
      const { error } = await supabase
        .from("monetization_settings")
        .upsert({ user_id: profileId, paystack_details: merged }, { onConflict: "user_id" });
      if (error) {
        console.error("Could not save payout account:", error);
        throw new Error("We couldn't save that payout account. Please try again.");
      }
    }

    return { bankName, last4, currency, accountName: holderName };
  });

/**
 * Requests a withdrawal for MANUAL disbursement.
 *
 * The platform no longer pushes money out through the provider itself. A
 * request parks in `pending` with an encrypted snapshot of the creator's payout
 * account attached, so a staff operator can pay that account directly and then
 * confirm (paid) or reject (declined) via `reviewPayout`. The ledger already
 * debits a `pending` request's gross amount, so the balance is reserved the
 * instant it is requested and is returned automatically if it is declined.
 *
 * For a team it draws on the team balance and is restricted to the Owner.
 * Amounts in and out are USD (what the creator sees); the local figure the
 * operator actually transfers is converted to the recipient's settlement
 * currency and capped at the settlement balance available, so FX drift can
 * never overdraw.
 */
export const requestPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { amount?: number; workspaceId?: string | null }) => ({
    amount: input?.amount != null ? Number(input.amount) : undefined,
    workspaceId: input?.workspaceId ?? null,
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const profileId = await myProfileId(supabase, userId);
    const db = await admin();
    const isTeam = !!data.workspaceId;

    // Anyone can cash out — the plan tier only changes the fee (5/3/1%),
    // charged once here at withdrawal, never per tip. For a team, the rate
    // follows the owner's plan (the same profile that anchors team fees).
    let feeProfileId = profileId;
    if (isTeam) {
      const ws = await workspaceRow(db, data.workspaceId as string);
      if (!ws) throw new Error("We couldn't find that team.");
      if (String(ws.owner_id) !== profileId) {
        throw new Error("Only the team owner can withdraw the team's earnings.");
      }
      feeProfileId = String(ws.owner_id);
    }

    const snapshot = isTeam
      ? await workspaceSnapshot(supabase, data.workspaceId as string)
      : await earningsSnapshot(supabase, profileId);
    // Full account (decrypted only here) so we can attach a self-contained
    // "pay this exact account" snapshot to the request row.
    const dest = await loadPayoutSecret(db, { profileId, workspaceId: data.workspaceId });
    if (!dest?.accountNumber) {
      throw new Error(
        isTeam
          ? "The team owner must add a payout account first."
          : "Add your payout account first.",
      );
    }

    // USD is the unit the creator is shown and the unit they type.
    const amountUsd = round2(data.amount ?? snapshot.pendingBalance);
    if (!(amountUsd > 0)) {
      throw new Error(
        isTeam
          ? "The team doesn't have anything to withdraw yet."
          : "You don't have anything to withdraw yet.",
      );
    }
    if (amountUsd > snapshot.pendingBalance) {
      throw new Error("That's more than your available balance.");
    }
    if (amountUsd < MINIMUM_PAYOUT) {
      throw new Error(`The smallest withdrawal is $${MINIMUM_PAYOUT.toFixed(2)}.`);
    }

    // The platform's take, applied to the gross request before converting.
    const feeBps = await withdrawalFeeBps(feeProfileId);
    const feeUsd = round2((amountUsd * feeBps) / 10000);
    const netUsd = round2(amountUsd - feeUsd);
    if (!(netUsd > 0)) {
      throw new Error("There isn't enough available to withdraw after the fee.");
    }

    // The figure the operator transfers is in the destination's own currency
    // and is the NET — the ledger debits the gross (`amount_usd`), so the
    // difference is exactly the platform's fee.
    const settlementCurrency = dest.currency || snapshot.settlement.currency;
    const settlementAmount = usdToSettlement({
      usd: netUsd,
      usdRate: snapshot.rate,
      maxSettlement: snapshot.settlement.available,
    });
    const minor = Math.round(settlementAmount * 100);
    if (minor <= 0) {
      throw new Error("There isn't enough available to withdraw yet.");
    }

    // Snapshot the destination so a later edit of the saved account can never
    // rewrite the instructions attached to this in-flight request. Re-encrypted
    // with the same vault; only an audited staff read can decrypt it again.
    const { encryptRecipient } = await import("@/lib/payout-vault.server");
    const destinationEnc = encryptRecipient({
      recipient_code: dest.recipientCode,
      bank_code: dest.bankCode ?? "",
      account_number: dest.accountNumber,
      account_number_last4: dest.accountLast4 ?? dest.accountNumber.slice(-4),
      holder_name: dest.holderName ?? "",
      bank_name: dest.bankName ?? "",
      currency: settlementCurrency,
      channel: dest.channel,
    });

    const reference = `po_${crypto.randomUUID().replace(/-/g, "")}`;
    const { data: inserted, error } = await db
      .from("payouts")
      .insert({
        user_id: profileId,
        workspace_id: data.workspaceId ?? null,
        amount: settlementAmount,
        amount_minor: minor,
        amount_usd: amountUsd,
        exchange_rate: snapshot.rate,
        fee_bps: feeBps,
        fee_usd: feeUsd,
        net_usd: netUsd,
        method: "manual",
        status: "pending",
        currency: settlementCurrency,
        reference,
        recipient_code: dest.recipientCode ?? null,
        failure_reason: null,
        destination_enc: destinationEnc,
        bank_name: dest.bankName,
        account_last4: dest.accountLast4 ?? dest.accountNumber.slice(-4),
        account_name: dest.holderName,
        account_type: dest.channel,
      })
      .select("id")
      .maybeSingle();
    // The partial unique index blocks a second open withdrawal per scope.
    if (error && (error as any).code === "23505") {
      throw new Error(
        isTeam
          ? "This team already has a withdrawal in progress."
          : "You already have a withdrawal in progress.",
      );
    }
    if (error || !inserted?.id) {
      console.error("Could not start payout:", error);
      throw new Error("We couldn't start that withdrawal. Please try again.");
    }

    return {
      reference,
      amount: amountUsd,
      // A manual request sits with the team until an operator pays it out.
      status: "pending" as const,
      // Fee economics in USD, for the confirmation copy.
      feeBps,
      feeUsd,
      netUsd,
      // Local side of the same withdrawal, for the confirmation copy.
      settlementAmount,
      settlementCurrency,
    };
  });

/** Team earnings hub — Owner only. Mirrors getEarnings against the team ledger. */
export const getWorkspaceEarnings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId?: string }) => {
    const id = String(input?.workspaceId ?? "");
    if (!id) throw new Error("Unknown workspace.");
    return { workspaceId: id };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const profileId = await myProfileId(supabase, userId);
    const db = await admin();

    const ws = await workspaceRow(db, data.workspaceId);
    if (!ws) throw new Error("We couldn't find that team.");
    if (String(ws.owner_id) !== profileId) {
      throw new Error("Only the team owner can view the team's earnings.");
    }

    const [snapshot, tipsRes, payoutsRes] = await Promise.all([
      workspaceSnapshot(supabase, data.workspaceId),
      db
        .from("tips")
        .select(
          "id, from_user_id, amount, message, created_at, post_id, exchange_rate, quoted_amount_usd",
        )
        .eq("to_workspace_id", data.workspaceId)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("payouts")
        .select(
          "id, amount, amount_usd, exchange_rate, currency, status, reference, failure_reason, created_at",
        )
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    const tipRows = (tipsRes.data ?? []) as any[];
    const payoutRows = (payoutsRes.data ?? []) as any[];
    const senderIds = Array.from(new Set(tipRows.map((t) => String(t.from_user_id))));
    let senders: Record<string, any> = {};
    if (senderIds.length) {
      const { data: profs } = await db
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", senderIds);
      senders = Object.fromEntries(((profs ?? []) as any[]).map((p) => [String(p.id), p]));
    }

    const dest = await loadPayoutToken(db, { profileId, workspaceId: data.workspaceId });
    const teamFeeBps = await withdrawalFeeBps(String(ws.owner_id));
    const open = payoutRows.find((p) =>
      ["pending", "reviewing", "processing"].includes(String(p.status)),
    );

    return {
      workspaceId: data.workspaceId,
      workspaceName: ws.name,
      totalEarnings: snapshot.totalEarnings,
      pendingBalance: snapshot.pendingBalance,
      currency: snapshot.currency,
      minimumPayout: MINIMUM_PAYOUT,
      // The team's take rate follows the owner's plan (5/3/1%).
      feeBps: teamFeeBps,
      feePercent: teamFeeBps / 100,
      settlement: {
        currency: snapshot.settlement.currency,
        pendingBalance: snapshot.settlement.available,
        rate: snapshot.rate,
      },
      isOwner: true as const,
      payoutDestination: maskedDestination(dest),
      openPayout: open ? { id: String(open.id), status: String(open.status) } : null,
      tips: tipRows.map((t: any) => {
        const sender = senders[String(t.from_user_id)];
        return {
          id: String(t.id),
          amount: toUsd({
            amount: Number(t.amount ?? 0),
            exchangeRate: t.exchange_rate,
            quotedUsd: t.quoted_amount_usd,
            usdRate: snapshot.rate,
          }),
          message: t.message || "",
          createdAt: t.created_at,
          senderName: sender?.display_name ?? "Supporter",
          senderUsername: sender?.username ?? "supporter",
          senderAvatar: sender?.avatar_url ?? undefined,
        };
      }),
      payouts: payoutRows.map((p: any) => ({
        id: String(p.id),
        amount: toUsd({
          amount: Number(p.amount ?? 0),
          exchangeRate: p.exchange_rate,
          quotedUsd: p.amount_usd,
          usdRate: snapshot.rate,
        }),
        settlementAmount: Number(p.amount ?? 0),
        settlementCurrency: String(p.currency ?? snapshot.settlement.currency),
        status: String(p.status ?? "pending"),
        reference: p.reference ?? null,
        failureReason: p.failure_reason ?? null,
        createdAt: p.created_at,
      })),
    };
  });

/** Staff: every withdrawal request (personal and team), newest first. */
export const listPayoutRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertStaff } = await import("./staff.server");
    const staff = await assertStaff(context);
    const rate = await usdRate();

    const { data } = await staff.admin
      .from("payouts")
      .select(
        "id, user_id, workspace_id, amount, amount_usd, exchange_rate, fee_usd, net_usd, currency, status, reference, failure_reason, bank_name, account_last4, account_name, account_type, destination_enc, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);

    const rows = (data ?? []) as any[];
    const ids = Array.from(new Set(rows.map((r) => String(r.user_id))));
    const wsIds = Array.from(new Set(rows.map((r) => r.workspace_id).filter(Boolean) as string[]));
    let people: Record<string, any> = {};
    let teams: Record<string, any> = {};
    if (ids.length) {
      const { data: profiles } = await staff.admin
        .from("profiles")
        .select("id, username, display_name")
        .in("id", ids);
      people = Object.fromEntries(((profiles ?? []) as any[]).map((p) => [String(p.id), p]));
    }
    if (wsIds.length) {
      const { data: ws } = await staff.admin.from("workspaces").select("id, name").in("id", wsIds);
      teams = Object.fromEntries(((ws ?? []) as any[]).map((w) => [String(w.id), w]));
    }

    return rows.map((r) => ({
      id: String(r.id),
      amount: toUsd({
        amount: Number(r.amount ?? 0),
        exchangeRate: r.exchange_rate,
        quotedUsd: r.amount_usd,
        usdRate: rate,
      }),
      settlementAmount: Number(r.amount ?? 0),
      currency: String(r.currency ?? "KES"),
      status: String(r.status ?? "pending"),
      reference: r.reference ?? null,
      failureReason: r.failure_reason ?? null,
      createdAt: r.created_at,
      workspaceId: r.workspace_id ?? null,
      workspaceName: r.workspace_id ? (teams[String(r.workspace_id)]?.name ?? "Team") : null,
      creatorName: people[String(r.user_id)]?.display_name ?? "Creator",
      creatorUsername: people[String(r.user_id)]?.username ?? "creator",
      // Fee economics + masked destination so the queue reads without decrypting.
      feeUsd: Number(r.fee_usd ?? 0),
      netUsd: Number(r.net_usd ?? r.amount_usd ?? 0),
      bankName: r.bank_name ?? null,
      accountLast4: r.account_last4 ?? null,
      accountName: r.account_name ?? null,
      accountType: r.account_type ?? null,
      hasDestination: !!r.destination_enc,
    }));
  });

/** Staff: manually mark a withdrawal paid or declined. Always audit-logged. */
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
      .select("id, user_id, amount, amount_usd, exchange_rate, currency, status")
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
        reviewed_by: staff.actorId,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error("We couldn't update that withdrawal. Please try again.");

    // Staff reviews money in USD too — the dollar figure is what the creator
    // was shown, the local figure is what the bank received.
    const rate = await usdRate();
    const paidUsd = toUsd({
      amount: Number(row.amount ?? 0),
      exchangeRate: row.exchange_rate,
      quotedUsd: row.amount_usd,
      usdRate: rate,
    });

    const { error: noticeError } = await staff.admin.from("notifications").insert({
      recipient_id: row.user_id,
      actor_id: staff.actorId,
      type: "payout",
      body:
        data.decision === "paid"
          ? `your withdrawal of $${paidUsd.toFixed(2)} was paid out`
          : `your withdrawal was declined${data.note ? `: ${data.note}` : ""}`,
    });
    // The decision row and the money moved regardless; a creator who never gets
    // the alert should at least leave a trace in the server logs.
    if (noticeError) console.error("payout decision notice not stored:", noticeError.message);

    await writeAudit(
      staff,
      data.decision === "paid" ? "payout.paid" : "payout.declined",
      "payout",
      String(data.id),
      `${row.currency} ${Number(row.amount).toFixed(2)} = $${paidUsd.toFixed(2)} USD${data.note ? ` — ${data.note}` : ""}`,
      data.decision === "paid" ? "info" : "warning",
    );

    return { status: data.decision };
  });

/**
 * Staff: reveal the exact account a withdrawal must be paid to, so an operator
 * can disburse it manually. The account lives encrypted on the payout row; this
 * is the ONLY path that decrypts it, it is gated on staff, and every reveal is
 * written to the audit log (who looked, at what) because it surfaces bank-level
 * financial detail.
 */
export const getPayoutAccount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("Missing withdrawal");
    return { id: input.id };
  })
  .handler(async ({ data, context }) => {
    const { assertStaff, writeAudit } = await import("./staff.server");
    const staff = await assertStaff(context);

    const { data: row } = await staff.admin
      .from("payouts")
      .select("id, status, currency, amount, bank_name, destination_enc")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("That withdrawal no longer exists.");
    if (!row.destination_enc || !(row.destination_enc as any).iv) {
      // Requests made before manual disbursement kept only a provider token.
      return {
        available: false as const,
        bankName: row.bank_name ?? null,
        reason: "No stored account for this request — it predates manual payouts.",
      };
    }

    const { decryptRecipient } = await import("@/lib/payout-vault.server");
    let secret;
    try {
      secret = decryptRecipient(row.destination_enc);
    } catch {
      return {
        available: false as const,
        bankName: row.bank_name ?? null,
        reason: "The stored account could not be read.",
      };
    }

    await writeAudit(
      staff,
      "payout.account_revealed",
      "payout",
      String(data.id),
      `Revealed payout account (${secret.bank_name ?? row.bank_name ?? "provider"} ••••${(secret.account_number ?? "").slice(-4)})`,
      "warning",
    );

    return {
      available: true as const,
      bankName: secret.bank_name ?? row.bank_name ?? null,
      accountNumber: secret.account_number ?? null,
      accountName: secret.holder_name ?? null,
      bankCode: secret.bank_code ?? null,
      currency: secret.currency ?? row.currency ?? null,
      channel: secret.channel ?? "nuban",
    };
  });

/**
 * Staff: one chronological feed of every money event on the platform — tips
 * received, plan purchases and withdrawal requests — so an admin can see all
 * payment activity in a single view instead of three separate tables. Amounts
 * are normalised to USD (the platform's display currency) where a row carries a
 * quote, falling back to the configured rate for FX.
 */
export const listPaymentActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertStaff } = await import("./staff.server");
    const staff = await assertStaff(context);
    const rate = await usdRate();
    const db = staff.admin;

    const [tipsRes, plansRes, payoutsRes] = await Promise.all([
      db
        .from("tips")
        .select(
          "id, from_user_id, to_user_id, to_workspace_id, amount, exchange_rate, quoted_amount_usd, currency, message, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(40),
      db
        .from("payments")
        .select(
          "id, user_id, plan, billing_cycle, amount, amount_minor, exchange_rate, quoted_amount_usd, currency, status, created_at",
        )
        .eq("kind", "plan")
        .order("created_at", { ascending: false })
        .limit(40),
      db
        .from("payouts")
        .select(
          "id, user_id, workspace_id, amount, amount_usd, exchange_rate, currency, status, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(40),
    ]);

    // Resolve every profile / workspace name referenced across the three sets.
    const profileIds = new Set<string>();
    for (const t of tipsRes.data ?? []) {
      if (t.from_user_id) profileIds.add(String(t.from_user_id));
      if (t.to_user_id) profileIds.add(String(t.to_user_id));
    }
    for (const p of plansRes.data ?? []) if (p.user_id) profileIds.add(String(p.user_id));
    for (const w of payoutsRes.data ?? []) if (w.user_id) profileIds.add(String(w.user_id));
    const wsIds = new Set<string>();
    for (const t of tipsRes.data ?? []) if (t.to_workspace_id) wsIds.add(String(t.to_workspace_id));
    for (const w of payoutsRes.data ?? []) if (w.workspace_id) wsIds.add(String(w.workspace_id));

    const [peopleRows, teamRows] = await Promise.all([
      profileIds.size
        ? db
            .from("profiles")
            .select("id, display_name, username")
            .in("id", [...profileIds])
        : Promise.resolve({ data: [] as any[] }),
      wsIds.size
        ? db
            .from("workspaces")
            .select("id, name")
            .in("id", [...wsIds])
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const people: Record<string, any> = Object.fromEntries(
      ((peopleRows.data ?? []) as any[]).map((p) => [String(p.id), p]),
    );
    const teams: Record<string, any> = Object.fromEntries(
      ((teamRows.data ?? []) as any[]).map((w) => [String(w.id), w]),
    );
    const nameOf = (id: any) =>
      id ? (people[String(id)]?.display_name ?? people[String(id)]?.username ?? "Member") : "—";
    const teamOf = (id: any) => (id ? (teams[String(id)]?.name ?? "Team") : null);

    type Activity = {
      id: string;
      kind: "tip" | "plan" | "withdrawal";
      amountUsd: number;
      currency: string;
      status: string;
      createdAt: string;
      summary: string;
    };

    const events: Activity[] = [];

    for (const t of tipsRes.data ?? []) {
      const usdAmount = toUsd({
        amount: Number(t.amount ?? 0),
        exchangeRate: t.exchange_rate,
        quotedUsd: t.quoted_amount_usd,
        usdRate: rate,
      });
      events.push({
        id: String(t.id),
        kind: "tip",
        amountUsd: usdAmount,
        currency: String(t.currency ?? "KES"),
        status: "settled",
        createdAt: t.created_at,
        summary: teamOf(t.to_workspace_id)
          ? `${nameOf(t.from_user_id)} tipped ${teamOf(t.to_workspace_id)} (team)`
          : `${nameOf(t.from_user_id)} tipped ${nameOf(t.to_user_id)}`,
      });
    }

    for (const p of plansRes.data ?? []) {
      const usdAmount = toUsd({
        amount: p.amount_minor != null ? Number(p.amount_minor) / 100 : Number(p.amount ?? 0),
        exchangeRate: p.exchange_rate,
        quotedUsd: p.quoted_amount_usd,
        usdRate: rate,
      });
      events.push({
        id: String(p.id),
        kind: "plan",
        amountUsd: usdAmount,
        currency: String(p.currency ?? "KES"),
        status: String(p.status ?? "pending"),
        createdAt: p.created_at,
        summary: `${nameOf(p.user_id)} ${p.status === "success" ? "upgraded to" : "started a"} ${String(p.plan ?? "plan").toUpperCase()} (${p.billing_cycle ?? "monthly"})`,
      });
    }

    for (const w of payoutsRes.data ?? []) {
      const usdAmount = toUsd({
        amount: Number(w.amount ?? 0),
        exchangeRate: w.exchange_rate,
        quotedUsd: w.amount_usd,
        usdRate: rate,
      });
      events.push({
        id: String(w.id),
        kind: "withdrawal",
        amountUsd: usdAmount,
        currency: String(w.currency ?? "KES"),
        status: String(w.status ?? "pending"),
        createdAt: w.created_at,
        summary: teamOf(w.workspace_id)
          ? `${nameOf(w.user_id)} withdrew for ${teamOf(w.workspace_id)} (team)`
          : `${nameOf(w.user_id)} requested a withdrawal`,
      });
    }

    events.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return events.slice(0, 60);
  });
