import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Heart, DollarSign, Sparkles, Check, X, ShieldCheck } from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { useAuth } from "@/lib/auth-state";
import { currentUser } from "@/lib/profile-service";
import { useServerFn } from "@tanstack/react-start";
import { startTipCheckout } from "@/lib/paystack.functions";
import { openPaystackPayment } from "@/lib/paystack-checkout";
import { getMyTipEarnings, requestTipPayout } from "@/lib/tips.functions";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface TipModalProps {
  isOpen: boolean;
  onClose: () => void;
  recipient: {
    username: string;
    display_name: string;
    avatar_url?: string | null;
    plan?: string | null;
  };
  postId?: string;
  spaceId?: string;
}

const PRESET_AMOUNTS = [2, 5, 10, 25, 50];

export function TipModal({ isOpen, onClose, recipient, postId }: TipModalProps) {
  const { user } = useAuth();
  const activeUser = user || currentUser;
  const beginTip = useServerFn(startTipCheckout);
  const loadEarnings = useServerFn(getMyTipEarnings);
  const payout = useServerFn(requestTipPayout);
  const [earnings, setEarnings] = useState<{
    total: number;
    supporters: number;
    recent: { id: string; amount: number; message: string; created_at: string; sender: string }[];
  } | null>(null);

  const [selectedAmount, setSelectedAmount] = useState<number>(5);
  const [customAmount, setCustomAmount] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const isSelf = recipient.username === activeUser.username;

  useEffect(() => {
    if (!isOpen || !isSelf) return;
    loadEarnings({})
      .then((res: any) => setEarnings(res))
      .catch(() => setEarnings({ total: 0, supporters: 0, recent: [] }));
  }, [isOpen, isSelf]);

  if (!isOpen) return null;
  if (typeof document === "undefined") return null;

  const effectiveAmount = customAmount ? parseFloat(customAmount) || 0 : selectedAmount;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSelf) return;
    if (!(effectiveAmount > 0)) {
      toast.error("Please enter a valid tip amount");
      return;
    }

    setIsSubmitting(true);
    try {
      // The tip is only recorded once the payment provider confirms the charge.
      const res = (await beginTip({
        data: {
          recipientUsername: recipient.username,
          amount: effectiveAmount,
          message: message.trim() || undefined,
          postId: postId ?? null,
          origin: window.location.origin,
        },
      })) as { authorizationUrl?: string; reference?: string };

      if (!res?.authorizationUrl || !res.reference) {
        throw new Error("We couldn't open a secure checkout. Please try again.");
      }

      openPaystackPayment({
        authorizationUrl: res.authorizationUrl,
        reference: res.reference,
        onCancel: () => setIsSubmitting(false),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "We couldn't start that tip.");
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl border border-border/80 bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 [scrollbar-width:thin]"
        onClick={(e) => e.stopPropagation()}
      >
        {isSelf ? (
          /* Creator Self Tips & Earnings Dashboard */
          <div className="space-y-5">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="rounded-full bg-amber-500/15 p-2 text-amber-500">
                  <DollarSign className="h-5 w-5 stroke-[2.5]" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold tracking-tight">Your Creator Tips</h3>
                  <p className="text-xs text-muted-foreground">
                    Monetization & Supporter Dashboard
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-2xl bg-gradient-to-br from-amber-500/15 via-brand/10 to-transparent p-4 border border-amber-500/30 space-y-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <Sparkles className="h-3.5 w-3.5" /> Total Tips Balance
              </span>
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-black tracking-tight text-foreground">
                  ${(earnings?.total ?? 0).toFixed(2)}
                </span>
                <span className="text-xs font-bold text-emerald-500 bg-emerald-500/10 px-2.5 py-1 rounded-full">
                  100% Payout Rate
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {earnings === null
                  ? "Loading your supporters..."
                  : earnings.supporters === 0
                    ? "No tips yet. Share your profile so people can support you."
                    : `Directly received from ${earnings.supporters} community supporter${earnings.supporters === 1 ? "" : "s"}.`}
              </p>
            </div>

            <div className="space-y-2.5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Recent Supporters
              </h4>
              <div className="space-y-2">
                {(earnings?.recent ?? []).length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
                    Tips you receive will appear here.
                  </p>
                ) : (
                  (earnings?.recent ?? []).map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between rounded-2xl bg-foreground/[0.03] p-3 text-xs border border-border/50"
                    >
                      <div>
                        <p className="font-bold text-foreground">{s.sender}</p>
                        {s.message ? (
                          <p className="text-muted-foreground text-[11px] italic">"{s.message}"</p>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <p className="font-extrabold text-amber-500">${s.amount.toFixed(2)}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {new Date(s.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="pt-2">
              <button
                type="button"
                disabled={(earnings?.total ?? 0) < 10}
                onClick={async () => {
                  try {
                    const res = await payout({});
                    toast.success(
                      `Payout of $${res.amount.toFixed(2)} requested. Funds arrive in 1-2 business days.`,
                    );
                    onClose();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Payout request failed.");
                  }
                }}
                className="w-full rounded-2xl bg-gradient-to-r from-brand to-brand-pink py-3 text-sm font-extrabold text-white shadow-soft hover:shadow-glow transition-all cursor-pointer active:scale-98 disabled:opacity-50"
              >
                Request Payout ({"$"}
                {(earnings?.total ?? 0).toFixed(2)})
              </button>
            </div>
          </div>
        ) : isSuccess ? (
          <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-500 ring-8 ring-emerald-500/10">
              <Check className="h-8 w-8 stroke-[3]" />
            </div>
            <h3 className="text-xl font-extrabold">Tip Sent Successfully!</h3>
            <p className="text-sm text-muted-foreground">
              You sent <strong className="text-foreground">${effectiveAmount.toFixed(2)}</strong> to{" "}
              <strong className="text-foreground">@{recipient.username}</strong>.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <Avatar
                  name={recipient.display_name}
                  src={recipient.avatar_url}
                  className="h-12 w-12 text-sm ring-2 ring-brand/20"
                />
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold">{recipient.display_name}</span>
                    <UserBadge plan={recipient.plan} size="xs" />
                  </div>
                  <p className="text-xs text-muted-foreground">@{recipient.username}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-2xl bg-gradient-to-br from-brand/10 via-brand-pink/5 to-transparent p-4 border border-brand/20 text-center space-y-1">
              <span className="inline-flex items-center gap-1 text-xs font-extrabold uppercase tracking-wider text-brand">
                <Sparkles className="h-3.5 w-3.5" /> Support This Creator
              </span>
              <p className="text-xs text-muted-foreground">
                100% of your tip goes directly to the creator with zero hidden fees.
              </p>
            </div>

            {/* Amount Presets */}
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Select Tip Amount
              </label>
              <div className="grid grid-cols-5 gap-2">
                {PRESET_AMOUNTS.map((amt) => {
                  const isSelected = selectedAmount === amt && !customAmount;
                  return (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => {
                        setSelectedAmount(amt);
                        setCustomAmount("");
                      }}
                      className={cn(
                        "rounded-xl py-2.5 text-center text-sm font-extrabold transition-all cursor-pointer",
                        isSelected
                          ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                          : "border border-border/80 bg-muted/40 hover:bg-muted text-foreground",
                      )}
                    >
                      ${amt}
                    </button>
                  );
                })}
              </div>

              {/* Custom amount input */}
              <div className="relative mt-2">
                <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-muted-foreground">
                  <DollarSign className="h-4 w-4" />
                </div>
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="1000"
                  placeholder="Custom amount"
                  value={customAmount}
                  onChange={(e) => {
                    setCustomAmount(e.target.value);
                  }}
                  className="w-full rounded-2xl bg-muted/40 border border-border pl-9 pr-4 py-2.5 text-sm font-semibold outline-none focus:border-brand"
                />
              </div>
            </div>

            {/* Note message */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Message (Optional)
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Say something nice..."
                rows={2}
                maxLength={140}
                className="w-full rounded-2xl bg-muted/40 border border-border p-3 text-sm outline-none resize-none focus:border-brand"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-2xl border border-border py-3 text-sm font-bold hover:bg-muted transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || effectiveAmount <= 0}
                className="flex-[2] rounded-2xl bg-gradient-to-r from-brand to-brand-pink py-3 text-sm font-bold text-white shadow-soft hover:brightness-105 transition-all disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2"
              >
                <Heart className="h-4 w-4 fill-white" />
                <span>Send Tip ${effectiveAmount.toFixed(2)}</span>
              </button>
            </div>

            <div className="flex items-center justify-center gap-1.5 text-[0.72rem] text-muted-foreground pt-1">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
              <span>Secured by Paystack &bull; PCI-DSS Level 1 Encrypted</span>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
