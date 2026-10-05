import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PLAN_DETAILS } from "@/lib/plans";
import {
  formatBytes,
  isSpaceStorageExhausted,
  isSpaceStorageFull,
  perRecordingCapBytes,
  resolveSpacesStorageMb,
  spaceRecordingAllowed,
  spaceStorageFullMessage,
  spaceStorageQuotaBytes,
  MB,
} from "@/lib/spaces-storage";

/**
 * The storage rule for Spaces: a live broadcast writes nothing, only a saved
 * replay costs bytes, and those bytes have to fit the host's tier.
 *
 * Two numbers get confused constantly, so they are pinned separately here:
 * `mediaUploadMaxMb` is ONE file, `spacesStorageMb` is everything a host keeps.
 */
describe("a live Space is free of storage", () => {
  it("gates the recording, never the broadcast", () => {
    expect(spaceRecordingAllowed("free")).toBe(false);
    expect(spaceRecordingAllowed("plus")).toBe(true);
    expect(spaceRecordingAllowed("pro")).toBe(true);
  });

  it("treats a plan it does not recognise as free", () => {
    // Fail closed: an unknown tier must not hand somebody replay bytes.
    const junk: unknown[] = [undefined, null, "", "enterprise"];
    for (const tier of junk) {
      expect(spaceRecordingAllowed(tier as never)).toBe(false);
      expect(spaceStorageQuotaBytes(tier as never)).toBe(250 * MB);
    }
  });
});

describe("one recording, one file, one size", () => {
  const GLOBAL_CEILING_MB = 100; // appConfig.realtime.recordingMaxMb

  it("uses the plan's per-file allowance for a single take", () => {
    expect(perRecordingCapBytes("free", GLOBAL_CEILING_MB)).toBe(10 * MB);
    expect(perRecordingCapBytes("plus", GLOBAL_CEILING_MB)).toBe(100 * MB);
  });

  it("never lets a bigger plan outrun the global safety cap", () => {
    // Pro may upload a 1 GB post, but a browser tab must not fill the store
    // with one unbounded recording.
    expect(perRecordingCapBytes("pro", GLOBAL_CEILING_MB)).toBe(GLOBAL_CEILING_MB * MB);
    expect(perRecordingCapBytes("pro", 50)).toBe(50 * MB);
  });

  it("falls back to the plan figure when the ceiling is missing or silly", () => {
    for (const junk of [0, -1, NaN]) {
      expect(perRecordingCapBytes("plus", junk)).toBe(100 * MB);
    }
  });
});

describe("the replay budget is a plan promise, not a suggestion", () => {
  it("matches the tier the pricing page states", () => {
    expect(spaceStorageQuotaBytes("free")).toBe(250 * MB);
    expect(spaceStorageQuotaBytes("plus")).toBe(1024 * MB);
    expect(spaceStorageQuotaBytes("pro")).toBe(5120 * MB);
  });

  it("lets a recording land exactly on the budget and refuses the next byte", () => {
    const quota = spaceStorageQuotaBytes("plus");
    expect(isSpaceStorageFull(quota - 500, quota, 500)).toBe(false);
    expect(isSpaceStorageFull(quota - 500, quota, 501)).toBe(true);
    expect(isSpaceStorageFull(0, quota, 1)).toBe(false);
  });

  it("says a budget that holds nothing left is spent", () => {
    const quota = spaceStorageQuotaBytes("plus");
    expect(isSpaceStorageExhausted(quota - 1, quota)).toBe(false);
    expect(isSpaceStorageExhausted(quota, quota)).toBe(true);
  });

  it("refuses to read a budget it cannot see as unlimited", () => {
    // The column is added by a migration, so an un-migrated database sends
    // undefined. Falling back must land on the tier's number, never "no cap".
    expect(resolveSpacesStorageMb(undefined, "plus")).toBe(1024);
    expect(resolveSpacesStorageMb("not a number", "pro")).toBe(5120);
    expect(resolveSpacesStorageMb(Number.NaN, "free")).toBe(250);
    // A declared value is honoured exactly, including a deliberate zero.
    expect(resolveSpacesStorageMb(0, "pro")).toBe(0);
    expect(resolveSpacesStorageMb(2048, "free")).toBe(2048);
  });

  it("names the budget and the way out in the refusal", () => {
    const msg = spaceStorageFullMessage(1024 * MB, 1000 * MB);
    expect(msg).toContain("Your Space storage is full");
    expect(msg).toContain("1024 MB");
    expect(msg).toContain("delete an old replay");
    // Nothing here deletes or overwrites on the host's behalf.
    expect(msg).not.toMatch(/automat|deleted (one|an old)/i);
  });
});

