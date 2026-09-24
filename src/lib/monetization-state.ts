/**
 * Creator earnings state. Everything comes from the backend — balances are
 * derived from real recorded tips and real withdrawal requests. The app never
 * asks for or stores bank or mobile-money details.
 */
import { useCallback, useEffect, useState } from "react";

import { signedInProfileId } from "@/lib/remote-store";
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

interface MonetizationState {
  loading: boolean;
  error: string | null;
  totalEarnings: number;
  pendingBalance: number;
  currency: string;
  minimumPayout: number;
  tipsReceived: TipRecord[];
  payouts: PayoutRecord[];
  settings: MonetizationSettings;
}

const EMPTY: MonetizationState = {
  loading: true,
  error: null,
  totalEarnings: 0,
  pendingBalance: 0,
  currency: "KES",
  minimumPayout: 10,
  tipsReceived: [],
  payouts: [],
  settings: { minimumTip: 1, tipsEnabled: true },
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
      });
    } catch (err: any) {
      publish({
        ...state,
        loading: false,
        error: err?.message || "We couldn't load your earnings. Please try again.",
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

  const requestPayout = useCallback(async (amount?: number, note?: string) => {
    const result = await requestPayoutApi({ data: { amount, note } });
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
