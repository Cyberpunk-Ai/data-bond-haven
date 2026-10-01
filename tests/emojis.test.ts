import { describe, expect, it } from "vitest";

import {
  ALL_EMOJIS,
  CALL_REACTIONS,
  EMOJI_CATEGORIES,
  MAX_RECENT_EMOJI,
  QUICK_REACTIONS,
  SPACE_REACTIONS,
  TIP_REACTION,
  normalizeSearchTerm,
  parseRecentEmojis,
  pushRecent,
  sanitizeReactionEmoji,
  searchEmojis,
} from "@/lib/emojis";

/**
 * The picker that replaces a button which appended " ✨".
 *
 * The complaint was "we don't have a variety of emojis" — literally true: the
 * compose bar had one hardcoded emoji behind a smiley that looked like a picker,
 * and the reaction rows had five or six glyphs chosen for the user. The rules
 * worth pinning are the ones that decide what a search returns and what a
 * reaction may contain.
 */

describe("the set is real and usable", () => {
  it("has enough emoji to be called a picker", () => {
    expect(ALL_EMOJIS.length).toBeGreaterThan(200);
    expect(EMOJI_CATEGORIES.length).toBeGreaterThanOrEqual(6);
  });

  it("names every category and never repeats a character in one", () => {
    for (const category of EMOJI_CATEGORIES) {
      expect(category.label).toBeTruthy();
      expect(category.emojis.length).toBeGreaterThan(8);
      const chars = new Set(category.emojis.map((e) => e.char));
      expect(chars.size).toBe(category.emojis.length);
      for (const entry of category.emojis) {
        expect(entry.name).toBeTruthy();
        expect(entry.haystack).toBe(entry.haystack.toLowerCase());
      }
    }
  });

  it("puts every quick reaction in the searchable set", () => {
    // A quick reaction that cannot be found again by search is a dead end for
    // the picker's recents row.
    const pool = new Set(ALL_EMOJIS.map((e) => e.char));
    for (const emoji of [...QUICK_REACTIONS, ...CALL_REACTIONS, ...SPACE_REACTIONS, TIP_REACTION]) {
      expect(pool.has(emoji)).toBe(true);
    }
  });

  it("keeps the call strip short enough for one row on a phone", () => {
    expect(CALL_REACTIONS.length).toBeLessThanOrEqual(8);
    expect(QUICK_REACTIONS.length).toBeLessThanOrEqual(10);
    expect(SPACE_REACTIONS.length).toBeLessThanOrEqual(8);
  });

  it("keeps a tap bar and a tip celebration distinct", () => {
    // 💰 is what a settled tip throws up. A person who taps it themselves would
    // be celebrating money that never arrived, so it is not offered as a tap.
    expect(SPACE_REACTIONS).not.toContain(TIP_REACTION);
  });
});

describe("search finds what a person would type", () => {
  it("normalises before matching", () => {
    expect(normalizeSearchTerm("  Red   HEART ")).toBe("red heart");
    expect(normalizeSearchTerm("   ")).toBe("");
  });

  it("requires every word to match, so 'red heart' is not every heart", () => {
    const hearts = searchEmojis("red heart", 10);
    expect(hearts.length).toBeGreaterThan(0);
    expect(hearts[0].char).toBe("❤️");
    for (const found of hearts) {
      expect(found.haystack).toContain("red");
      expect(found.haystack).toContain("heart");
    }
  });

  it("ranks an exact name above a name that merely contains it", () => {
    const fire = searchEmojis("fire");
    expect(fire[0].name).toBe("fire");
    expect(fire[0].char).toBe("🔥");
  });

  it("searches the keywords too, not just the official name", () => {
    expect(searchEmojis("thumbs up")[0]?.char).toBe("👍");
    expect(searchEmojis("laugh").length).toBeGreaterThan(1);
    expect(searchEmojis("celebrate").length).toBeGreaterThan(0);
  });

  it("returns nothing for a term that means no emoji, and for empty input", () => {
    expect(searchEmojis("qqqqzzz")).toEqual([]);
    expect(searchEmojis("")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(searchEmojis("heart", 3).length).toBeLessThanOrEqual(3);
  });
});

describe("recents remember without misbehaving", () => {
  it("moves a repeat to the front instead of duplicating it", () => {
    const next = pushRecent(["🔥", "❤️"], "🔥");
    expect(next).toEqual(["🔥", "❤️"]);
  });

  it("caps the list", () => {
    let recents: string[] = [];
    for (const entry of ALL_EMOJIS) recents = pushRecent(recents, entry.char, MAX_RECENT_EMOJI);
    expect(recents.length).toBe(MAX_RECENT_EMOJI);
    expect(recents[0]).toBe(ALL_EMOJIS[ALL_EMOJIS.length - 1].char);
  });

  it("reads back only what a browser could honestly have stored", () => {
    expect(parseRecentEmojis(null)).toEqual([]);
    expect(parseRecentEmojis("not json")).toEqual([]);
    expect(parseRecentEmojis('{"a":1}')).toEqual([]);
    expect(parseRecentEmojis('["🔥",42,null,"❤️"]')).toEqual(["🔥", "❤️"]);
  });
});

describe("a reaction is an emoji, not a payload", () => {
  it("bounds what the message table will accept", () => {
    // `message_reactions.emoji` is plain text and the value is rendered straight
    // into the thread, so "anything a button sends" is not a safe assumption.
    expect(sanitizeReactionEmoji("❤️")).toBe("❤️");
    expect(sanitizeReactionEmoji("  🔥  ")).toBe("🔥");
    expect(sanitizeReactionEmoji("a".repeat(400))).toHaveLength(8);
    expect(sanitizeReactionEmoji("\r\n")).toBe("");
    expect(sanitizeReactionEmoji(null)).toBe("");
    expect(sanitizeReactionEmoji(42)).toBe("");
  });

  it("refuses to add an empty glyph to recents", () => {
    expect(pushRecent(["❤️"], "")).toEqual(["❤️"]);
  });
});
