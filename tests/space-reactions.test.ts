import { describe, expect, it } from "vitest";

import {
  MAX_TIP_ALERTS,
  MAX_VISIBLE_REACTIONS,
  REACTION_LANES,
  REACTION_LIFE_MS,
  REACTION_TALLY_WINDOW_MS,
  REACTION_TAP_COOLDOWN_MS,
  TIP_ALERT_MS,
  TIP_NOTE_CHARS,
  TIP_SPARKLE_COUNT,
  applyReactions,
  canTapReaction,
  dismissTipAlert,
  emptyReactionLayer,
  nextTipAlertDelay,
  pruneReactionLayer,
  pruneTipAlerts,
  pushTipAlert,
  readReactionPayload,
  readTipAlert,
  reactionFor,
  reactionId,
  reactionLeftPercent,
  sortedTally,
  tipAnnouncement,
  tipSparkles,
} from "@/lib/space-reactions";
import type { FloatingReaction, TipAlert } from "@/lib/space-reactions";
import { TIP_REACTION } from "@/lib/emojis";

/**
 * The room's celebration layer, which used to be a local-only `setState`.
 *
 * The complaint: "in spaces reactions don't show to other space members" — true
 * down to the line, because the tap handler appended to its own screen's array
 * and nothing was ever broadcast. What is worth pinning is the shared contract
 * that replaces it: what a payload must contain to be shown at all, the layout
 * every member has to agree on, the dedupe that stops a retry drawing twice,
 * and the tip rules that used to invent a $5 figure when an event omitted one.
 */

const AT = 1_700_000_000_000;

function float(id: string, emoji = "❤️", at = AT) {
  return reactionFor(id, emoji, at);
}

describe("a reaction payload is validated before anything is drawn", () => {
  it("accepts a real glyph with a real id", () => {
    expect(readReactionPayload({ id: "rx_1", emoji: "🔥" })).toEqual({ id: "rx_1", emoji: "🔥" });
  });

  it("refuses an event with no id, no emoji, or neither", () => {
    expect(readReactionPayload({ emoji: "❤️" })).toBeNull();
    expect(readReactionPayload({ id: "  ", emoji: "❤️" })).toBeNull();
    expect(readReactionPayload({ id: "rx_1" })).toBeNull();
    expect(readReactionPayload(null)).toBeNull();
    expect(readReactionPayload("❤️")).toBeNull();
  });

  it("keeps a paragraph out of the room: an emoji is bounded by the emoji rules", () => {
    const read = readReactionPayload({ id: "rx_1", emoji: "❤️".repeat(40) });
    expect(read?.emoji.length).toBeLessThanOrEqual("❤️".repeat(4).length);
  });

  it("trims an over-long id so the dedupe memory cannot be inflated", () => {
    const read = readReactionPayload({ id: "x".repeat(500), emoji: "🔥" });
    expect(read?.id.length).toBeLessThanOrEqual(64);
  });

  it("gives every tap its own id, and a predictable shape", () => {
    const a = reactionId("user-1", AT, "abc");
    const b = reactionId("user-1", AT, "def");
    expect(a).not.toBe(b);
    expect(a.startsWith("rx_user-1_")).toBe(true);
  });
});

describe("every member computes the same layout", () => {
  it("derives position from the id alone, not from the clock or the device", () => {
    // Two devices running this with the same event id must show the emoji in the
    // same place; a random left made each screen its own version of the room.
    const here = reactionFor("rx_same", "🔥", AT);
    const there = reactionFor("rx_same", "🔥", 999_999);
    expect({ ...here, at: 0 }).toEqual({ ...there, at: 0 });
    // Only the arrival time, which the layer needs to age the emoji out.
    expect(here.at).toBe(AT);
    expect(there.at).toBe(999_999);
  });

  it("spreads lanes across the room without reaching the edges", () => {
    const lefts = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const r = float(`user_${i}_tap`);
      expect(r.lane).toBeGreaterThanOrEqual(0);
      expect(r.lane).toBeLessThan(REACTION_LANES);
      expect(r.left).toBeGreaterThanOrEqual(8);
      expect(r.left).toBeLessThanOrEqual(92);
      lefts.add(r.left);
    }
    // Ten taps must not all land in one lane.
    expect(lefts.size).toBeGreaterThan(3);
  });

  it("finishes its arc before the room drops it", () => {
    // If `duration` outlived `REACTION_LIFE_MS` the fade would be truncated and
    // read as a pop. The two constants are one promise, so pin the relationship.
    for (let i = 0; i < 300; i++) {
      expect(float(`id_${i}`).duration).toBeLessThanOrEqual(REACTION_LIFE_MS);
      expect(float(`id_${i}`).duration).toBeGreaterThan(0);
    }
  });

  it("keeps the tip bags taller than the room's bottom padding", () => {
    // Travel distance is what makes a float read as a float at all.
    for (let i = 0; i < 50; i++) {
      expect(float(`rise_${i}`).rise).toBeGreaterThan(80);
    }
  });
});

