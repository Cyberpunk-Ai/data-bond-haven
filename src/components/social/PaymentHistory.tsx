import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Receipt } from "lucide-react";

import { listMyPayments } from "@/lib/paystack.functions";
import { cn } from "@/lib/utils";

interface PaymentRow {
  id: string;
  reference: string;
  plan: string;
  billing_cycle: string;
  amount: number;
  currency: string;
  status: string;
  paid_at: string | null;
  created_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  failed: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

export function PaymentHistory() {
  const fetchPayments = useServerFn(listMyPayments);
  const { data, isLoading } = useQuery({
    queryKey: ["my-payments"],
    queryFn: () => fetchPayments() as Promise<PaymentRow[]>,
  });

  const rows = data ?? [];

  return (
    <div className="rounded-3xl border border-border bg-card p-5 shadow-soft">
      <div className="flex items-center gap-2">
        <Receipt className="h-4 w-4 text-brand" />
        <h4 className="text-sm font-bold">Payment history</h4>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Every membership charge on your account.
      </p>

      <div className="mt-4 space-y-2">
        {isLoading && <div className="h-16 animate-pulse rounded-2xl bg-muted/40" />}

        {!isLoading && rows.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
            No payments yet. Charges appear here as soon as you upgrade.
          </p>
        )}

        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-border/50 bg-foreground/[0.03] px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-xs font-bold capitalize text-foreground">
                {row.plan} · {row.billing_cycle}
              </p>
              <p className="truncate text-[0.7rem] text-muted-foreground">
                {new Date(row.paid_at ?? row.created_at).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}{" "}
                · {row.reference.slice(0, 14)}…
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm font-black">
                {row.currency} {(row.amount / 100).toFixed(2)}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[0.65rem] font-bold capitalize",
                  STATUS_STYLES[row.status] ?? "bg-muted text-muted-foreground",
                )}
              >
                {row.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
