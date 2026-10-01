// @vitest-environment node
/**
 * Where a settled tip gets announced.
 *
 * A Space tip cannot celebrate itself: the hosted checkout tears the app down,
 * so by the time the payment is verified the room is gone. The tipper carries a
 * note through the redirect and the callback trades it for an announcement —
 * which means the note's rules matter: it must match the *payment* (by
 * reference), it must expire, it must survive junk in storage, and above all it
 * must be consumed, or one generous person gets celebrated on every refresh.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PENDING_TIPS,
  PENDING_TIP_KEY,
  PENDING_TIP_TTL_MS,
  claimPendingTip,
  parsePendingTips,
  stashPendingTip,
} from "@/lib/pending-tip";
import type { PendingTip } from "@/lib/pending-tip";
import { TIP_NOTE_CHARS } from "@/lib/space-reactions";

const NOW = 1_700_000_000_000;

function tip(over: Partial<PendingTip> = {}): PendingTip {
  return {
    reference: "ps_ref_1",
    spaceId: "space-1",
    amountUsd: 5,
    message: "great room",
    at: NOW - 1000,
    ...over,
  };
}

/** A stand-in for the browser: the module only ever touches window.localStorage. */
function installStorage(value: unknown = undefined) {
  const store = new Map<string, string>();
  if (value !== undefined) store.set(PENDING_TIP_KEY, String(value));
  const g = globalThis as Record<string, unknown>;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };
  return {
    raw: () => store.get(PENDING_TIP_KEY) ?? null,
    list: (): PendingTip[] => JSON.parse(store.get(PENDING_TIP_KEY) ?? "[]"),
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe("the note is matched to the payment, not to the person", () => {
  it("claims exactly the reference that just settled", () => {
    const raw = JSON.stringify([tip(), tip({ reference: "ps_ref_2", at: NOW - 500 })]);
    const { claim, keep } = parsePendingTips(raw, "ps_ref_2", NOW);
    expect(claim?.reference).toBe("ps_ref_2");
    expect(keep.map((t) => t.reference)).toEqual(["ps_ref_1"]);
  });

  it("claims nothing when the reference is unknown, blank, or absent", () => {
    const raw = JSON.stringify([tip()]);
    expect(parsePendingTips(raw, "ps_other", NOW).claim).toBeNull();
    // A blank reference is a purge, not a claim: it must never hand back the
    // first note it finds.
    expect(parsePendingTips(raw, "", NOW).claim).toBeNull();
    expect(parsePendingTips(raw, "   ", NOW).claim).toBeNull();
    expect(parsePendingTips("[]", "ps_ref_1", NOW).claim).toBeNull();
  });

  it("survives storage that is not JSON, not an array, or full of junk", () => {
    for (const raw of ["{ not json", "null", '"ps_ref_1"', 42, {}, [null, 1, "x"], [{}]]) {
      const parsed = parsePendingTips(raw, "ps_ref_1", NOW);
      expect(parsed.claim).toBeNull();
      expect(parsed.keep).toEqual([]);
    }
  });

  it("refuses a note that cannot name a room or an amount", () => {
    for (const over of [
      { spaceId: "" },
      { reference: "" },
      { amountUsd: 0 },
      { amountUsd: -5 },
      { amountUsd: "abc" as unknown as number },
      { at: 0 },
    ]) {
      const raw = JSON.stringify([tip(over)]);
      expect(parsePendingTips(raw, "ps_ref_1", NOW).claim).toBeNull();
    }
  });

  it("flattens and clips a note pasted out of the broadcast", () => {
    const raw = JSON.stringify([tip({ message: "line one\r\n" + "y".repeat(400) })]);
    const claim = parsePendingTips(raw, "ps_ref_1", NOW).claim!;
    expect(claim.message).not.toContain("\n");
    expect(claim.message.length).toBeLessThanOrEqual(TIP_NOTE_CHARS);
  });
});

describe("an abandoned checkout stops being announced", () => {
  it("drops a note older than the TTL, keeps a recent one", () => {
    const stale = tip({ reference: "ps_old", at: NOW - PENDING_TIP_TTL_MS - 1 });
    const fresh = tip({ reference: "ps_new", at: NOW - 1 });
    const raw = JSON.stringify([stale, fresh]);
    const { claim, keep } = parsePendingTips(raw, "ps_old", NOW);
    expect(claim).toBeNull();
    expect(keep.map((t) => t.reference)).toEqual(["ps_new"]);
  });

  it("tolerates a browser clock a minute ahead but not an hour ahead", () => {
    const slight = tip({ reference: "ps_a", at: NOW + 30_000 });
    const wrong = tip({ reference: "ps_b", at: NOW + 60 * 60 * 1000 });
    const { keep } = parsePendingTips(JSON.stringify([slight, wrong]), "", NOW);
    expect(keep.map((t) => t.reference)).toEqual(["ps_a"]);
  });

  it("keeps the newest few and orders them newest first", () => {
    const many = Array.from({ length: MAX_PENDING_TIPS + 3 }, (_, i) =>
      tip({ reference: `r${i}`, at: NOW - i * 1000 }),
    );
    const { keep } = parsePendingTips(JSON.stringify(many), "", NOW);
    expect(keep).toHaveLength(MAX_PENDING_TIPS);
    expect(keep[0].reference).toBe("r0");
    expect(keep.map((t) => t.at)).toEqual([...keep].sort((a, b) => b.at - a.at).map((t) => t.at));
  });

  it("needs a usable clock before it trusts any timestamp", () => {
    const raw = JSON.stringify([tip()]);
    expect(parsePendingTips(raw, "ps_ref_1", Number.NaN).claim).toBeNull();
  });
});

describe("a claim is consumed", () => {
  it("announces once, then has nothing left to announce", () => {
    // The case that matters: React strict mode runs the effect twice, and a
    // person who refreshes the confirmation page returns with the same
    // reference. The room must not celebrate them again.
    const storage = installStorage(JSON.stringify([tip()]));
    expect(claimPendingTip("ps_ref_1", NOW)?.spaceId).toBe("space-1");
    expect(storage.raw()).toBeNull();
    expect(claimPendingTip("ps_ref_1", NOW)).toBeNull();
  });

  it("clears the key rather than storing an empty list", () => {
    const storage = installStorage(JSON.stringify([tip()]));
    claimPendingTip("ps_ref_1", NOW);
    expect(storage.raw()).toBeNull();
  });

  it("purges the expired neighbours of the tip it claims", () => {
    const stale = tip({ reference: "ps_old", at: NOW - PENDING_TIP_TTL_MS - 1 });
    const live = tip({ reference: "ps_live", at: NOW - 10 });
    const storage = installStorage(JSON.stringify([stale, live]));
    expect(claimPendingTip("ps_live", NOW)?.reference).toBe("ps_live");
    expect(storage.list()).toEqual([]);
  });

  it("leaves another checkout's note alone", () => {
    const other = tip({ reference: "ps_other", at: NOW - 10 });
    const storage = installStorage(JSON.stringify([tip(), other]));
    expect(claimPendingTip("ps_ref_1", NOW)?.reference).toBe("ps_ref_1");
    expect(storage.list().map((t) => t.reference)).toEqual(["ps_other"]);
  });

  it("works with no storage at all, and without a browser", () => {
    const storage = installStorage();
    expect(claimPendingTip("ps_ref_1", NOW)).toBeNull();
    expect(storage.raw()).toBeNull();
    // Server render: no window, so nothing to read and nothing to write.
    delete (globalThis as Record<string, unknown>).window;
    expect(claimPendingTip("ps_ref_1", NOW)).toBeNull();
  });
});

describe("noting the room before the redirect", () => {
  it("refuses to stash a tip with no room, or no reference, or no money", () => {
    const storage = installStorage();
    expect(stashPendingTip({ reference: "r", amountUsd: 5, message: "" })).toBe(false);
    expect(stashPendingTip({ spaceId: "s", amountUsd: 5 })).toBe(false);
    expect(stashPendingTip({ spaceId: "s", reference: "r", amountUsd: 0 })).toBe(false);
    expect(storage.raw()).toBeNull();
  });

  it("writes a note the callback can read back", () => {
    const storage = installStorage();
    expect(stashPendingTip({ spaceId: "space-9", reference: "r9", amountUsd: 2.5 })).toBe(true);
    const claim = claimPendingTip("r9", Date.now());
    expect(claim?.spaceId).toBe("space-9");
    expect(claim?.amountUsd).toBe(2.5);
    expect(claim?.message).toBe("");
    expect(storage.raw()).toBeNull();
  });

  it("re-notes a retried checkout instead of leaving two claims behind", () => {
    // A first attempt that failed in the widget, then a second at a different
    // amount under the same reference: the retry is what settles.
    const storage = installStorage();
    stashPendingTip({ spaceId: "space-1", reference: "r1", amountUsd: 1 });
    expect(stashPendingTip({ spaceId: "space-1", reference: "r1", amountUsd: 10 })).toBe(true);
    expect(storage.list()).toHaveLength(1);
    expect(claimPendingTip("r1", Date.now())?.amountUsd).toBe(10);
  });

  it("keeps unrelated rooms in flight side by side", () => {
    const storage = installStorage();
    stashPendingTip({ spaceId: "space-1", reference: "rA", amountUsd: 1 });
    stashPendingTip({ spaceId: "space-2", reference: "rB", amountUsd: 2 });
    expect(storage.list().map((t) => t.spaceId)).toEqual(["space-2", "space-1"]);
  });

  it("does not read the room's storage as a claim when stashing", () => {
    // A note sitting in storage must not block a new tip, and must not vanish.
    // `at` is the real clock here because stashing purges by real age.
    const storage = installStorage(
      JSON.stringify([tip({ reference: "ps_other", at: Date.now() - 1000 })]),
    );
    expect(stashPendingTip({ spaceId: "space-3", reference: "r3", amountUsd: 3 })).toBe(true);
    expect(storage.list().map((t) => t.reference)).toEqual(["r3", "ps_other"]);
  });
});
