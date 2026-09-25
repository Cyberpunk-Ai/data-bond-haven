import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

import { env } from "@/lib/env.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type PaystackEvent = {
  event?: string;
  data?: {
    id?: number;
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
 * Paystack webhook. Verifies the provider signature over the raw body, records
 * the event for replay defence, then settles via the SAME database function the
 * interactive confirm uses — so the two entry points can never diverge and a
 * charge can only ever be credited once.
 */
export const Route = createFileRoute("/api/public/paystack/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = env().paystack.secretKey;
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
        const admin = supabaseAdmin as any;

        // Best-effort event log for replay defence / auditing. event_id may be
        // absent for some Paystack events; the unique index tolerates nulls.
        await admin.from("payment_events").insert({
          provider: "paystack",
          event_id: tx.id != null ? String(tx.id) : null,
          event,
          reference: tx.reference ?? null,
          payload: { event, data: tx },
        });

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

        // ---- charges: settle through the single authoritative function ----
        if (!tx.reference) return new Response("ok");
        if (event !== "charge.success") {
          // Any non-success charge event is recorded above; leave the payment
          // row in whatever state the provider reports (settle handles status).
          if (event === "charge.failed" || event === "charge.refunded") {
            await admin.rpc("settle_paystack_transaction", {
              _reference: tx.reference,
              _tx: { status: "failed", gateway_response: event },
            });
          }
          return new Response("ok");
        }

        const { error } = await admin.rpc("settle_paystack_transaction", {
          _reference: tx.reference,
          _tx: tx,
        });
        if (error) {
          console.error("[paystack] settle failed", error, { reference: tx.reference });
          // Return a non-2xx so Paystack retries; settlement is idempotent.
          return new Response("settle_error", { status: 500 });
        }
        return new Response("ok");
      },
    },
  },
});
