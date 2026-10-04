import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  RefreshCw,
  Wallet,
  X,
  Eye,
  EyeOff,
  ArrowDownLeft,
  ArrowUpRight,
  Crown,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";

import {
  listPayoutRequests,
  reviewPayout,
  getPayoutAccount,
  listPaymentActivity,
} from "@/lib/payouts.functions";
import { usd } from "@/lib/formatters";
import { cn } from "@/lib/utils";

type Request = Awaited<ReturnType<typeof listPayoutRequests>>[number];
type Activity = Awaited<ReturnType<typeof listPaymentActivity>>[number];
type Account = Awaited<ReturnType<typeof getPayoutAccount>>;

function tone(status: string) {
  if (status === "paid") return "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400";
  if (status === "declined" || status === "failed" || status === "reversed")
    return "bg-rose-500/20 text-rose-600 dark:text-rose-400";
  return "bg-amber-500/20 text-amber-600 dark:text-amber-400";
}

const ACTIVITY_META: Record<
  Activity["kind"],
  { label: string; icon: typeof ArrowDownLeft; tint: string }
> = {
  tip: { label: "Tip", icon: ArrowDownLeft, tint: "text-emerald-500 bg-emerald-500/10" },
  plan: { label: "Plan", icon: Crown, tint: "text-violet-500 bg-violet-500/10" },
  withdrawal: { label: "Withdrawal", icon: ArrowUpRight, tint: "text-amber-500 bg-amber-500/10" },
};

