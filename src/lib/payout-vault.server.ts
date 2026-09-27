/**
 * Server-only vault for Paystack payout recipient tokens.
 *
 * The plan is "token-only, encrypted at rest": the raw bank / mobile-money
 * account number is forwarded to Paystack once to mint a `recipient_code` and
 * then discarded — only that code is ever persisted, and even then only inside
 * an AES-256-GCM envelope keyed off the deployment pepper. A leaked database
 * row is therefore useless without API_KEY_PEPPER, and the code itself can only
 * move money when presented alongside the (separate, non-bundled) secret key.
 *
 * This file is `.server.ts`: it can never be imported into the client bundle.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

import { env } from "@/lib/env.server";

const VERSION = 1;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard.
const HKDF_INFO = "spaces.payout_recipient.v1";

export interface PayoutSecret {
  // Best-effort under manual disbursement: a destination that the provider
  // cannot tokenize (unsupported country / wallet) still saves with only the
  // account fields below.
  recipient_code?: string;
  bank_code?: string;
  account_number_last4?: string;
  // Manual-disbursement fields. These exist ONLY to let a staff operator pay a
  // withdrawal directly (bank transfer / mobile money) — the platform no longer
  // pushes money through the provider itself. They ride inside the same
  // AES-GCM envelope as the recipient token, so the raw account number is still
  // never stored (or logged) in cleartext; it is revealed only through the
  // staff-gated, audit-logged read in `payouts.functions`.
  account_number?: string;
  holder_name?: string;
  bank_name?: string;
  currency?: string;
  channel?: "nuban" | "mobile_money";
}

export interface EncryptedEnvelope {
  v: number;
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64
}

let cachedKey: Buffer | undefined;

// Derive a stable 256-bit key from the deployment pepper via HKDF-SHA256. Kept
// process-local; never stored or returned to a caller.
function key(): Buffer {
  if (!cachedKey) {
    const pepper = env().apiKeyPepper;
    if (!pepper) {
      throw new Error(
        "API_KEY_PEPPER is not set; payout details cannot be encrypted. Generate one with `openssl rand -hex 32`.",
      );
    }
    const derived = hkdfSync("sha256", Buffer.from(pepper, "utf8"), Buffer.alloc(0), Buffer.from(HKDF_INFO, "utf8"), 32);
    cachedKey = Buffer.from(derived);
  }
  return cachedKey;
}

/** Encrypt a payout secret into a JSON-safe envelope for storage. */
export function encryptRecipient(secret: PayoutSecret): EncryptedEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  return {
    v: VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

/**
 * Decrypt a stored envelope back to the secret. Throws if the blob is malformed
 * or the auth tag fails (tampering / a rotated pepper) — callers treat that as
 * "no usable destination", never as a recoverable value.
 */
export function decryptRecipient(envelope: unknown): PayoutSecret {
  const e = envelope as Partial<EncryptedEnvelope> | null;
  if (!e || !e.iv || !e.tag || !e.ct) {
    throw new Error("Payout details are unreadable.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(e.iv, "base64"));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(e.ct, "base64")), decipher.final()]);
  const parsed = JSON.parse(pt.toString("utf8")) as PayoutSecret;
  // The GCM auth tag above already proves the blob was written by us and has
  // not been tampered with, so we no longer require `recipient_code` here: under
  // the manual-payout model a destination may legitimately store only account
  // details (no provider token) when the country can't mint one.
  if (!parsed || typeof parsed !== "object") throw new Error("Payout details are unreadable.");
  return parsed;
}
