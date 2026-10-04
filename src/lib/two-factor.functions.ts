import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  isFactorActive,
  totpProvisioningUri,
  verifyTotp,
} from "@/lib/totp";

/**
 * Two-factor setup, server side.
 *
 * The Settings screen once carried a "Two-factor authentication" switch that
 * could not be switched on, because there was nothing behind it. The switch is
 * gone; this is the part that has to exist first, so the UI can be wired later
 * against behaviour that is already real:
 *
 *   * the shared secret never leaves the server. `enroll` hands back the secret
 *     once, for the QR code, and stores it; every later call passes a *code* in
 *     and gets a yes/no back;
 *   * a factor is only active after the owner proved they can produce a code
 *     from it (`confirm`). A half-finished setup must never be allowed to lock
 *     somebody out of their own account;
 *   * recovery codes are stored as digests and each one is single-use;
 *   * wrong codes are counted and the factor is temp-locked, because a six-digit
 *     code is only safe with a bounded number of guesses.
 *
 * All reads and writes go through the service-role client: `second_factors` has
 * no RLS policies by design (see the migration), so a user's own token cannot
 * touch it at all.
 *
 * NOTE: sign-in does not consult this yet. That is deliberate — an unenforced
 * gate is a missing feature, while a gate with no enrolment UI is a lockout.
 */

const MAX_FAILED_ATTEMPTS = 8;
const LOCK_SECONDS = 300;

type AdminClient = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

async function getAdmin(): Promise<AdminClient> {
  const mod = await import("@/integrations/supabase/client.server");
  return mod.supabaseAdmin;
}

/**
 * One narrow seam for the tables this service owns.
 *
 * `second_factors` post-dates the generated Supabase types, and those are never
 * hand-edited — so rather than casting at eleven call sites (which is how a
 * wrong column name becomes invisible), the untyped hop happens once, here,
 * behind a shape that still describes what these functions actually do.
 */
type QueryResult<T = Record<string, unknown>> = {
  data: T | null;
  error: { message: string } | null;
};
/**
 * Only the shapes these functions really chain into: a read ends in
 * `maybeSingle()`, a write ends once its filter is applied. Anything else is a
 * compile error here rather than a runtime surprise on a sign-in path.
 */
interface TableApi {
  select(columns: string): {
    eq(column: string, value: string): { maybeSingle(): Promise<QueryResult> };
  };
  update(values: Record<string, unknown>): {
    eq(column: string, value: string): Promise<QueryResult>;
  };
  delete(): { eq(column: string, value: string): Promise<QueryResult> };
  upsert(values: Record<string, unknown>, options?: { onConflict?: string }): Promise<QueryResult>;
}
const db = (admin: AdminClient) =>
  admin as unknown as { from(table: "second_factors" | "profiles"): TableApi };

/** The profile row owns the factor: every other table in the schema is keyed by it. */
async function profileIdFor(authUserId: string): Promise<string> {
  const admin = await getAdmin();
  const { data } = await db(admin)
    .from("profiles")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (!data?.id) throw new Error("Profile not found");
  return String(data.id);
}

interface FactorRow {
  user_id: string;
  secret: string;
  status: string;
  recovery_hashes: string[] | null;
  failed_attempts: number;
  locked_until: string | null;
  verified_at: string | null;
}

async function readFactor(profileId: string): Promise<FactorRow | null> {
  const admin = await getAdmin();
  const { data } = await db(admin)
    .from("second_factors")
    .select("*")
    .eq("user_id", profileId)
    .maybeSingle();
  return (data as FactorRow | null) ?? null;
}

function lockSecondsLeft(row: FactorRow): number {
  if (!row.locked_until) return 0;
  const until = Date.parse(row.locked_until);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

const readCode = (data: unknown) => {
  const raw = String(((data ?? {}) as { code?: unknown }).code ?? "").trim();
  if (!raw) throw new Error("Enter the code from your authenticator app.");
  if (raw.length > 32) throw new Error("That code is too long.");
  return raw;
};

/** Where the account stands: enough for a settings row, and no secret. */
export const getTwoFactorStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as { userId: string };
    const profileId = await profileIdFor(userId);
    const row = await readFactor(profileId);
    return {
      enabled: isFactorActive(row),
      /** A secret was issued but never confirmed with a real code. */
      pending: Boolean(row) && !isFactorActive(row),
      lockSecondsLeft: row ? lockSecondsLeft(row) : 0,
    };
  });

/**
 * Issue a secret and recovery codes. Returns the cleartext once — that is the
 * moment for the QR code — and leaves the factor `pending` until `confirm`.
 * Re-enrolling replaces the previous secret outright.
 */