export function AdminPayoutsTab() {
  const [rows, setRows] = useState<Request[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, Account | "loading">>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [requests, feed] = await Promise.all([listPayoutRequests(), listPaymentActivity()]);
      setRows(requests);
      setActivity(feed);
    } catch (err: unknown) {
      setError(friendlyError(err, "We couldn't load payment activity."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reveal = async (row: Request) => {
    if (revealed[row.id] && revealed[row.id] !== "loading") {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      return;
    }
    setRevealed((prev) => ({ ...prev, [row.id]: "loading" }));
    try {
      const acct = await getPayoutAccount({ data: { id: row.id } });
      setRevealed((prev) => ({ ...prev, [row.id]: acct }));
    } catch (err: unknown) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      toast.error(friendlyError(err, "We couldn't reveal that account."));
    }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success("Copied."),
      () => toast.error("Copy failed — select it manually."),
    );
  };

  const decide = async (row: Request, decision: "paid" | "declined") => {
    const note =
      decision === "declined"
        ? (window.prompt("Reason for declining (the creator will see this):") ?? "").trim()
        : (window.prompt("Optional note (e.g. transfer reference):") ?? "").trim();
    if (decision === "declined" && !note) {
      toast.error("Please give a reason so the creator knows what happened.");
      return;
    }

    setBusyId(row.id);
    try {
      await reviewPayout({ data: { id: row.id, decision, note } });
      toast.success(
        decision === "paid"
          ? "Marked as paid out and the creator notified."
          : "Withdrawal declined, the amount returned, and the creator notified.",
      );
      await load();
    } catch (err: unknown) {
      toast.error(friendlyError(err, "We couldn't update that withdrawal."));
    } finally {
      setBusyId(null);
    }
  };

  const pending = rows.filter((r) => r.status === "pending" || r.status === "reviewing");
  const handled = rows.filter((r) => !["pending", "reviewing"].includes(r.status));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black">Payments</h2>
          <p className="text-xs text-muted-foreground">
            Review withdrawal requests and pay each creator directly using the account on file, then
            confirm or decline. Every payment event on the platform is on this page.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-foreground/5 transition-colors cursor-pointer"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4 text-xs text-rose-600 dark:text-rose-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button
            onClick={() => void load()}
            className="ml-auto font-bold underline cursor-pointer"
          >
            Try again
          </button>
        </div>
      )}

      {/* ---- Withdrawal requests awaiting action ---- */}
      <section className="space-y-3">
        <h3 className="text-sm font-black">
          Withdrawal requests{" "}
          <span className="text-muted-foreground font-semibold">({pending.length} to review)</span>
        </h3>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-foreground/5" />
            ))}
          </div>
        ) : pending.length === 0 ? (
          <div className="rounded-3xl border border-border/80 bg-card p-10 text-center text-sm text-muted-foreground">
            <Wallet className="mx-auto mb-2 h-6 w-6 opacity-30" />
            No withdrawals waiting for review.
          </div>
        ) : (
          <div className="space-y-2.5">
            {pending.map((r) => (
              <RequestCard
                key={r.id}
                row={r}
                busy={busyId === r.id}
                account={revealed[r.id]}
                onReveal={() => void reveal(r)}
                onCopy={copy}
                onDecide={decide}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---- Recently handled ---- */}
      {handled.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-black text-muted-foreground">Recently handled</h3>
          <div className="space-y-2">
            {handled.slice(0, 12).map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card/60 p-3.5"
              >
                <div className="min-w-0 flex items-center gap-2">
                  <span className="text-sm font-bold">{usd(r.amount)}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-extrabold capitalize",
                      tone(r.status),
                    )}
                  >
                    {r.status}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {r.creatorName} @{r.creatorUsername}
                    {r.workspaceName ? ` · ${r.workspaceName} (team)` : ""} ·{" "}
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                {r.failureReason && <p className="text-xs text-rose-500">{r.failureReason}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Unified payment activity ---- */}
      <section className="space-y-3">
        <h3 className="text-sm font-black">All payment activity</h3>
        <div className="overflow-hidden rounded-3xl border border-border/80 bg-card">
          {activity.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No payment activity yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {activity.map((a) => {
                const meta = ACTIVITY_META[a.kind];
                const Icon = meta.icon;
                return (
                  <li key={`${a.kind}-${a.id}`} className="flex items-center gap-3 p-3.5">
                    <span
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                        meta.tint,
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{a.summary}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {meta.label} · {new Date(a.createdAt).toLocaleString()}
                        {a.status && a.status !== "settled" && a.status !== "success" ? (
                          <span className="capitalize"> · {a.status}</span>
                        ) : null}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-black tabular-nums">
                      {usd(a.amountUsd)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function RequestCard({
  row,
  busy,
  account,
  onReveal,
  onCopy,
  onDecide,
}: {
  row: Request;
  busy: boolean;
  account: Account | "loading" | undefined;
  onReveal: () => void;
  onCopy: (text: string) => void;
  onDecide: (row: Request, decision: "paid" | "declined") => void;
}) {
  const loaded = account && account !== "loading" ? account : null;
  const masked = [row.bankName ?? "Account", row.accountLast4 ? `••••${row.accountLast4}` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="rounded-2xl border border-border/80 bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span
              className="text-sm font-black"
              title={`Net transfer settles as ${row.settlementAmount.toFixed(2)} ${row.currency}`}
            >
              {usd(row.amount)}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-extrabold capitalize",
                tone(row.status),
              )}
            >
              In review
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {row.creatorName} @{row.creatorUsername}
            {row.workspaceName ? ` · ${row.workspaceName} (team)` : ""} ·{" "}
            {new Date(row.createdAt).toLocaleString()}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {row.feeUsd > 0
              ? `${usd(row.netUsd)} to the creator after a ${usd(row.feeUsd)} platform fee · ${row.currency}`
              : `${usd(row.amount)} · ${row.currency}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void onDecide(row, "paid")}
            disabled={busy}
            className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 transition-colors disabled:opacity-60 cursor-pointer"
          >
            <Check className="h-3.5 w-3.5" /> Mark paid
          </button>
          <button
            onClick={() => void onDecide(row, "declined")}
            disabled={busy}
            className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-bold text-muted-foreground hover:bg-foreground/5 transition-colors disabled:opacity-60 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" /> Decline
          </button>
        </div>
      </div>

      {/* Receiving account — decrypt on demand (staff action is audit-logged). */}
      <div className="rounded-xl border border-border/60 bg-foreground/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Receiving account {account ? "" : `· ${masked}`}
          </span>
          <button
            onClick={onReveal}
            disabled={account === "loading" || !row.hasDestination}
            className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-bold text-muted-foreground hover:bg-card transition-colors disabled:opacity-50 cursor-pointer"
            title={
              row.hasDestination
                ? "Decrypt to pay this account"
                : "No stored account for this request"
            }
          >
            {account === "loading" ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : loaded ? (
              <EyeOff className="h-3 w-3" />
            ) : (
              <Eye className="h-3 w-3" />
            )}
            {loaded ? "Hide" : "View account"}
          </button>
        </div>

        {loaded && !loaded.available && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            {loaded.reason ?? "No decryptable account stored for this request."}
          </p>
        )}

        {loaded && loaded.available && (
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            <Field label="Holder" value={loaded.accountName} onCopy={onCopy} />
            <Field
              label={loaded.channel === "mobile_money" ? "Mobile money" : "Bank"}
              value={loaded.bankName}
              onCopy={onCopy}
            />
            <Field label="Account" value={loaded.accountNumber} onCopy={onCopy} mono />
            <Field
              label="Pay (net)"
              value={`${row.settlementAmount.toFixed(2)} ${row.currency}`}
              onCopy={onCopy}
              mono
            />
            {loaded.bankCode ? (
              <Field label="Provider code" value={loaded.bankCode} onCopy={onCopy} mono />
            ) : null}
          </dl>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onCopy,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  onCopy: (text: string) => void;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1.5">
        <span className={cn("font-bold text-foreground", mono && "tabular-nums")}>{value}</span>
        <button
          onClick={() => onCopy(value)}
          className="rounded p-1 text-muted-foreground hover:text-foreground cursor-pointer"
          title="Copy"
        >
          <Copy className="h-3 w-3" />
        </button>
      </dd>
    </div>
  );
}
