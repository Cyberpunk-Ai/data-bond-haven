import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, RefreshCw, Wallet, X } from "lucide-react";
import { toast } from "sonner";

import { listPayoutRequests, reviewPayout } from "@/lib/payouts.functions";
import { cn } from "@/lib/utils";

type Request = Awaited<ReturnType<typeof listPayoutRequests>>[number];

function tone(status: string) {
  if (status === "paid") return "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400";
  if (status === "declined" || status === "failed" || status === "reversed")
    return "bg-rose-500/20 text-rose-600 dark:text-rose-400";
  return "bg-amber-500/20 text-amber-600 dark:text-amber-400";
}

export function AdminPayoutsTab() {
  const [rows, setRows] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listPayoutRequests());
    } catch (err: any) {
      setError(err?.message || "We couldn't load withdrawal requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (row: Request, decision: "paid" | "declined") => {
    const note =
      decision === "declined"
        ? (window.prompt("Reason for declining (the creator will see this):") ?? "").trim()
        : (window.prompt("Optional note (e.g. how it was paid):") ?? "").trim();
    if (decision === "declined" && !note) {
      toast.error("Please give a reason so the creator knows what happened.");
      return;
    }

    setBusyId(row.id);
    try {
      await reviewPayout({ data: { id: row.id, decision, note } });
      toast.success(
        decision === "paid"
          ? "Marked as paid out."
          : "Withdrawal declined and the creator notified.",
      );
      await load();
    } catch (err: any) {
      toast.error(err?.message || "We couldn't update that withdrawal.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black">Withdrawal requests</h2>
          <p className="text-xs text-muted-foreground">
            Creators never share account details in the app — arrange payment with them directly,
            then record the outcome here.
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

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl bg-foreground/5" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-3xl border border-border/80 bg-card p-10 text-center text-sm text-muted-foreground">
          <Wallet className="mx-auto mb-2 h-6 w-6 opacity-30" />
          No withdrawal requests yet.
        </div>
      ) : (
        <div className="space-y-2.5">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card p-4"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-black">
                    {r.currency} {r.amount.toFixed(2)}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-extrabold capitalize",
                      tone(r.status),
                    )}
                  >
                    {r.status === "pending" ? "In review" : r.status}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {r.creatorName} @{r.creatorUsername} · {new Date(r.createdAt).toLocaleString()}
                </p>
                {r.note && <p className="text-xs italic text-muted-foreground">“{r.note}”</p>}
                {r.failureReason && <p className="text-xs text-rose-500">{r.failureReason}</p>}
              </div>

              {r.status === "pending" || r.status === "reviewing" ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void decide(r, "paid")}
                    disabled={busyId === r.id}
                    className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 transition-colors disabled:opacity-60 cursor-pointer"
                  >
                    <Check className="h-3.5 w-3.5" /> Mark paid
                  </button>
                  <button
                    onClick={() => void decide(r, "declined")}
                    disabled={busyId === r.id}
                    className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-bold text-muted-foreground hover:bg-foreground/5 transition-colors disabled:opacity-60 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" /> Decline
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
