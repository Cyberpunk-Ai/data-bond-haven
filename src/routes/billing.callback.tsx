import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { confirmPaystackPayment } from "@/lib/paystack.functions";

export const Route = createFileRoute("/billing/callback")({
  head: () => ({
    meta: [
      { title: "Confirming your payment — Spaces1" },
      {
        name: "description",
        content: "We're confirming your Spaces1 membership payment and activating your plan.",
      },
      { property: "og:title", content: "Confirming your payment — Spaces1" },
      {
        property: "og:description",
        content: "We're confirming your Spaces1 membership payment and activating your plan.",
      },
      { name: "robots", content: "noindex" },
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
              ? `Your $${Number(res.amount ?? 0).toFixed(2)} tip to @${res.recipient} is on its way.`
              : "Payment confirmed. Your new plan is active.",
          );
          router.invalidate();
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
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
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
