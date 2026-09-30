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

/**
 * Is the payment provider usable by this process right now?
 *
 * A reachable database does not mean a charge can be made: `env()` refuses to
 * build whenever any part of the server contract is unmet (no `API_KEY_PEPPER`,
 * a test key while `APP_ENV=production`, a missing Supabase credential…), and
 * every Paystack call then dies inside the first request that touches `env()`.
 * That failure is loud in the server log and invisible to visitors, so this
 * turns it into one coarse boolean for the public status page. It never returns
 * a reason or any part of the configuration.
 */
export function paymentConfigReady(): boolean {
  try {
    const { isProduction, paystack } = env();
    const key = paystack.secretKey;
    if (!key.startsWith("sk_")) return false;
    if (isProduction && !key.startsWith("sk_live_")) return false;
    return true;
  } catch {
    // env() throwing *is* the signal: payments cannot be configured correctly
    // while the server environment itself is invalid.
    return false;
  }
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
