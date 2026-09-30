/**
 * Space replay storage rules (pure — no server, no React).
 *
 * The product rule these encode: **a live Space stores nothing**. Audio is
 * broadcast peer-to-peer and never buffered for us, so hosting costs zero
 * bytes no matter how long the room runs. Storage only enters the picture when
 * a host deliberately presses Record and the take survives the room as a
 * replay — and those bytes have to fit the host's plan.
 *
 * Two different budgets apply to that one file, which is why both exist here:
 *   * `mediaUploadMaxMb`  — how big ONE upload may be (any folder);
 *   * `spacesStorageMb`   — how much a host keeps as replays *in total*.
 *
 * The same numbers are enforced again in the database
 * (`t_spaces_recording_cap`, migration 20260930000093) and at the upload
 * endpoint, so this module is what the UI offers — never the only gate.
 */
import { PLAN_DETAILS, type PlanTier } from "@/lib/plans";

export const MB = 1024 * 1024;

function specsFor(plan: PlanTier | null | undefined) {
  return PLAN_DETAILS[isPlanTier(plan) ? plan : "free"].limits;
}

function isPlanTier(value: PlanTier | null | undefined): value is PlanTier {
  return value === "free" || value === "plus" || value === "pro";
}

/** Whether this plan may save a replay at all. A live broadcast needs no such
 * permission — this only gates the *recording*, never the room. */
export function spaceRecordingAllowed(plan: PlanTier | null | undefined): boolean {
  return specsFor(plan).spacesRecording;
}

/**
 * The ceiling for a single recorded Space: the plan's per-file allowance, but
 * never more than the global safety cap (`VITE_SPACES_RECORDING_MAX_MB`), which
 * exists so one browser tab cannot fill the store regardless of tier.
 */
export function perRecordingCapBytes(
  plan: PlanTier | null | undefined,
  globalCeilingMb: number,
): number {
  const planMb = specsFor(plan).mediaUploadMaxMb;
  const ceiling =
    Number.isFinite(globalCeilingMb) && globalCeilingMb > 0 ? globalCeilingMb : planMb;
  return Math.min(planMb, ceiling) * MB;
}

/** Everything a host is allowed to keep as replays, in bytes. */
export function spaceStorageQuotaBytes(plan: PlanTier | null | undefined): number {
  return specsFor(plan).spacesStorageMb * MB;
}

/**
 * Read the tier budget off a `plan_limits` row, or off the plan itself when the
 * column is not there yet. `spaces_storage_mb` is added by migration
 * 20260930000093, so an un-migrated database reports nothing for it — and
 * `NaN` compared against any size is false, which would silently grant an
 * infinite replay budget. A missing or unusable figure therefore falls back to
 * the tier numbers the pricing page already commits to, never to "unlimited".
 */
export function resolveSpacesStorageMb(declaredMb: unknown, plan: PlanTier): number {
  const value = Number(declaredMb);
  if (Number.isFinite(value) && value >= 0) return value;
  return specsFor(plan).spacesStorageMb;
}

/** Would an incoming recording of `incomingBytes` overflow the host's budget? */
export function isSpaceStorageFull(
  usedBytes: number,
  quotaBytes: number,
  incomingBytes: number,
): boolean {
  const used = Math.max(0, usedBytes || 0);
  const incoming = Math.max(0, incomingBytes || 0);
  return used + incoming > quotaBytes;
}

/**
 * Not one more byte of replay fits. Used to warn a host *before* they press
 * Record, rather than after a whole broadcast has been captured and refused.
 */
export function isSpaceStorageExhausted(usedBytes: number, quotaBytes: number): boolean {
  return Math.max(0, usedBytes || 0) >= quotaBytes;
}

/**
 * The refusal the host sees when the budget is spent. Deliberately states the
 * problem, the budget and the way out, because the room itself is unaffected —
 * the broadcast keeps running, it simply does not become a replay.
 */
export function spaceStorageFullMessage(quotaBytes: number, usedBytes = 0): string {
  const mb = (n: number) => Math.round(n / MB);
  const detail = usedBytes > 0 ? `${mb(usedBytes)} MB of the ` : "";
  return `Your Space storage is full (${detail}${mb(quotaBytes)} MB) — delete an old replay to keep this one.`;
}

/** Compact human size for the usage readout: 940 KB · 1.2 GB · 0 B. */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  const rounded =
    value >= 100 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${unit}`;
}