describe("formatBytes", () => {
  it("keeps sizes readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(100 * MB)).toBe("100 MB");
    expect(formatBytes(250 * MB)).toBe("250 MB");
    expect(formatBytes(5120 * MB)).toBe("5 GB");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("every layer enforces the same tier numbers", () => {
  // Drift guard. The pricing page, the server and the database each carry a
  // copy of 250 / 1024 / 5120, and only the last one cannot be walked around.
  const migration = readFileSync("db/migrations/20260930000093_spaces_storage_quota.sql", "utf8");

  it("plans.ts agrees with the migration's plan_limits", () => {
    const sql = migration.replace(/\s+/g, " ");
    for (const tier of ["free", "plus", "pro"] as const) {
      const declared = Number(sql.match(new RegExp(`when '${tier}'\\s+then\\s+(\\d+)`))?.[1]);
      expect(declared, `migration never states ${tier}'s spaces_storage_mb`).toBeGreaterThan(0);
      expect(PLAN_DETAILS[tier].limits.spacesStorageMb).toBe(declared);
    }
  });

  it("the trigger polices a stored replay and leaves a live room alone", () => {
    expect(migration).toContain("spaces_storage_mb");
    expect(migration).toMatch(/if new\.recording_url is null then\s+return new;/);
    // An unrelated edit to a room that already has a replay must still work:
    // ending the room is never a storage decision.
    expect(migration).toMatch(
      /new\.recording_bytes is not distinct from old\.recording_bytes then\s+return new;/,
    );
    // The three refusals the app surfaces: not in plan, one file too big, budget spent.
    for (const code of ["PT402", "PT413", "PT507"]) {
      expect(migration).toContain(`'${code}'`);
    }
    expect(migration).toMatch(/create trigger t_spaces_recording_cap/);
  });

  it("the upload endpoint asks the quota before it writes a byte", () => {
    const route = readFileSync("src/routes/api/uploads/index.ts", "utf8");
    const guard = route.slice(route.indexOf('if (folder === "recordings") {'));
    expect(guard).toContain("requireSpaceStorageQuota(profileId, buffer.byteLength)");
    expect(route).toContain("isSpaceStorageFull(err)");
    expect(route.slice(route.indexOf("isSpaceStorageFull(err)"))).toContain("507");
  });

  it("deleting a replay gives its bytes back, and a refusal is never a data URL", () => {
    const client = readFileSync("src/lib/api-client.ts", "utf8");
    const del = client.slice(
      client.indexOf("export async function deleteSpaceRecording"),
      client.indexOf("export async function recordSpaceReplayView"),
    );
    expect(del).toContain("recording_bytes: 0");
    // The whole point of the 507 is that the host reads it.
    expect(client).toContain("DELIBERATE_REJECTIONS");
    expect(client).toMatch(/if \(rejection\) throw new Error\(rejection\);/);
  });

  it("the room offers recording only to plans that can keep it", () => {
    const modal = readFileSync("src/components/social/SpaceRoomModal.tsx", "utf8");
    expect(modal).toContain("spaceRecordingAllowed(currentPlan)");
    expect(modal).toContain("canRecordSpace ? (");
    expect(modal).toContain("perRecordingCapBytes(currentPlan, appConfig.realtime.recordingMaxMb)");
    // And the room stays quiet about it — no persistent "Live only — broadcasting
    // stores nothing" or "Replays need an upgrade" caption under the header.
    expect(modal).not.toContain("Live only — broadcasting stores nothing");
    expect(modal).not.toContain("Replays need an upgrade");
    // The record control must be describable even when its label is hidden on a
    // narrow screen — and that label only shows at all if `xs` exists.
    expect(modal).toContain('aria-label="Upgrade to record Spaces and keep them as replays"');
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/--breakpoint-xs:\s*30rem;/);
  });
});