describe("the layer dedupes, caps and ages itself", () => {
  it("draws a tap that arrives twice exactly once", () => {
    const seen = new Set<string>();
    const once = applyReactions(emptyReactionLayer(), seen, [float("rx_dup")], AT);
    const twice = applyReactions(once, seen, [float("rx_dup")], AT);
    expect(twice.visible).toHaveLength(1);
    expect(twice).toBe(once); // untouched: the same reference, so no re-render
    expect(twice.tally[0].count).toBe(1);
  });

  it("shows the room's own copy and another member's copy side by side", () => {
    const seen = new Set<string>();
    const layer = applyReactions(
      emptyReactionLayer(),
      seen,
      [float("rx_mine"), float("rx_theirs")],
      AT,
    );
    expect(layer.visible.map((v) => v.id)).toEqual(["rx_mine", "rx_theirs"]);
  });

  it("drops the oldest when a flood arrives, and never exceeds the cap", () => {
    const seen = new Set<string>();
    let layer = emptyReactionLayer();
    for (let i = 0; i < MAX_VISIBLE_REACTIONS + 20; i++) {
      layer = applyReactions(layer, seen, [float(`flood_${i}`)], AT);
    }
    expect(layer.visible.length).toBe(MAX_VISIBLE_REACTIONS);
    expect(layer.visible[layer.visible.length - 1].id).toBe(`flood_${MAX_VISIBLE_REACTIONS + 19}`);
    expect(layer.visible[0].id).toBe("flood_20");
  });

  it("ages floaters out and says nothing when there was nothing to do", () => {
    const seen = new Set<string>();
    const layer = applyReactions(emptyReactionLayer(), seen, [float("rx_old")], AT);
    expect(pruneReactionLayer(layer, AT + REACTION_LIFE_MS - 1).visible).toHaveLength(1);
    expect(pruneReactionLayer(layer, AT + REACTION_LIFE_MS).visible).toHaveLength(0);
    // Identity is preserved when the answer is already clean.
    expect(pruneReactionLayer(layer, AT)).toBe(layer);
  });

  it("ignores an empty or junk float rather than rendering undefined", () => {
    const seen = new Set<string>();
    const empty = emptyReactionLayer();
    // What a broken broadcast can actually hand over: holes, and a glyph that
    // never got filled in.
    const junk = [null, { id: "no_emoji", emoji: "", lane: 0 }] as unknown as FloatingReaction[];
    const layer = applyReactions(empty, seen, junk, AT);
    expect(layer).toBe(empty);
    expect(layer.visible).toHaveLength(0);
  });
});

describe("the running count next to the bar", () => {
  it("counts each glyph separately, busiest first", () => {
    const seen = new Set<string>();
    let layer = emptyReactionLayer();
    for (let i = 0; i < 3; i++) layer = applyReactions(layer, seen, [float(`h_${i}`, "❤️")], AT);
    layer = applyReactions(layer, seen, [float("f_0", "🔥")], AT);
    layer = applyReactions(layer, seen, [float("f_1", "🔥")], AT);
    expect(sortedTally(layer.tally, AT)).toEqual([
      { emoji: "❤️", count: 3, at: AT },
      { emoji: "🔥", count: 2, at: AT },
    ]);
  });

  it("goes quiet after the window so a stale total never hangs around", () => {
    const seen = new Set<string>();
    const layer = applyReactions(emptyReactionLayer(), seen, [float("rx_1")], AT);
    expect(sortedTally(layer.tally, AT + REACTION_TALLY_WINDOW_MS)).toEqual([]);
  });

  it("shows at most one row of chips", () => {
    const seen = new Set<string>();
    let layer = emptyReactionLayer();
    for (const emoji of ["❤️", "🔥", "👏", "🙌", "🚀", "💡"]) {
      layer = applyReactions(layer, seen, [float(`many_${emoji}`, emoji)], AT);
    }
    expect(sortedTally(layer.tally, AT).length).toBeLessThanOrEqual(4);
  });
});

