import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

type PaystackEvent = {
  event?: string;
  data?: {
    reference?: string;
    status?: string;
    paid_at?: string;
    amount?: number;
    currency?: string;
    customer?: { customer_code?: string };
    authorization?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    transfer_code?: string;
    reason?: string;
  };
};

function verifySignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature) return false;
  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Paystack webhook. Verifies the provider signature over the raw body before
 * touching any data, then settles the matching payment / payout row.
 */
export const Route = createFileRoute("/api/public/paystack/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["PAYSTACK_SECRET_KEY"];
        if (!secret) {
          console.error("[paystack] webhook received but PAYSTACK_SECRET_KEY is not configured");
          return new Response("Not configured", { status: 503 });
        }

        const rawBody = await request.text();
        if (!verifySignature(rawBody, request.headers.get("x-paystack-signature"), secret)) {
          return new Response("Invalid signature", { status: 401 });
        }

        let payload: PaystackEvent;
        try {
          payload = JSON.parse(rawBody) as PaystackEvent;
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }

        const event = payload.event ?? "";
        const tx = payload.data ?? {};
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as any;

        // ---- payouts (transfers) ----
        if (event.startsWith("transfer.")) {
          const status =
            event === "transfer.success"
              ? "paid"
              : event === "transfer.reversed"
                ? "reversed"
                : "failed";
          if (tx.transfer_code) {
            await admin
              .from("payouts")
              .update({
                status,
                ...(status === "failed" ? { failure_reason: tx.reason ?? "Transfer failed" } : {}),
              })
              .eq("transfer_code", tx.transfer_code);
          }
          return new Response("ok");
        }

        // ---- charges ----
        if (!tx.reference) return new Response("ok");

        const succeeded = event === "charge.success" && tx.status === "success";

        const { data: payment } = await admin
          .from("payments")
          .select("id, user_id, plan, billing_cycle, status, raw")
          .eq("reference", tx.reference)
          .maybeSingle();

        if (!payment) return new Response("ok");
        if (payment.status === "success") return new Response("ok"); // already settled

        await admin
          .from("payments")
          .update({
            status: succeeded ? "success" : (tx.status ?? "failed"),
            raw: tx as Record<string, unknown>,
            // Only ever set paid_at forward; never erase a previously recorded
            // settlement timestamp on a duplicate/failed delivery.
            ...(succeeded ? { paid_at: tx.paid_at ?? new Date().toISOString() } : {}),
          })
          .eq("reference", tx.reference);

        if (!succeeded) return new Response("ok");

        const meta = (tx.metadata ?? {}) as Record<string, any>;
        const isTip = meta.kind === "tip" || String(tx.reference).startsWith("tip_");

        if (isTip) {
          if (meta.recipient_id) {
            // The `t_tips_after` trigger already emits the 'tip' notification,
            // so we must not insert a second one here.
            await admin.from("tips").insert({
              from_user_id: payment.user_id,
              to_user_id: meta.recipient_id,
              amount: Number(meta.tip_usd ?? 0),
              message: String(meta.note ?? "").slice(0, 240),
              post_id: meta.post_id ?? null,
            });
          }
          return new Response("ok");
        }

        const plan = String(meta.plan ?? payment.plan ?? "plus");
        const cycle = String(meta.billing_cycle ?? payment.billing_cycle ?? "monthly");

        await admin.from("profiles").update({ plan }).eq("id", payment.user_id);
        await admin.from("subscriptions").upsert(
          {
            user_id: payment.user_id,
            plan,
            billing_cycle: cycle,
            status: "active",
            provider: "paystack",
            provider_customer_id: tx.customer?.customer_code ?? null,
            renews_at: new Date(
              Date.now() + (cycle === "annual" ? 365 : 30) * 86400000,
            ).toISOString(),
            payment_method: tx.authorization ?? {},
          },
          { onConflict: "user_id" },
        );

        return new Response("ok");
      },
    },
  },
});
