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
        const { error: logError } = await admin.from("payment_events").insert({
          provider: "paystack",
          event_id: tx.id != null ? String(tx.id) : null,
          event,
          reference: tx.reference ?? null,
          payload: { event, data: tx },
        });
        // A duplicate key here is Paystack redelivering the same event — expected,
        // and the reason this write exists. Anything else is a broken audit trail
        // and needs to be visible.
        if (logError && logError.code !== "23505") {
          console.error("paystack webhook: event log write failed:", logError.message);
        }

        // ---- payouts (transfers) ----
        if (event.startsWith("transfer.")) {
          const status =
            event === "transfer.success"
              ? "paid"
              : event === "transfer.reversed"
                ? "reversed"
                : "failed";
          if (tx.transfer_code) {
            const { data: updated, error: statusError } = await admin
              .from("payouts")
              .update({
                status,
                ...(status === "failed" ? { failure_reason: tx.reason ?? "Transfer failed" } : {}),
                updated_at: new Date().toISOString(),
              })
              .eq("transfer_code", tx.transfer_code)
              .select("user_id, amount, amount_usd, currency, workspace_id")
              .maybeSingle();

            // supabase-js reports a rejected write as a resolved promise, so the
            // only signal is `error`. Answering 200 here would retire the event:
            // Paystack stops retrying and the withdrawal sits `pending` forever
            // while the bank has already moved the money. Settlement is keyed on
            // transfer_code, so a retry is safe.
            if (statusError) {
              console.error("paystack webhook: payout status write failed:", statusError.message);
              return new Response("payout_status_error", { status: 500 });
            }

            // Tell the creator/owner the outcome (personal or team withdrawal).
            if (updated && (status === "paid" || status === "failed")) {
              // USD is what every screen and notification on the platform speaks.
              const amount =
                updated.amount_usd != null
                  ? `$${Number(updated.amount_usd).toFixed(2)}`
                  : `${updated.currency ?? ""} ${Number(updated.amount ?? 0).toFixed(2)}`.trim();
              const { error: noticeError } = await admin.from("notifications").insert({
                recipient_id: updated.user_id,
                actor_id: null,
                type: "payout",
                body:
                  status === "paid"
                    ? `your withdrawal of ${amount} has been paid out`
                    : `your withdrawal of ${amount} failed${tx.reason ? `: ${tx.reason}` : ""}`,
                link: updated.workspace_id
                  ? "/settings?section=workspaces"
                  : "/settings?section=monetization",
              });
              // The payout row already carries the new status, so the transfer is
              // correctly recorded either way — but a creator who is never told
              // their money moved (or didn't) deserves more than a silent drop.
              if (noticeError) {
                console.error("paystack webhook: payout notice not stored:", noticeError.message);
              }
            } else if (status === "paid" || status === "failed") {
              // The write succeeded and matched nothing. That is either a code we
              // never issued or a row a previous delivery already resolved; the
              // audit trail above has the event, so this is logged, not retried.
              console.warn(`paystack webhook: no payout row for transfer ${tx.transfer_code}`);
            }
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
