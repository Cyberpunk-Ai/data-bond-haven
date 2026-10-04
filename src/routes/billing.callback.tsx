import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { NOINDEX_META, ORG_NAME, brandedTitle } from "@/lib/seo";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { confirmPaystackPayment } from "@/lib/paystack.functions";
import { announceSpaceTip } from "@/lib/api-client";
import { claimPendingTip } from "@/lib/pending-tip";
import { usd } from "@/lib/formatters";

export const Route = createFileRoute("/billing/callback")({
  head: () => ({
    meta: [
      { title: brandedTitle("Confirming your payment") },
      {
        name: "description",
        content: `We're confirming your ${ORG_NAME} membership payment and activating your plan.`,
      },
      { property: "og:title", content: brandedTitle("Confirming your payment") },
      {
        property: "og:description",
        content: `We're confirming your ${ORG_NAME} membership payment and activating your plan.`,
      },
      ...NOINDEX_META,
    ],
  }),
  component: BillingCallback,
});

function BillingCallback() {
  const confirm = useServerFn(confirmPaystackPayment);
  const router = useRouter();
  const [state, setState] = useState<"loading" | "success" | "failed">("loading");
  const [message, setMessage] = useState("Confirming your payment...");
  const [plan, setPlan] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get("reference") ?? params.get("trxref");
    if (!reference) {
      setState("failed");
      setMessage("We couldn't find a payment to confirm.");
      return;
    }
    confirm({ data: { reference } })
      .then((res: any) => {
        if (res.status === "success") {
          setPlan(res.kind === "tip" ? "tip" : res.plan);
          setState("success");
          setMessage(
            res.kind === "tip"
              ? `Tip of ${usd(Number(res.amount ?? 0))} sent successfully — the creator was notified.`
              : "Payment confirmed. Your new plan is active.",
          );
          router.invalidate();

          // A tip paid from inside a live Space. Checkout unloaded that page, so
          // the room is long gone here — but the people still sitting in it
          // should hear about it. Claiming consumes the note, which is what makes
          // a refresh on this page (or a second tab) announce exactly once. The
          // amount comes from the verified payment, not from the note.
          //
          // Nothing about this is allowed to fail the payment: the charge is
          // settled, so a room that cannot be told (closed, or no longer a
          // member) is a silent miss rather than an error on screen.
          if (res.kind === "tip") {
            const pending = claimPendingTip(reference);
            if (pending) {
              // The server's verified figure is the one to show; the note's own
              // amount is only a fallback for a response that omitted it.
              const settled = Number(res.amount);
              void announceSpaceTip(pending.spaceId, {
                amountUsd: Number.isFinite(settled) && settled > 0 ? settled : pending.amountUsd,
                message: pending.message,
              }).catch(() => {});
            }
          }
        } else {
          setState("failed");
          setMessage("That payment didn't go through. You haven't been charged.");
        }
      })
      .catch((err: Error) => {
        setState("failed");
        setMessage(err.message || "We couldn't confirm that payment.");
      });
  }, []);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card p-8 text-center shadow-soft">
        <div className="flex justify-center">
          {state === "loading" && <Loader2 className="h-10 w-10 animate-spin text-brand" />}
          {state === "success" && <CheckCircle2 className="h-10 w-10 text-emerald-500" />}
          {state === "failed" && <XCircle className="h-10 w-10 text-rose-500" />}
        </div>
        <h1 className="mt-5 text-xl font-bold text-foreground">
          {state === "success"
            ? plan === "tip"
              ? "Tip sent"
              : `Welcome to ${plan === "pro" ? "Pro" : "Plus"}`
            : state === "failed"
              ? "Payment not completed"
              : "One moment"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link
            to="/feed"
            className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
          >
            Go to your feed
          </Link>
          <Link
            to="/pricing"
            className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-foreground/5"
          >
            Back to plans
          </Link>
        </div>
      </div>
    </div>
  );
}
