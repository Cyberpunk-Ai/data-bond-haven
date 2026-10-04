/**
 * Space replay storage accounting (server).
 *
 * One live Space writes no bytes: audio goes peer-to-peer and nothing is
 * buffered for us. Only a saved replay costs the platform storage, so this
 * module answers exactly one question — how much of the host's replay budget is
 * already spent — and enforces it at the only endpoint that can write to the
 * media store.
 *
 * Used bytes come from `media_objects` (the real bytes we hold), not from
 * `spaces.recording_bytes` (an estimate the host's own browser reports). The
 * database trigger `t_spaces_recording_cap` reads the estimate, because a
 * trigger cannot see the storage provider; between the two, a handcrafted
 * PostgREST write cannot walk around the cap either way.
 */
import { adminDb } from "@/integrations/supabase/client.server";
import { getPlanLimits, UpgradeRequiredError, type PlanTier } from "@/lib/plan-guard.server";
import { resolveSpacesStorageMb, spaceStorageFullMessage } from "@/lib/spaces-storage";

const admin = adminDb();

/** `recordings` is the folder Space replays are uploaded into. */
const RECORDINGS_FOLDER = "recordings";

export interface SpaceStorageState {
  plan: PlanTier;
  /** Whether the plan may save a replay at all — never whether it may broadcast. */
  canRecord: boolean;
  /** Ceiling for ONE recorded Space, in bytes (plan per-file allowance). */
  roomMaxBytes: number;
  /** Total replay budget for this plan, in bytes. */
  quotaBytes: number;
  /** Bytes currently held in the media store for this host's replays. */
  usedBytes: number;
  /** How many replays make up `usedBytes`. */
  replays: number;
}

/** Thrown when an incoming recording would push the host past their budget. */
export class SpaceStorageFullError extends Error {
  readonly code = "space_storage_full" as const;
  readonly status = 507;
  constructor(
    readonly quotaBytes: number,
    readonly usedBytes: number,
    message: string,
  ) {
    super(message);
    this.name = "SpaceStorageFullError";
  }
}

const MB = 1024 * 1024;

/** Current replay footprint for one host, straight from the media store. */
export async function readSpaceStorage(profileId: string): Promise<SpaceStorageState> {
  const limits = await getPlanLimits(profileId);
  const quotaBytes = resolveSpacesStorageMb(limits.spaces_storage_mb, limits.plan) * MB;

  const [{ data: objects }, { data: rooms }] = await Promise.all([
    admin
      .from("media_objects")
      .select("bytes")
      .eq("owner_profile_id", profileId)
      .eq("folder", RECORDINGS_FOLDER),
    admin.from("spaces").select("id").eq("host_id", profileId).not("recording_url", "is", null),
  ]);

  const usedBytes = ((objects ?? []) as Array<{ bytes: number | string }>).reduce(
    (sum, row) => sum + Number(row.bytes ?? 0),
    0,
  );

  return {
    plan: limits.plan,
    canRecord: limits.spaces_recording,
    roomMaxBytes: Math.max(0, limits.media_upload_max_mb) * MB,
    quotaBytes,
    usedBytes: Number.isFinite(usedBytes) ? usedBytes : 0,
    replays: ((rooms ?? []) as unknown[]).length,
  };
}

/**
 * Refuse a recording that the host's plan cannot hold. Called from the upload
 * endpoint with the real byte length, before a single byte is written.
 *
 * The per-file size cap is *not* repeated here — the route already checks the
 * incoming body against `media_upload_max_mb` and answers 413, and it has the
 * content type in hand. This guard owns the two plan decisions that check cannot
 * make: is recording part of the plan, and does the host still have room.
 */
export async function requireSpaceStorageQuota(profileId: string, incomingBytes: number) {
  const state = await readSpaceStorage(profileId);

  if (!state.canRecord) {
    // Surfaced to the host as an upgrade prompt, matching the 402 the capability
    // check returns for every other paid feature.
    throw new UpgradeRequiredError(
      "spaces_recording",
      state.plan,
      "Space recordings are not part of your plan — upgrade to save a replay.",
    );
  }

  const incoming = Math.max(0, incomingBytes || 0);
  if (state.usedBytes + incoming > state.quotaBytes) {
    throw new SpaceStorageFullError(
      state.quotaBytes,
      state.usedBytes,
      spaceStorageFullMessage(state.quotaBytes, state.usedBytes),
    );
  }

  return state;
}

/** Narrow an unknown thrown value to the "storage is full" refusal. */
export function isSpaceStorageFull(err: unknown): err is SpaceStorageFullError {
  return err instanceof SpaceStorageFullError;
}
