/**
 * Creator earnings state. Everything comes from the backend — balances are
 * derived from real recorded tips and real withdrawal requests. For payouts we
 * store only an encrypted Paystack recipient token plus a masked hint (bank
 * name + last four); the raw account number is sent to the provider once and
 * never persisted here or on any client.
 */
import { useCallback, useEffect, useState } from "react";

import { signedInProfileId } from "@/lib/remote-store";
import { errorMessage } from "@/lib/error-messages";
import {
  getEarnings,
  requestPayout as requestPayoutApi,
  saveTipSettings as saveTipSettingsApi,
} from "@/lib/payouts.functions";

export interface TipRecord {
  id: string;
  senderName: string;
  senderUsername: string;
  senderAvatar?: string;
  amount: number;
  message?: string;
  timestamp: string;
}

export interface PayoutRecord {
  id: string;
  amount: number;
  status: string;
  reference: string | null;
  failureReason: string | null;
  date: string;
}

export interface MonetizationSettings {
  minimumTip: number;
  tipsEnabled: boolean;
}

/**
 * The local side of the same ledger. Balances are shown in USD, but the
 * provider clears withdrawals in the merchant's settlement currency, so the UI
 * can say "$12.00 (≈ KES 1,560)" instead of surprising anyone at the bank.
 */
export interface SettlementInfo {
  currency: string;
  pendingBalance: number;
  rate: number;
}

/** Masked, UI-safe view of a saved payout account (never the token itself). */
export interface PayoutDestination {
  configured: boolean;
  bankName: string | null;
  last4: string | null;
  currency: string | null;
}

interface MonetizationState {
  loading: boolean;
  error: string | null;
  totalEarnings: number;
  pendingBalance: number;
  currency: string;
  minimumPayout: number;
  /** Withdrawal-time platform take, as a percent (5 free / 3 plus / 1 pro). */
  feePercent: number;
  settlement: SettlementInfo | null;
  tipsReceived: TipRecord[];
  payouts: PayoutRecord[];
  settings: MonetizationSettings;
  payoutDestination: PayoutDestination;
  openPayout: { id: string; status: string } | null;
}

const EMPTY: MonetizationState = {
  loading: true,
  error: null,
  totalEarnings: 0,
  pendingBalance: 0,
  currency: "USD",
  minimumPayout: 1,
  feePercent: 5,
  settlement: null,
  tipsReceived: [],
  payouts: [],
  settings: { minimumTip: 1, tipsEnabled: true },
  payoutDestination: { configured: false, bankName: null, last4: null, currency: null },
  openPayout: null,
};

let state: MonetizationState = EMPTY;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function publish(next: MonetizationState) {
  state = next;
  listeners.forEach((fn) => fn());
}

export async function refreshMonetization() {
  if (!signedInProfileId()) {
    publish({ ...EMPTY, loading: false });
    return;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data = await getEarnings();
      publish({
        loading: false,
        error: null,
        totalEarnings: data.totalEarnings,
        pendingBalance: data.pendingBalance,
        currency: data.currency,
        minimumPayout: data.minimumPayout,
        feePercent: data.feePercent ?? 5,
        settlement: data.settlement ?? null,
        tipsReceived: data.tips.map((t) => ({
          id: t.id,
          senderName: t.senderName,
          senderUsername: t.senderUsername,
          senderAvatar: t.senderAvatar,
          amount: t.amount,
          message: t.message || undefined,
          timestamp: new Date(t.createdAt).toLocaleString(),
        })),
        payouts: data.payouts.map((p) => ({
          id: p.id,
          amount: p.amount,
          status: p.status,
          reference: p.reference,
          failureReason: p.failureReason,
          date: new Date(p.createdAt).toLocaleDateString(),
        })),
        settings: {
          minimumTip: data.settings.minimumTip,
          tipsEnabled: data.settings.tipsEnabled,
        },
        payoutDestination: data.payoutDestination,
        openPayout: data.openPayout,
      });
    } catch (err: unknown) {
      publish({
        ...state,
        loading: false,
        error: errorMessage(err) || "We couldn't load your earnings. Please try again.",
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Read-only balance for small surfaces such as the profile tip button. */
export function useCreatorBalance() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    const sync = () => setSnapshot({ ...state });
    listeners.add(sync);
    sync();
    void refreshMonetization();
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return {
    loading: snapshot.loading,
    totalEarnings: snapshot.totalEarnings,
    pendingBalance: snapshot.pendingBalance,
  };
}

export function useMonetization() {
  const [snapshot, setSnapshot] = useState<MonetizationState>(state);

  useEffect(() => {
    const sync = () => setSnapshot({ ...state });
    listeners.add(sync);
    sync();
    void refreshMonetization();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  // Tips are created by the payment provider flow (checkout → confirmation),
  // never written directly from the browser.

  const requestPayout = useCallback(async (amount?: number, workspaceId?: string | null) => {
    const result = await requestPayoutApi({ data: { amount, workspaceId: workspaceId ?? null } });
    await refreshMonetization();
    return result;
  }, []);

  const saveTipSettings = useCallback(
    async (input: { minimumTip: number; tipsEnabled: boolean }) => {
      const result = await saveTipSettingsApi({ data: input });
      await refreshMonetization();
      return result;
    },
    [],
  );

  return {
    ...snapshot,
    requestPayout,
    saveTipSettings,
    refresh: refreshMonetization,
  };
}
