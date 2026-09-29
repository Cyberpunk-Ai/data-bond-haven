import React, { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  DollarSign,
  Heart,
  RefreshCw,
  Wallet,
  ShieldCheck,
  Check,
  ArrowDownRight,
  AlertCircle,
  Landmark,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import { getWorkspaceEarnings, requestPayout } from "@/lib/payouts.functions";
import { usd } from "@/lib/formatters";
import { PayoutAccountModal } from "@/components/social/PayoutAccountModal";
import { Avatar } from "@/components/social/Avatar";
import { friendlyError } from "@/lib/error-messages";
import { cn } from "@/lib/utils";

interface Destination {
  configured: boolean;
  bankName: string | null;
  last4: string | null;
  currency: string | null;
}
interface TipRow {
  id: string;
  amount: number;
  message: string;
  createdAt: string;
  senderName: string;
  senderUsername: string;
  senderAvatar?: string;
}
interface PayoutRow {
  id: string;
  amount: number;
  status: string;
  failureReason: string | null;
  createdAt: string;
}
interface TeamEarnings {
  workspaceId: string;
  workspaceName: string;
  totalEarnings: number;
  pendingBalance: number;
  currency: string;
  minimumPayout: number;
  /** Withdrawal-time take rate for the team (follows the owner's plan). */
  feePercent: number;
  settlement: { currency: string; pendingBalance: number; rate: number } | null;
  payoutDestination: Destination;
  openPayout: { id: string; status: string } | null;
  tips: TipRow[];
  payouts: PayoutRow[];
}

function statusTone(status: string) {
  if (status === "paid") return "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400";
  if (status === "failed" || status === "declined" || status === "reversed")
    return "bg-rose-500/20 text-rose-600 dark:text-rose-400";
  return "bg-amber-500/20 text-amber-600 dark:text-amber-400";
}

/**
 * Team (workspace) earnings hub — rendered only for the workspace Owner (the
 * backing RPC and every mutation are Owner-gated server-side). Mirrors the
 * personal MonetizationHub but draws on the team ledger: withdrawals go to the
 * team's own encrypted payout token and are restricted to the Owner.
 */
export function WorkspaceMonetization({ workspaceId }: { workspaceId: string }) {
  const loadEarnings = useServerFn(getWorkspaceEarnings);
  const withdraw = useServerFn(requestPayout);

  const [data, setData] = useState<TeamEarnings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [isWithdrawOpen, setIsWithdrawOpen] = useState(false);
  const [amount, setAmount] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    loadEarnings({ data: { workspaceId } })
      .then((res) => setData(res as TeamEarnings))
      .catch((err) => setError(friendlyError(err, "We couldn't load the team's earnings.")))
      .finally(() => setLoading(false));
  }, [workspaceId, loadEarnings]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading && !data) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-3xl bg-foreground/5" />
        ))}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4 text-xs text-rose-600 dark:text-rose-400">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{error}</span>
        <button onClick={refresh} className="ml-auto font-bold underline cursor-pointer">
          Try again
        </button>
      </div>
    );
  }

  if (!data) return null;

  const settlement = data.settlement;
  const hasDestination = data.payoutDestination.configured;
  const inFlight = !!data.openPayout;
  const canWithdraw = data.pendingBalance >= data.minimumPayout && hasDestination && !inFlight;

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = amount ? Number(amount) : undefined;
    if (amt !== undefined && (isNaN(amt) || amt <= 0 || amt > data.pendingBalance)) {
      toast.error("Enter a valid amount within the team's balance.");
      return;
    }
    setBusy(true);
    try {
      const res = await withdraw({ data: { amount: amt, workspaceId } });
      setIsWithdrawOpen(false);
      setAmount("");
      toast.success(
        `Team withdrawal requested — ${usd(res.netUsd ?? res.amount)}${
          res.feeUsd != null ? ` (after a ${usd(res.feeUsd)} fee)` : ""
        } will reach the team's account after review.`,
      );
      refresh();
    } catch (err) {
      toast.error(friendlyError(err, "We couldn't send that team withdrawal."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black">Team earnings & withdrawals</h3>
          <p className="text-xs text-muted-foreground">
            Tips sent to {data.workspaceName}, and payouts only you as owner can request.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted/40 transition-all cursor-pointer"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => {
              setAmount(data.pendingBalance.toString());
              setIsWithdrawOpen(true);
            }}
            disabled={!canWithdraw}
            title={!hasDestination ? "Add a payout account first" : undefined}
            className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-600 to-teal-500 px-4 py-2 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all disabled:opacity-50 cursor-pointer"
          >
            <DollarSign className="h-3.5 w-3.5" />
            <span>{inFlight ? "Withdrawal in progress" : "Withdraw"}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-1.5 shadow-soft">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Total earned
          </span>
          <span className="block text-2xl font-black">{usd(data.totalEarnings)}</span>
        </div>
        <div className="rounded-3xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-1.5 shadow-soft">
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
            Available balance
          </span>
          <span className="block text-2xl font-black text-emerald-700 dark:text-emerald-300">
            {usd(data.pendingBalance)}
          </span>
          <p className="text-[0.7rem] text-muted-foreground">
            Smallest withdrawal: {usd(data.minimumPayout)} · {data.feePercent}% team fee
            {settlement ? ` · paid out in ${settlement.currency}` : ""}
          </p>
        </div>
      </div>

      <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-4 shadow-soft">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="rounded-full bg-brand/10 p-2.5 text-brand shrink-0">
              <Landmark className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-black">Team payout account</h4>
              <p className="text-xs text-muted-foreground truncate">
                {hasDestination
                  ? `${data.payoutDestination.bankName ?? "Saved account"} ••••${data.payoutDestination.last4 ?? ""}`
                  : "Add the account the team's withdrawals go to."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsAccountModalOpen(true)}
            className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-soft hover:bg-brand/90 transition-all cursor-pointer"
          >
            {hasDestination ? (
              <span>Change</span>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                <span>Add account</span>
              </>
            )}
          </button>
        </div>
        <div className="flex items-start gap-2 rounded-2xl bg-foreground/5 border border-border/60 p-3.5 text-xs">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          <p className="text-muted-foreground">
            Only the team owner can set the payout account or withdraw. We verify the account once,
            then store only an encrypted payout token and the last four digits.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-3 shadow-soft">
          <h4 className="text-sm font-black flex items-center gap-2 border-b border-border/60 pb-3">
            <Heart className="h-4 w-4 text-rose-500 fill-rose-500" />
            Tips received ({data.tips.length})
          </h4>
          <div className="space-y-2.5 max-h-[320px] overflow-y-auto [scrollbar-width:thin]">
            {data.tips.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No team tips yet. Supporters can tip {data.workspaceName} from any team post.
              </div>
            ) : (
              data.tips.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between p-3 rounded-2xl bg-foreground/5 text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar
                      name={t.senderName}
                      src={t.senderAvatar}
                      className="h-8 w-8 text-xs shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="font-bold truncate">{t.senderName}</p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {new Date(t.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="font-black text-emerald-600 dark:text-emerald-400">
                      +{usd(t.amount)}
                    </span>
                    {t.message && (
                      <p
                        className="text-[10px] text-muted-foreground italic truncate max-w-[140px]"
                        title={t.message}
                      >
                        {t.message}
                      </p>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-3 shadow-soft">
          <h4 className="text-sm font-black flex items-center gap-2 border-b border-border/60 pb-3">
            <ArrowDownRight className="h-4 w-4 text-emerald-500" />
            Withdrawals ({data.payouts.length})
          </h4>
          <div className="space-y-2.5 max-h-[320px] overflow-y-auto [scrollbar-width:thin]">
            {data.payouts.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                <Wallet className="h-6 w-6 mx-auto mb-2 opacity-30" />
                No withdrawals yet.
              </div>
            ) : (
              data.payouts.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between p-3 rounded-2xl bg-foreground/5 text-xs"
                >
                  <div className="min-w-0">
                    <span
                      className={cn(
                        "px-2 py-0.5 rounded-full text-[10px] font-extrabold capitalize",
                        statusTone(p.status),
                      )}
                    >
                      {p.status}
                    </span>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {new Date(p.createdAt).toLocaleDateString()}
                    </p>
                    {p.failureReason && (
                      <p className="text-[10px] text-rose-500">{p.failureReason}</p>
                    )}
                  </div>
                  <span className="shrink-0 font-black">{usd(p.amount)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {isWithdrawOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto custom-scrollbar rounded-3xl border border-border bg-card p-6 shadow-xl space-y-5">
            <div>
              <h3 className="text-lg font-black">Withdraw team earnings</h3>
              <p className="text-xs text-muted-foreground">
                Sent automatically to the team's payout account
                {hasDestination
                  ? ` (${data.payoutDestination.bankName ?? "account"} ••••${data.payoutDestination.last4 ?? ""})`
                  : ""}
                .
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-foreground/5 border border-border/60 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Available:</span>
                <span className="font-black text-emerald-600 dark:text-emerald-400">
                  {usd(data.pendingBalance)}
                </span>
              </div>
            </div>
            <form onSubmit={handleWithdraw} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-foreground">Amount (USD)</label>
                <input
                  type="number"
                  min={data.minimumPayout}
                  max={data.pendingBalance}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm outline-none focus:border-brand"
                  placeholder={data.pendingBalance.toFixed(2)}
                  required
                />
              </div>
              {(() => {
                const gross = Math.min(Math.max(Number(amount) || 0, 0), data.pendingBalance);
                if (!(gross > 0)) return null;
                const fee = Math.round(gross * (data.feePercent / 100) * 100) / 100;
                return (
                  <div className="space-y-1.5 rounded-2xl bg-foreground/5 border border-border/60 p-3.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Platform fee ({data.feePercent}%)
                      </span>
                      <span className="font-bold text-rose-500">-{usd(fee)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-bold">Team receives</span>
                      <span className="font-black text-emerald-600 dark:text-emerald-400">
                        {usd(Math.max(gross - fee, 0))}
                      </span>
                    </div>
                  </div>
                );
              })()}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsWithdrawOpen(false)}
                  className="min-h-[40px] rounded-full px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/40 transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 px-5 py-2 text-xs font-bold text-white shadow-soft transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busy ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  <span>{busy ? "Sending…" : "Withdraw now"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <PayoutAccountModal
        open={isAccountModalOpen}
        onClose={() => setIsAccountModalOpen(false)}
        workspaceId={workspaceId}
        subject="team"
        existing={hasDestination ? data.payoutDestination : null}
        onSaved={() => refresh()}
      />
    </div>
  );
}
