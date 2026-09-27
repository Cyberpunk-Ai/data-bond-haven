/**
 * Server-only Paystack HTTP helper.
 *
 * Single place that attaches the secret key and normalises provider errors, so
 * charges (paystack.functions.ts) and transfers/payouts (payouts.functions.ts)
 * share one code path and can never drift on auth or error handling. The secret
 * key is read from the server env and never leaves this module.
 */
import { env } from "@/lib/env.server";

export function paystackConfig() {
  return env().paystack;
}

export async function paystack(path: string, init?: RequestInit): Promise<any> {
  const key = env().paystack.secretKey;
  if (!key) throw new Error("Payments are not configured yet.");
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body?.status === false) {
    throw new Error(body?.message || `Payment provider error (${res.status})`);
  }
  return body;
}
