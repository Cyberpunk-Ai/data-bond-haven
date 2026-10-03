/**
 * Time-based one-time passwords (RFC 6238) and recovery codes.
 *
 * This is the groundwork for two-factor sign-in: the primitives the server
 * needs to issue a secret, prove a code and revoke a factor. Nothing here
 * touches the database, and nothing here decides *when* a second factor is
 * asked for — that is the sign-in flow's job once its UI exists.
 *
 * Why it is written against WebCrypto rather than a package: the app already
 * runs on `crypto.subtle` in both the browser and the Nitro server, so an
 * extra dependency would be a second, unaudited copy of the same six lines.
 *
 * Parameters are the industry defaults, and deliberately not configurable:
 * 30-second steps, six decimal digits, SHA-1 — the combination every
 * authenticator app (Google Authenticator, Authy, 1Password, Apple) speaks.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Codes stay acceptable one step before and after "now": clocks drift, and a
 * reader typing from a phone beside a laptop is routinely a few seconds late. */
const DEFAULT_WINDOW = 1;
/** Recovery codes are single-use, so this is a small database of hashes. */
const RECOVERY_CODE_COUNT = 10;

export interface TotpOptions {
  /** Seconds per code. Only overridden in tests. */
  step?: number;
  /** How many steps either side of `now` to accept. */
  window?: number;
  /** Unix seconds. Defaults to the wall clock. */
  now?: number;
}

/** RFC 4648 base32 alphabet. Authenticator apps paste secrets in this form. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Bytes → upper-case base32, padding trimmed (the usual TOTP presentation). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5);
    if (chunk.length < 5) break;
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

/** base32 → bytes. Spaces/dashes are ignored, lower case is accepted. */
export function base32Decode(value: string): Uint8Array {
  const clean = value.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!clean) return new Uint8Array();
  if (!new RegExp(`^[${BASE32_ALPHABET}]+$`).test(clean)) {
    throw new Error("Secret is not valid base32");
  }
  let bits = "";
  for (const char of clean) {
    bits += BASE32_ALPHABET.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto is unavailable in this runtime");
  return c;
}

/**
 * A fresh shared secret: 20 random bytes, which is what RFC 6238 recommends for
 * SHA-1 and what every authenticator app accepts.
 */
export function generateTotpSecret(bytes = 20): string {
  const buf = new Uint8Array(bytes);
  getCrypto().getRandomValues(buf);
  return base32Encode(buf);
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const crypto = getCrypto();
  const rawKey = key as unknown as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, message as unknown as ArrayBuffer);
  return new Uint8Array(signature);
}

/** The 8-byte big-endian counter RFC 4287/RFC 6238 feeds into HMAC. */
function counterBytes(counter: number): Uint8Array {
  const out = new Uint8Array(8);
  let value = Math.floor(counter);
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
}

/** HOTP (RFC 4226, §5.2) — the dynamic-truncation step TOTP is built on. */
export async function hotp(
  secretBase32: string,
  counter: number,
  digits = DIGITS,
): Promise<string> {
  const key = base32Decode(secretBase32);
  const hash = await hmacSha1(key, counterBytes(counter));
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/** The code for a given instant. */
export async function totpCode(secretBase32: string, options: TotpOptions = {}): Promise<string> {
  const step = options.step ?? STEP_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return hotp(secretBase32, Math.floor(now / step));
}

/**
 * Does `code` match the secret right now? Checks the window around `now`, and
 * compares as strings of equal length so a short/long entry never reaches the
 * comparison. Never throws on malformed input — a wrong answer is `false`.
 */
export async function verifyTotp(
  code: string,
  secretBase32: string,
  options: TotpOptions = {},
): Promise<boolean> {
  const candidate = String(code ?? "")
    .trim()
    .replace(/\s/g, "");
  if (!/^\d+$/.test(candidate)) return false;
  const step = options.step ?? STEP_SECONDS;
  const window = options.window ?? DEFAULT_WINDOW;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / step);
  try {
    for (let offset = -window; offset <= window; offset += 1) {
      if ((await hotp(secretBase32, counter + offset)) === candidate) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * The `otpauth://` line behind a setup QR code. `issuer` is what the
 * authenticator shows as the account's owner, so two "Spaces1" entries stay
 * distinguishable. Reserved characters are encoded because a display name with
 * a space or an `&` would otherwise corrupt the URI.
 */
export function totpProvisioningUri(opts: {
  secretBase32: string;
  accountName: string;
  issuer?: string;
  step?: number;
  digits?: number;
}): string {
  const issuer = (opts.issuer ?? "Spaces1").trim() || "Spaces1";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(opts.accountName)}`;
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(opts.digits ?? DIGITS),
    period: String(opts.step ?? STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** SHA-256 hex, so recovery codes are stored as digests rather than text. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await getCrypto().subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Recovery codes: ten characters from an alphabet with the confusing ones
 * removed, printed in two groups for reading off a screen. Returned once in
 * cleartext by design; only the digests are ever stored, and a code that is used
 * is simply dropped from the list.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  // No `l`, `i`, `o`, `1` or `0`: a recovery code is looked at on one device and
  // typed into another, and those five are how the attempt fails.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const crypto = getCrypto();
  // Rejection sampling, not `byte % alphabet.length`: a modulo over the 256 byte
  // values favours the alphabet's first characters and shaves entropy off every
  // credential this hands out. (31 × 8 = 248, so a redraw is rare.)
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const byte = new Uint8Array(1);
  const pick = () => {
    do {
      crypto.getRandomValues(byte);
    } while (byte[0] >= limit);
    return alphabet[byte[0] % alphabet.length];
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: 10 }, pick)
      .join("")
      .replace(/^(.{5})(.{5})$/, "$1-$2"),
  );
}

/**
 * Normalise what a user typed before comparing against a stored digest.
 *
 * Case, spaces and the formatting dash are all noise: the digest is taken of
 * the bare alphanumeric run, so a code retyped from a screenshot or read off a
 * printed sheet still unlocks the account. Both sides (storing and checking)
 * go through here, which is what makes the two agree.
 */
export function normalizeRecoveryCode(code: string): string {
  return String(code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(normalizeRecoveryCode(code));
}

/**
 * Has this factor completed its setup? A secret that was issued but never
 * confirmed with a real code must not be treated as protection: the account
 * would be locked behind a factor nobody verified they could satisfy.
 */
export function isFactorActive(
  factor:
    | {
        status?: string | null;
        verified_at?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!factor) return false;
  return factor.status === "active" && Boolean(factor.verified_at);
}