describe("a held-down button cannot flood the room", () => {
  it("lets the first tap through and swallows the ones inside the cooldown", () => {
    expect(canTapReaction(0, AT)).toBe(true);
    expect(canTapReaction(AT, AT + 1)).toBe(false);
    expect(canTapReaction(AT, AT + REACTION_TAP_COOLDOWN_MS)).toBe(true);
  });

  it("drops a tap that claims to have happened before the last one", () => {
    // A client whose clock jumped backwards must not be able to bypass the guard.
    expect(canTapReaction(AT, AT - 10_000)).toBe(false);
  });
});

describe("a settled tip celebrates without inventing anything", () => {
  const base = { id: "tip_1", sender_name: "Amina", amount: 5, message: "great room" };

  it("refuses to show a figure that never arrived", () => {
    // The banner used to default a missing amount to $5: money on screen that
    // nobody had paid. No amount, no celebration.
    expect(readTipAlert({ id: "t", sender_name: "Amina" }, { at: AT })).toBeNull();
    expect(readTipAlert({ ...base, amount: 0 }, { at: AT })).toBeNull();
    expect(readTipAlert({ ...base, amount: -3 }, { at: AT })).toBeNull();
    expect(readTipAlert({ ...base, amount: "abc" }, { at: AT })).toBeNull();
    expect(readTipAlert(null, { at: AT })).toBeNull();
  });

  it("keeps a real amount and rounds it to cents", () => {
    expect(readTipAlert({ ...base, amount: 5.009 }, { at: AT })?.amount).toBe(5.01);
    expect(readTipAlert({ ...base, amount: "12.5" }, { at: AT })?.amount).toBe(12.5);
  });

  it("names the person from the best evidence it is given", () => {
    expect(readTipAlert(base, { at: AT })?.senderName).toBe("Amina");
    expect(
      readTipAlert({ ...base, sender_name: "" }, { at: AT, senderName: "Kelo" })?.senderName,
    ).toBe("Kelo");
    // Neither the event nor the cache knows them: a truthful label, not a
    // somebody's-UUID rendered as a name.
    expect(readTipAlert({ id: "t", amount: 1 }, { at: AT })?.senderName).toBe("A supporter");
  });

  it("bounds a note pasted out of the broadcast", () => {
    const alert = readTipAlert({ ...base, message: "hi\r\n" + "y".repeat(500) }, { at: AT });
    expect(alert?.message).not.toContain("\n");
    expect(alert?.message?.length).toBeLessThanOrEqual(TIP_NOTE_CHARS);
    expect(alert?.message?.endsWith("…")).toBe(true);
  });

  it("lives for exactly the announced time", () => {
    const alert = readTipAlert(base, { at: AT });
    expect(alert?.expiresAt).toBe(AT + TIP_ALERT_MS);
    expect(readTipAlert(base, { at: AT, ttlMs: 1000 })?.expiresAt).toBe(AT + 1000);
  });

  it("is ignored entirely when the room has already applied its id", () => {
    const seen = new Set<string>();
    const floats = tipSparkles("tip_1", AT);
    const once = applyReactions(emptyReactionLayer(), seen, floats, AT);
    const again = applyReactions(once, seen, tipSparkles("tip_1", AT), AT);
    expect(again).toBe(once);
    expect(again.visible.length).toBe(TIP_SPARKLE_COUNT);
  });

  it("throws a bounded burst of the tip's own glyph", () => {
    const floats = tipSparkles("tip_9", AT);
    expect(floats).toHaveLength(TIP_SPARKLE_COUNT);
    for (const f of floats) expect(f.emoji).toBe(TIP_REACTION);
    expect(new Set(floats.map((f) => f.id)).size).toBe(TIP_SPARKLE_COUNT);
    // Staggered on purpose: bags that start in the same instant read as one.
    expect(floats.map((f) => f.at)).toEqual([AT, AT + 90, AT + 180]);
    for (const f of floats) expect(f.duration).toBeLessThanOrEqual(REACTION_LIFE_MS);
  });

  it("spreads a run of tips over the room rather than one column", () => {
    const lefts = new Set<number>();
    for (let i = 0; i < 12; i++) {
      for (const f of tipSparkles(`tip_${i}`, AT)) lefts.add(f.left);
    }
    expect(lefts.size).toBeGreaterThan(2);
  });
});

