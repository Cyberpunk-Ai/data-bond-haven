import React, { useEffect, useState } from "react";
import {
  DollarSign,
  Heart,
  RefreshCw,
  Wallet,
  ShieldCheck,
  Check,
  ArrowDownRight,
  AlertCircle,
} from "lucide-react";
import { useMonetization } from "@/lib/monetization-state";
import { usePlan } from "@/lib/plan-state";
import { Avatar } from "@/components/social/Avatar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function statusTone(status: string) {
  if (status === "paid") return "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400";
  if (status === "failed" || status === "declined" || status === "reversed")
    return "bg-rose-500/20 text-rose-600 dark:text-rose-400";
  return "bg-amber-500/20 text-amber-600 dark:text-amber-400";
}

export function MonetizationHub() {
  const { isPro } = usePlan();
  const {
    loading,
    error,
    totalEarnings,
    pendingBalance,
    currency,
    minimumPayout,
    tipsReceived,
    payouts,
    settings,
    requestPayout,
    saveTipSettings,
    refresh,
  } = useMonetization();

  const [isPayoutModalOpen, setIsPayoutModalOpen] = useState(false);
  const [payoutProcessing, setPayoutProcessing] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");
  const [withdrawNote, setWithdrawNote] = useState("");

  const [minTipDraft, setMinTipDraft] = useState<number>(settings.minimumTip || 1);
  const [tipsEnabledDraft, setTipsEnabledDraft] = useState<boolean>(settings.tipsEnabled ?? true);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    setMinTipDraft(settings.minimumTip || 1);
    setTipsEnabledDraft(settings.tipsEnabled ?? true);
  }, [settings.minimumTip, settings.tipsEnabled]);

  const platformFee = isPro ? "0% (Keep 100%)" : "5% platform fee";
  const pendingRequest = payouts.find((p) => p.status === "pending" || p.status === "reviewing");

  const handlePayoutSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = withdrawAmount ? Number(withdrawAmount) : undefined;
    if (amt !== undefined && (isNaN(amt) || amt <= 0 || amt > pendingBalance)) {
      toast.error("Please enter a valid withdrawal amount.");
      return;
    }

    setPayoutProcessing(true);
    try {
      const record = await requestPayout(amt, withdrawNote.trim() || undefined);
      setIsPayoutModalOpen(false);
      setWithdrawAmount("");
      setWithdrawNote("");
      toast.success(
        `Withdrawal request for ${currency} ${record.amount.toFixed(2)} sent for review.`,
      );
    } catch (err: any) {
      toast.error(err?.message || "We couldn't send that withdrawal request.");
    } finally {
      setPayoutProcessing(false);
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await saveTipSettings({ minimumTip: minTipDraft, tipsEnabled: tipsEnabledDraft });
      toast.success("Tip settings saved.");
    } catch (err: any) {
      toast.error(err?.message || "We couldn't save those settings.");
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-black">Earnings & withdrawals</h2>
          <p className="text-xs text-muted-foreground">
            Tips from your supporters, and withdrawals you can request any time.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => refresh()}
            className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted/40 transition-all cursor-pointer"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            <span>Refresh</span>
          </button>

          <button
            onClick={() => {
              setWithdrawAmount(pendingBalance.toString());
              setIsPayoutModalOpen(true);
            }}
            disabled={pendingBalance < minimumPayout || !!pendingRequest}
            className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-600 to-teal-500 px-4 py-2 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all disabled:opacity-50 cursor-pointer"
          >
            <DollarSign className="h-3.5 w-3.5" />
            <span>Request withdrawal</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4 text-xs text-rose-600 dark:text-rose-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => refresh()} className="ml-auto font-bold underline cursor-pointer">
            Try again
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-2 shadow-soft">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Total earnings
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-black">
              {currency} {totalEarnings.toFixed(2)}
            </span>
            <span className="text-xs font-bold text-emerald-500">All-time</span>
          </div>
          <p className="text-[0.7rem] text-muted-foreground">Every tip you have received</p>
        </div>

        <div className="rounded-3xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-2 shadow-soft">
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
            Available balance
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-black text-emerald-700 dark:text-emerald-300">
              {currency} {pendingBalance.toFixed(2)}
            </span>
          </div>
          <p className="text-[0.7rem] text-muted-foreground">
            {pendingRequest
              ? `A withdrawal of ${currency} ${pendingRequest.amount.toFixed(2)} is waiting for review`
              : `Smallest withdrawal: ${currency} ${minimumPayout.toFixed(2)}`}
          </p>
        </div>

        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-2 shadow-soft">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Platform take rate
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl sm:text-2xl font-black text-foreground">{platformFee}</span>
          </div>
          <p className="text-[0.7rem] text-muted-foreground">
            {isPro ? "Pro 0% fee active" : "Upgrade to Pro for 0% fee"}
          </p>
        </div>
      </div>

      <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
        <div className="flex items-start gap-2 rounded-2xl bg-foreground/5 border border-border/60 p-3.5 text-xs">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          <p className="text-muted-foreground">
            For your safety we never ask for or store your bank, mobile money or card details.
            Request a withdrawal here and our team arranges the payment with you directly.
          </p>
        </div>

        <div className="border-t border-border/60 pt-4 space-y-4">
          <h3 className="text-sm font-black">Tip settings</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-foreground">
                Minimum tip amount ({currency})
              </label>
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={minTipDraft}
                onChange={(e) => setMinTipDraft(Number(e.target.value))}
                className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            </div>

            <div className="space-y-1.5 flex flex-col justify-end">
              <label className="flex min-h-[44px] items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tipsEnabledDraft}
                  onChange={(e) => setTipsEnabledDraft(e.target.checked)}
                  className="rounded border-border text-brand focus:ring-brand"
                />
                <span className="text-xs font-bold text-foreground">
                  Let people tip me on my profile and posts
                </span>
              </label>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveSettings}
              disabled={savingSettings}
              className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-brand px-5 py-2 text-xs font-bold text-white shadow-soft hover:bg-brand/90 transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {savingSettings ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              <span>{savingSettings ? "Saving…" : "Save tip settings"}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-4 shadow-soft">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <h3 className="text-sm font-black flex items-center gap-2">
              <Heart className="h-4 w-4 text-rose-500 fill-rose-500" />
              Tips received ({tipsReceived.length})
            </h3>
          </div>

          <div className="space-y-2.5 max-h-[360px] overflow-y-auto [scrollbar-width:thin]">
            {loading ? (
              <div className="space-y-2.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-2xl bg-foreground/5" />
                ))}
              </div>
            ) : tipsReceived.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                <Heart className="h-6 w-6 mx-auto mb-2 opacity-30 text-rose-500" />
                No tips yet. Share a post — supporters can tip you from your profile or any post.
              </div>
            ) : (
              tipsReceived.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between p-3 rounded-2xl bg-foreground/5 hover:bg-foreground/10 transition-all text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar
                      name={t.senderName}
                      src={t.senderAvatar}
                      className="h-8 w-8 text-xs shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="font-bold truncate">{t.senderName}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{t.timestamp}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="font-black text-emerald-600 dark:text-emerald-400">
                      +{currency} {t.amount.toFixed(2)}
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

        <div className="rounded-3xl border border-border/80 bg-card p-5 space-y-4 shadow-soft">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <h3 className="text-sm font-black flex items-center gap-2">
              <ArrowDownRight className="h-4 w-4 text-emerald-500" />
              Withdrawals ({payouts.length})
            </h3>
          </div>

          <div className="space-y-2.5 max-h-[360px] overflow-y-auto [scrollbar-width:thin]">
            {loading ? (
              <div className="space-y-2.5">
                {[0, 1].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-2xl bg-foreground/5" />
                ))}
              </div>
            ) : payouts.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                <Wallet className="h-6 w-6 mx-auto mb-2 opacity-30" />
                No withdrawals yet.
              </div>
            ) : (
              payouts.map((p) => (
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
                      {p.status === "pending" ? "In review" : p.status}
                    </span>
                    <p className="mt-1 text-[10px] text-muted-foreground">{p.date}</p>
                    {p.failureReason && (
                      <p className="text-[10px] text-rose-500">{p.failureReason}</p>
                    )}
                  </div>
                  <span className="shrink-0 font-black">
                    {currency} {p.amount.toFixed(2)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {isPayoutModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-xl space-y-5">
            <div>
              <h3 className="text-lg font-black">Request a withdrawal</h3>
              <p className="text-xs text-muted-foreground">
                We review requests and arrange payment with you — no account details needed here.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-foreground/5 border border-border/60 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Available:</span>
                <span className="font-black text-emerald-600 dark:text-emerald-400">
                  {currency} {pendingBalance.toFixed(2)}
                </span>
              </div>
            </div>

            <form onSubmit={handlePayoutSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-foreground">Amount ({currency})</label>
                <input
                  type="number"
                  min={minimumPayout}
                  max={pendingBalance}
                  step="0.01"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm outline-none focus:border-brand"
                  placeholder={pendingBalance.toFixed(2)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-foreground">
                  Anything we should know? (optional)
                </label>
                <textarea
                  value={withdrawNote}
                  onChange={(e) => setWithdrawNote(e.target.value)}
                  rows={2}
                  maxLength={280}
                  className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm outline-none focus:border-brand"
                  placeholder="Preferred payment timing, for example"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsPayoutModalOpen(false)}
                  className="min-h-[40px] rounded-full px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/40 transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={payoutProcessing || pendingBalance < minimumPayout}
                  className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 px-5 py-2 text-xs font-bold text-white shadow-soft transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  {payoutProcessing ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  <span>{payoutProcessing ? "Sending…" : "Send request"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
