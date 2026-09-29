import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useServerFn } from "@tanstack/react-start";
import { X, Landmark, Smartphone, ShieldCheck, Loader2, Check } from "lucide-react";
import { toast } from "sonner";

import { savePayoutDestination } from "@/lib/payouts.functions";
import { friendlyError } from "@/lib/error-messages";
import { cn } from "@/lib/utils";

interface PayoutAccountModalProps {
  open: boolean;
  onClose: () => void;
  /** Set for a TEAM account; omit (or null) for the signed-in creator. */
  workspaceId?: string | null;
  /** Whose account this is — only drives copy ("your" vs "the team's"). */
  subject?: "me" | "team";
  /** Already-configured masked account, shown as a hint when changing. */
  existing?: { bankName: string | null; last4: string | null; currency: string | null } | null;
  onSaved?: (dest: { bankName: string; last4: string; currency: string }) => void;
}

type DestType = "nuban" | "mobile_money";

/**
 * The bank field is plain free text — there is no provider-curated list.
 * Whatever the person types is mapped to a provider code server side and then
 * validated by the provider itself (`/bank/resolve`) before it is ever stored,
 * so a typo can't become a payout destination.
 */
export function PayoutAccountModal({
  open,
  onClose,
  workspaceId,
  subject = "me",
  existing,
  onSaved,
}: PayoutAccountModalProps) {
  const saveDestination = useServerFn(savePayoutDestination);

  const [type, setType] = useState<DestType>("nuban");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBankName("");
    setAccountNumber("");
    setAccountName("");
  }, [open]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const isTeam = subject === "team";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = accountNumber.replace(/\s+/g, "");
    const finalBank = bankName.trim();
    if (!finalBank) {
      toast.error(
        isTeam
          ? "Enter the team's bank or mobile-money provider."
          : "Enter your bank or mobile-money provider.",
      );
      return;
    }
    if (!/^\+?[A-Za-z0-9]{6,20}$/.test(num)) {
      toast.error("Enter a valid account number (6–20 characters).");
      return;
    }
    if (accountName.trim().length < 2) {
      toast.error("Enter the account holder's full name.");
      return;
    }

    setSaving(true);
    try {
      const res = await saveDestination({
        data: {
          workspaceId: workspaceId ?? null,
          type,
          bank_code: finalBank,
          account_number: num,
          account_name: accountName.trim(),
        },
      });
      toast.success(isTeam ? "Team payout account saved." : "Payout account saved.");
      onSaved?.(res);
      onClose();
    } catch (err) {
      toast.error(friendlyError(err, "We couldn't verify that account."));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-3xl border border-border/80 bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 [scrollbar-width:thin]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="rounded-full bg-brand/15 p-2 text-brand">
              <Landmark className="h-5 w-5 stroke-[2.5]" />
            </div>
            <div>
              <h3 className="text-base font-extrabold tracking-tight">
                {existing?.last4
                  ? isTeam
                    ? "Change team payout account"
                    : "Change payout account"
                  : isTeam
                    ? "Team payout account"
                    : "Payout account"}
              </h3>
              <p className="text-xs text-muted-foreground">
                Where {isTeam ? "the team's" : "your"} withdrawals are sent.
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

        {existing?.last4 && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-border/60 bg-foreground/5 p-3 text-xs">
            <Check className="h-4 w-4 text-emerald-500" />
            <span className="text-muted-foreground">
              Currently{" "}
              <strong className="text-foreground">
                {existing.bankName ?? "saved account"} ••••{existing.last4}
              </strong>
              . Saving replaces it.
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <TypeButton
              active={type === "nuban"}
              icon={<Landmark className="h-4 w-4" />}
              label="Bank account"
              onClick={() => setType("nuban")}
            />
            <TypeButton
              active={type === "mobile_money"}
              icon={<Smartphone className="h-4 w-4" />}
              label="Mobile money"
              onClick={() => setType("mobile_money")}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {type === "nuban" ? "Bank name" : "Mobile money provider"}
            </label>
            <input
              type="text"
              autoComplete="off"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder={
                type === "nuban"
                  ? "Your bank's name, e.g. Equity Bank"
                  : "Your provider, e.g. M-PESA"
              }
              className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
            <p className="text-[10px] text-muted-foreground">
              Type the exact bank or mobile-money provider name from your statement — our payment
              provider verifies the account before anything is saved.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {type === "nuban" ? "Account number" : "Mobile money number"}
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder={type === "nuban" ? "0123456789" : "2547XXXXXXXX / your wallet number"}
              className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Account name
            </label>
            <input
              type="text"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder={isTeam ? "Registered business name" : "Name on the account"}
              className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
          </div>

          <div className="flex items-start gap-2 rounded-2xl bg-foreground/5 border border-border/60 p-3 text-[0.7rem] text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span>
              We verify this account with our payment provider, then keep it encrypted and use it
              only to pay out your withdrawals. Your earnings stay in the platform's account until
              you request a withdrawal.
            </span>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] rounded-full px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/40 transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-brand px-5 py-2 text-xs font-bold text-white shadow-soft hover:bg-brand/90 transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              <span>{saving ? "Verifying…" : "Save payout account"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function TypeButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border text-xs font-bold transition-all cursor-pointer",
        active
          ? "border-brand bg-brand/10 text-brand"
          : "border-border/80 bg-muted/40 text-muted-foreground hover:bg-muted",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