describe("a run of tips queues up instead of overwriting", () => {
  const alert = (id: string, at = AT) =>
    readTipAlert({ id, sender_name: "Amina", amount: 1 }, { at })!;

  it("holds the newest few and drops the oldest", () => {
    let list: TipAlert[] = [];
    for (let i = 0; i < MAX_TIP_ALERTS + 2; i++) list = pushTipAlert(list, alert(`t_${i}`));
    expect(list).toHaveLength(MAX_TIP_ALERTS);
    expect(list.map((t) => t.id)).toEqual(["t_2", "t_3", "t_4"]);
  });

  it("answers one timer for the whole stack, armed on the earliest expiry", () => {
    expect(nextTipAlertDelay([], AT)).toBeNull();
    const list = [alert("a"), alert("b", AT + 500)];
    expect(nextTipAlertDelay(list, AT)).toBe(TIP_ALERT_MS);
    expect(nextTipAlertDelay(list, AT + 1_000)).toBe(TIP_ALERT_MS - 1_000);
    // Already elapsed: hand back zero and let the caller prune.
    expect(nextTipAlertDelay(list, AT + TIP_ALERT_MS)).toBe(0);
  });

  it("keeps a live banner when an older one expires", () => {
    // This is the bug the per-tip setTimeout created: the first tip's timer
    // dismissed whichever banner was on screen when it fired.
    const list = [alert("a"), alert("b", AT + 2_000)];
    expect(pruneTipAlerts(list, AT + TIP_ALERT_MS).map((t) => t.id)).toEqual(["b"]);
    expect(pruneTipAlerts(list, AT)).toBe(list);
  });

  it("dismisses exactly the banner a person closed", () => {
    const list = [alert("a"), alert("b")];
    expect(dismissTipAlert(list, "a").map((t) => t.id)).toEqual(["b"]);
    expect(dismissTipAlert(list, "missing")).toBe(list);
  });
});

it("anchors the room's bottom lane above its own padding", () => {
  // reactionLeftPercent is the shared contract between the layer and the bar.
  expect(reactionLeftPercent(0)).toBe(8);
  expect(reactionLeftPercent(REACTION_LANES - 1)).toBe(92);
});

describe("the line a settled tip leaves in the room's chat", () => {
  it("states the amount the payment provider confirmed", () => {
    // The row is an ordinary room message written by the person who paid, so it
    // reads "Amina: tipped $5.00 to the room" and survives a refresh — which is
    // more than an ephemeral banner can promise.
    expect(tipAnnouncement(5)).toBe("tipped $5.00 to the room");
    expect(tipAnnouncement("12.5")).toBe("tipped $12.50 to the room");
  });

  it("quotes the note when there is one", () => {
    expect(tipAnnouncement(2, "lovely stream")).toBe("tipped $2.00: “lovely stream”");
  });

  it("writes nothing at all rather than a line about money that never arrived", () => {
    for (const amount of [0, -5, "abc", undefined, null, Number.NaN]) {
      expect(tipAnnouncement(amount, "note")).toBe("");
    }
  });

  it("keeps a note to one line and one sentence's length", () => {
    const line = tipAnnouncement(1, "a\r\nb");
    expect(line).toBe("tipped $1.00: “a b”");
    const long = tipAnnouncement(1, "y".repeat(400));
    const prefix = "tipped $1.00: “";
    // The row rides the room's chat, which the database bounds at 2000 chars;
    // a supporter's one-line note should not eat the whole allowance.
    expect(long.length).toBeLessThanOrEqual(prefix.length + TIP_NOTE_CHARS + 1);
    expect(long.endsWith("…”")).toBe(true);
  });

  it("treats a whitespace-only note as no note", () => {
    expect(tipAnnouncement(3, "   \n  ")).toBe("tipped $3.00 to the room");
  });
});