export const enrollTwoFactor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as { userId: string };
    const admin = await getAdmin();
    const profileId = await profileIdFor(userId);

    const { data: profile } = await db(admin)
      .from("profiles")
      .select("username")
      .eq("id", profileId)
      .maybeSingle();
    // The QR label wants the handle; an account without one still enrolls,
    // keyed by the profile id, rather than producing a broken provisioning URI.
    const username = typeof profile?.username === "string" ? profile.username : "";
    const accountName = username || profileId;

    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();
    const row = {
      user_id: profileId,
      kind: "totp",
      secret,
      status: "pending",
      recovery_hashes: await Promise.all(recoveryCodes.map(hashRecoveryCode)),
      failed_attempts: 0,
      locked_until: null,
      verified_at: null,
      last_used_at: null,
    };
    const { error } = await db(admin).from("second_factors").upsert(row, { onConflict: "user_id" });
    if (error) throw new Error("Could not start two-factor setup. Please try again.");

    return {
      secret,
      recoveryCodes,
      provisioningUri: totpProvisioningUri({
        secretBase32: secret,
        accountName,
        // No `issuer`: the authenticator's owner line defaults to the name this
        // deployment actually runs as (`appConfig.brand.name` in totp.ts), so a
        // rebranded install cannot enrol a factor under the old product's name.
      }),
    };
  });

/** Prove the new factor works. Until this succeeds, sign-in is unchanged. */
export const confirmTwoFactor = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => ({ code: readCode(data) }))
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { userId } = context as { userId: string };
    const admin = await getAdmin();
    const profileId = await profileIdFor(userId);
    const row = await readFactor(profileId);
    if (!row) throw new Error("Start two-factor setup first.");
    if (isFactorActive(row)) return { ok: true };

    if (!(await verifyTotp(data.code, row.secret))) {
      await noteFailure(admin, row);
      throw new Error("That code didn't match. Check the device and try again.");
    }

    const { error } = await db(admin)
      .from("second_factors")
      .update({ status: "active", verified_at: new Date().toISOString(), failed_attempts: 0 })
      .eq("user_id", profileId);
    if (error) throw new Error("Could not finish two-factor setup. Please try again.");
    return { ok: true };
  });

/**
 * Check a code against an active factor. Recovery codes are accepted here and
 * burned on use. This is what the sign-in flow will call once it exists.
 */
export const verifyTwoFactor = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => ({ code: readCode(data) }))
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { userId } = context as { userId: string };
    const admin = await getAdmin();
    const profileId = await profileIdFor(userId);
    const row = await readFactor(profileId);
    if (!row || !isFactorActive(row)) throw new Error("Two-factor isn't set up on this account.");

    const waiting = lockSecondsLeft(row);
    if (waiting > 0) {
      throw new Error(
        `Too many incorrect codes. Try again in ${waiting} second${waiting === 1 ? "" : "s"}.`,
      );
    }

    if (await verifyTotp(data.code, row.secret)) {
      await db(admin)
        .from("second_factors")
        .update({ failed_attempts: 0, last_used_at: new Date().toISOString() })
        .eq("user_id", profileId);
      return { ok: true, usedRecoveryCode: false };
    }

    const digest = await hashRecoveryCode(data.code);
    const hashes = Array.isArray(row.recovery_hashes) ? row.recovery_hashes : [];
    if (hashes.includes(digest)) {
      await db(admin)
        .from("second_factors")
        .update({
          recovery_hashes: hashes.filter((h) => h !== digest),
          failed_attempts: 0,
          last_used_at: new Date().toISOString(),
        })
        .eq("user_id", profileId);
      return { ok: true, usedRecoveryCode: true };
    }

    await noteFailure(admin, row);
    throw new Error("That code isn't right. It may already have been used.");
  });

/**
 * Turn the factor off. A code is required so a stolen session cannot quietly
 * remove the protection — and a pending setup can always be abandoned, since
 * nothing was ever enforced by it.
 */
export const disableTwoFactor = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => ({ code: readCode(data) }))
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { userId } = context as { userId: string };
    const admin = await getAdmin();
    const profileId = await profileIdFor(userId);
    const row = await readFactor(profileId);
    if (!row) return { ok: true };

    const allowed =
      !isFactorActive(row) ||
      (await verifyTotp(data.code, row.secret)) ||
      (await isRecoveryMatch(data.code, row));
    if (!allowed) throw new Error("Confirm with a current code before turning two-factor off.");

    const { error } = await db(admin).from("second_factors").delete().eq("user_id", profileId);
    if (error) throw new Error("Could not turn two-factor off. Please try again.");
    return { ok: true };
  });

async function isRecoveryMatch(code: string, row: FactorRow): Promise<boolean> {
  const hashes = Array.isArray(row.recovery_hashes) ? row.recovery_hashes : [];
  if (hashes.length === 0) return false;
  return hashes.includes(await hashRecoveryCode(code));
}

/**
 * Count a wrong code and lock the factor once the guess budget is spent. The
 * lock is written as an absolute timestamp so it survives a reload, a different
 * device, and the app being closed.
 */
async function noteFailure(admin: AdminClient, row: FactorRow): Promise<void> {
  const attempts = Number(row.failed_attempts ?? 0) + 1;
  const locked =
    attempts >= MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + LOCK_SECONDS * 1000).toISOString()
      : row.locked_until;
  await db(admin)
    .from("second_factors")
    .update({
      failed_attempts: attempts >= MAX_FAILED_ATTEMPTS ? 0 : attempts,
      locked_until: locked,
    })
    .eq("user_id", row.user_id);
}
