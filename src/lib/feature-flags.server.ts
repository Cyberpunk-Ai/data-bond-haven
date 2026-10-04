/**
 * Server-side view of the Core Platform feature toggles.
 *
 * The admin console writes `system_settings` and the database guards enforce
 * it for direct PostgREST writes (see migration 20260929000090). This module is
 * the other half: the same flags read by our own server functions, so an
 * action that goes through code (AI generation, checkouts, profile writes)
 * refuses with a clear message instead of failing deep inside a trigger.
 *
 * Enforcement is deliberately fail-open: if the settings row cannot be read
 * (timeout, cold start, RLS hiccup) the platform behaves as if every toggle is
 * in its normal position. A configuration lookup must never be able to take the
 * product down.
 */

import { appConfig } from "@/lib/config";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type PlatformFlag =
  | "maintenance_mode"
  | "registration_enabled"
  | "ai_generation_enabled"
  | "spaces_audio_enabled"
  | "stories_enabled";

export type PlatformFlags = Record<PlatformFlag, boolean>;

/** Position each toggle fails to when the settings row is unreadable. */
const SAFE_DEFAULTS: PlatformFlags = {
  maintenance_mode: false,
  registration_enabled: true,
  ai_generation_enabled: true,
  spaces_audio_enabled: true,
  stories_enabled: true,
};

// Two seconds is short enough that publishing a change from the console is
// visible "instantly" and long enough that a busy server answers the whole
// fleet from one single-row primary-key lookup.
const FLAGS_TTL_MS = 2_000;
let flagsCache: { at: number; flags: PlatformFlags } | null = null;
let flagsInFlight: Promise<PlatformFlags> | null = null;

const STAFF_TTL_MS = 20_000;
const staffCache = new Map<string, { at: number; value: boolean }>();

/** Drop the cached flags so the next read sees a just-published configuration. */
export function invalidatePlatformFlags() {
  flagsCache = null;
  staffCache.clear();
}

export async function readPlatformFlags(): Promise<PlatformFlags> {
  if (flagsCache && Date.now() - flagsCache.at < FLAGS_TTL_MS) return flagsCache.flags;
  // Concurrent requests share one lookup instead of stampeding the table.
  if (flagsInFlight) return flagsInFlight;

  flagsInFlight = (async () => {
    let flags = SAFE_DEFAULTS;
    try {
      const { data, error } = await supabaseAdmin
        .from("system_settings")
        .select(
          "maintenance_mode, registration_enabled, ai_generation_enabled, spaces_audio_enabled, stories_enabled",
        )
        .eq("id", 1)
        .maybeSingle();
      if (!error && data) {
        flags = {
          maintenance_mode: Boolean(data.maintenance_mode),
          registration_enabled: data.registration_enabled !== false,
          ai_generation_enabled: data.ai_generation_enabled !== false,
          spaces_audio_enabled: data.spaces_audio_enabled !== false,
          stories_enabled: data.stories_enabled !== false,
        };
      }
    } catch (err) {
      console.warn("[platform] could not read feature flags, failing open:", err);
    }
    flagsCache = { at: Date.now(), flags };
    return flags;
  })().finally(() => {
    flagsInFlight = null;
  });

  return flagsInFlight;
}

export async function isFlagOn(flag: PlatformFlag): Promise<boolean> {
  const flags = await readPlatformFlags();
  return flags[flag];
}

/** Is this auth user admin/moderator? Cached briefly; staff are never gated. */
export async function isStaffAuthUser(authUserId: string): Promise<boolean> {
  const hit = staffCache.get(authUserId);
  if (hit && Date.now() - hit.at < STAFF_TTL_MS) return hit.value;

  let value = false;
  try {
    const { data, error } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", authUserId)
      .in("role", ["admin", "moderator"])
      .limit(1);
    value = !error && (data?.length ?? 0) > 0;
  } catch (err) {
    // Unknown: treat as not-staff, which is the position that keeps the guard
    // honest for visitors and only costs an admin one retry.
    console.warn("[platform] staff lookup failed:", err);
    value = false;
  }
  staffCache.set(authUserId, { at: Date.now(), value });
  return value;
}

/** Refuse a flagged subsystem with a message a person can act on. */
export async function requireFlag(flag: PlatformFlag, message: string): Promise<void> {
  if (await isFlagOn(flag)) return;
  throw new Error(message);
}

/**
 * Maintenance gate: while the switch is on, nobody without a staff role may use
 * the server-side surface of the product. Reads that skip this module (feed,
 * profiles) keep working so the app degrades to "browsing only" instead of
 * erroring everywhere.
 */
export async function requirePlatformOpen(authUserId: string): Promise<void> {
  const flags = await readPlatformFlags();
  if (!flags.maintenance_mode) return;
  if (await isStaffAuthUser(authUserId)) return;
  throw new Error(
    `${appConfig.brand.name} is in maintenance mode — this action is limited to staff accounts right now. Please check back shortly.`,
  );
}
