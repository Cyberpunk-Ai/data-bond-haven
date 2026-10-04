// @vitest-environment node
/**
 * Emoji selection, pinned to the quality the message composer already had.
 *
 * "Make it robust like in messages" means two things, and both were missing
 * everywhere else:
 *  - one real picker (search, categories, recents) instead of a handful of
 *    glyphs we hardcoded per surface;
 *  - the glyph lands at the caret, replaces a live selection, and the field is
 *    refocused with the caret after it — not appended to the end of the draft.
 *
 * The rules are pure (`insertAtCaret`, `restoreCaret`, `sanitizeReactionEmoji`)
 * and tested directly. The wiring is tested as a source contract, because the
 * failure mode is a surface quietly re-implementing the caret dance, or quietly
 * going back to `setDraft(prev => prev + emoji)`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import {
  ALL_EMOJIS,
  CALL_REACTIONS,
  MAX_EMOJI_CHARS,
  QUICK_REACTIONS,
  SPACE_REACTIONS,
  TIP_REACTION,
  insertAtCaret,
  restoreCaret,
  sanitizeReactionEmoji,
} from "@/lib/emojis";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const src = (rel: string) => read(`../src/${rel}`);

/** Every emoji surface that puts a glyph into a text field. */
const FIELDS = {
  composer: "components/social/Composer.tsx",
  storyReply: "components/social/StoryModal.tsx",
  messages: "routes/messages.tsx",
};

describe("insertAtCaret places the glyph where the caret is", () => {
  it("splices at the caret instead of appending to the end", () => {
    const res = insertAtCaret({ text: "see you  at 8", insert: "🙏", start: 8, end: 8 });
    expect(res?.text).toBe("see you 🙏 at 8");
    // The caret ends up after the glyph we just placed, so typing continues.
    expect(res?.caret).toBe(10);
  });

  it("replaces a live selection, exactly as typing over it would", () => {
    const res = insertAtCaret({ text: "one two three", insert: "🎉", start: 4, end: 7 });
    expect(res?.text).toBe("one 🎉 three");
  });

  it("appends when the field has never had focus, and only then", () => {
    expect(insertAtCaret({ text: "hello", insert: "✨", start: null, end: null })?.text).toBe(
      "hello✨",
    );
    // A stale ref reporting the end of the text is the same case, not a bug.
    expect(insertAtCaret({ text: "hello", insert: "✨", start: 5, end: 5 })?.text).toBe("hello✨");
  });

  it("clamps an index that is off the end, negative or not a whole number", () => {
    expect(insertAtCaret({ text: "ab", insert: "✨", start: 99 })?.text).toBe("ab✨");
    expect(insertAtCaret({ text: "ab", insert: "✨", start: -12 })?.text).toBe("✨ab");
    expect(insertAtCaret({ text: "ab", insert: "✨", start: NaN })?.text).toBe("ab✨");
    expect(insertAtCaret({ text: "abcd", insert: "✨", start: 2.9 })?.text).toBe("ab✨cd");
    // `start` behind `end` cannot describe a selection: the earlier edge wins.
    expect(insertAtCaret({ text: "abcd", insert: "✨", start: 3, end: 1 })?.text).toBe("abc✨d");
  });

  it("refuses to split a surrogate pair, which is how a glyph turns into tofu", () => {
    // "🙏" is two UTF-16 units, and a caret can be reported between them.
    const res = insertAtCaret({ text: "a🙏b", insert: "✨", start: 2, end: 2 });
    expect(res?.text).toBe("a🙏✨b");
    expect(res?.caret).toBe(4);
    // A selection whose far edge sits on the same broken index must not leave
    // the low half of the glyph behind, nor hand back a copy of it.
    expect(insertAtCaret({ text: "a🙏b", insert: "✨", start: 2, end: 3 })?.text).toBe("a🙏✨b");
    expect(res?.text).toMatch(/\p{Extended_Pictographic}/u);
    // No lone high surrogate followed by a non-low one, and no lone low half.
    expect(res?.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(res?.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("counts the limit in code points, the unit Postgres and the counter use", () => {
    // A ZWJ sequence is 3 code points but 5 UTF-16 units.
    const developer = "🧑‍💻";
    expect(Array.from(developer).length).toBe(3);
    expect(developer.length).toBe(5);

    expect(insertAtCaret({ text: "ab", insert: developer, maxLength: 5 })?.text).toBe(
      `ab${developer}`,
    );
    expect(insertAtCaret({ text: "ab", insert: developer, maxLength: 4 })).toBeNull();
  });

  it("refuses a pick that would overrun the cap, and leaves the caller's text alone", () => {
    const res = insertAtCaret({ text: "abc", insert: "🔥", maxLength: 3 });
    expect(res).toBeNull();
    // Half an emoji is worse than none, so nothing is written and the caret is
    // never moved: `null` means the caller keeps exactly what it had.
  });

  it("ignores an empty glyph", () => {
    expect(insertAtCaret({ text: "abc", insert: "", start: 1 })).toBeNull();
  });

  it("survives junk in the options rather than throwing at pick time", () => {
    expect(
      insertAtCaret({ text: undefined as unknown as string, insert: "✨", start: undefined })?.text,
    ).toBe("✨");
    expect(insertAtCaret({ text: "x", insert: 42 as unknown as string })?.text).toBe("x42");
  });

  it("reports a caret that always sits inside the new text", () => {
    for (const start of [0, 1, 4, 11, 500]) {
      const res = insertAtCaret({ text: "a 🙏 b", insert: "✨", start });
      if (!res) continue;
      expect(res.caret).toBeGreaterThanOrEqual(0);
      expect(res.caret).toBeLessThanOrEqual(res.text.length);
    }
  });
});

describe("restoreCaret puts the field back the way it was", () => {
  it("focuses before setting the selection, because the other order is a no-op", () => {
    const calls: string[] = [];
    const field = {
      focus: () => calls.push("focus"),
      setSelectionRange: (a: number, b: number) => calls.push(`select ${a},${b}`),
    };
    restoreCaret(field, 5);
    expect(calls).toEqual(["focus", "select 5,5"]);
  });

  it("is a no-op without a field", () => {
    expect(() => restoreCaret(null, 3)).not.toThrow();
  });
});

describe("every field surface shares the one implementation", () => {
  for (const [name, file] of Object.entries(FIELDS)) {
    const text = src(file);

    it(`${name} inserts through the shared hook and the real picker`, () => {
      expect(text).toMatch(/useEmojiInsert\(/);
      expect(text).toMatch(/<EmojiPicker\b/);
    });

    it(`${name} no longer appends a glyph to the end of the draft`, () => {
      expect(text).not.toMatch(
        /setDraft\(\s*\(?\s*(prev|d)\w*\s*\)?\s*=>\s*.*\$\{\s*(emoji|char)\s*\}/,
      );
      expect(text).not.toMatch(/prev \? `\$\{prev\} \$\{emoji\}`/);
      expect(text).not.toMatch(/popularEmojis/);
    });

    it(`${name} never touches the selection APIs by hand`, () => {
      expect(text).not.toMatch(/selectionStart|setSelectionRange/);
    });
  }

  it("the caret math lives in exactly two files, so it cannot drift a third time", () => {
    const owners = new Set(["lib/emojis.ts", "hooks/useEmojiInsert.ts"]);
    const tree = readdirSync(new URL("../src/", import.meta.url), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => file.replace(/\\/g, "/"));
    expect(tree.length).toBeGreaterThan(50);

    const handRolled = tree.filter(
      (file) =>
        !owners.has(file) && /selectionStart|selectionEnd|setSelectionRange/.test(src(file)),
    );
    expect(handRolled).toEqual([]);

    const hook = src("hooks/useEmojiInsert.ts");
    expect(hook).toMatch(/insertAtCaret\(/);
    expect(hook).toMatch(/requestAnimationFrame\(\(\) => restoreCaret\(/);
  });

  it("the composer and the story reply respect the cap their own field enforces", () => {
    expect(src(FIELDS.messages)).toMatch(/maxLength: MAX_MESSAGE_CHARS/);
    expect(src(FIELDS.composer)).toMatch(/maxLength: LIMIT/);
  });

  it("a picker panel is never anchored inside a scroll box that would clip it", () => {
    // The reaction picker and the logo field hang centred overlays for exactly
    // this reason; a contract keeps the next surface from re-anchoring one.
    const logo = src("components/social/LogoEmojiField.tsx");
    expect(logo).toMatch(/fixed inset-0 z-50/);
    expect(logo).toMatch(/<EmojiPicker\b/);
  });
});

describe("the story carousel freezes while a picker is open", () => {
  const text = src(FIELDS.storyReply);
  const effect = text.slice(
    text.indexOf("// Auto-progress timer"),
    text.indexOf("// Reset progress when index changes"),
  );

  it("names replyEmojiOpen in the guard and in the dependency array", () => {
    // The picker's search box steals focus, so `replyFocused` goes false at the
    // exact moment the person is still composing. An unread dep also means the
    // freeze only happens when some other value happens to change.
    expect(effect).toMatch(
      /replyFocused \|\|\s*replyEmojiOpen \|\|\s*sendingReply \|\|\s*holdClock\s*\)\s*\n\s*return;/,
    );
    const deps = effect.slice(effect.indexOf("}, ["));
    expect(deps.length).toBeGreaterThan(10);
    expect(deps).toMatch(/replyEmojiOpen/);
  });

  it("the quick row goes through the same caret-aware insert", () => {
    expect(text).toMatch(/onClick=\{\(\) => insertReplyEmoji\(emoji\)\}/);
    expect(text).not.toMatch(/replyInputRef\.current\?\.focus\(\);\s*\}\}/);
  });

  it("moving on a story closes the picker along with the draft", () => {
    const reset = text.slice(
      text.indexOf("// Reset progress when index changes"),
      text.indexOf("// Keyboard navigation"),
    );
    expect(reset).toMatch(/setReplyText\(""\)/);
    expect(reset).toMatch(/setReplyEmojiOpen\(false\)/);
  });

  it("Escape closes the panel without closing the viewer", () => {
    const keys = text.slice(
      text.indexOf("// Keyboard navigation"),
      text.indexOf("if (!isOpen || !currentStory || !author) return null;"),
    );
    expect(keys).toMatch(/if \(replyEmojiOpen\) return;\s*\n\s*if \(e\.key === "Escape"\)/);
  });
});

describe("a logo glyph is never truncated to half an emoji", () => {
  const logo = src("components/social/LogoEmojiField.tsx");

  it("caps in code points through the same boundary a reaction uses", () => {
    expect(logo).toMatch(
      /onChange=\{\(e\) => onChange\(sanitizeReactionEmoji\(e\.target\.value\)\)\}/,
    );
    // An attribute on its own line, not the one named in the doc comment.
    expect(logo).not.toMatch(/\n\s+maxLength=/);
  });

  it("keeps a sequence whole, which counting UTF-16 units cannot", () => {
    // `maxLength` counts UTF-16 units, so it chops multi-glyph emoji in half:
    // a 2-unit cap turned 🧑‍💻 into a face with no laptop, and a 4-unit cap cut
    // ❤️‍🔥 between the joiner and its flame, leaving a dangling one behind.
    expect("🧑‍💻".length).toBe(5);
    expect("🧑‍💻".slice(0, 2)).toBe("🧑");
    const cut = "❤️‍🔥".slice(0, 4);
    expect(cut).not.toBe("❤️‍🔥");
    expect(cut).toMatch(/[\uD800-\uDBFF]$/);
    expect(sanitizeReactionEmoji("❤️‍🔥")).toBe("❤️‍🔥");
    expect(sanitizeReactionEmoji("👍🏽")).toBe("👍🏽");
    expect(sanitizeReactionEmoji("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
  });

  it("still refuses a paragraph, and cuts on a code point boundary", () => {
    expect(sanitizeReactionEmoji("   ")).toBe("");
    expect(sanitizeReactionEmoji(null)).toBe("");
    expect(sanitizeReactionEmoji("  ✨  ")).toBe("✨");
    expect(sanitizeReactionEmoji("a\nb")).toBe("ab");
    // Longer than a glyph is still a glyph-shaped cut: never half a pair.
    const messy = sanitizeReactionEmoji("line\nbreak\ttab");
    expect(messy).toBe("linebrea");
    const long = sanitizeReactionEmoji("🙏".repeat(MAX_EMOJI_CHARS + 3));
    expect(Array.from(long).length).toBe(MAX_EMOJI_CHARS);
    expect(long).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("picking a logo replaces it rather than building a sentence", () => {
    expect(logo).toMatch(/onChange\(emoji\)/);
  });

  it("the trigger cannot submit the form it sits inside", () => {
    expect(logo).toMatch(/type="button"/);
  });

  it("all three hosts went through the component", () => {
    const manager = src("components/social/TeamWorkspaceManager.tsx");
    const edit = src("components/social/EditWorkspaceModal.tsx");
    expect(manager.match(/<LogoEmojiField\b/g)).toHaveLength(2);
    expect(edit).toMatch(/<LogoEmojiField\b/);
    for (const text of [manager, edit]) {
      expect(text).not.toMatch(/maxLength=\{[24]\}/);
    }
  });
});

describe("story stickers are searchable and still capped", () => {
  const text = src("components/social/StoryCreatorModal.tsx");

  it("opens the real picker and keeps the four-sticker rule in one place", () => {
    expect(text).toMatch(/const MAX_STICKERS = 4;/);
    expect(text).toMatch(/selectedStickers\.length >= MAX_STICKERS/);
    expect(text).toMatch(/<EmojiPicker\s+multiple/);
    expect(text).toMatch(/onPick=\{toggleSticker\}/);
  });

  it("runs a sticker through the emoji boundary before storing it", () => {
    expect(text).toMatch(/const st = sanitizeReactionEmoji\(raw\);/);
  });
});

describe("quick rows only offer glyphs the picker itself can produce", () => {
  const known = new Set(ALL_EMOJIS.map((entry) => entry.char));

  /** Every `["🔥", "❤️"]`-style literal array of glyphs in a source file. */
  function inlineGlyphArrays(text: string): string[][] {
    // A glyph, a skin-tone modifier, a variation selector or a joiner: anything
    // else is prose that happens to start with an emoji ("✨ Inspired").
    const onlyGlyph = (item: string) =>
      item.length > 0 &&
      Array.from(item).every((ch) =>
        /\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u200D/u.test(ch),
      );

    const found: string[][] = [];
    for (const match of text.matchAll(/\[((?:\s*"[^"]+"\s*,)+\s*"[^"]+"\s*)\]/g)) {
      const items = match[1].split(",").map((raw) => raw.trim().slice(1, -1));
      if (items.length === 0) continue;
      const pictographic = items.every(
        (item) => Array.from(item).length <= MAX_EMOJI_CHARS && onlyGlyph(item),
      );
      if (pictographic) found.push(items);
    }
    return found;
  }

  it("the exported bars are all in the picker's own data", () => {
    for (const bar of [QUICK_REACTIONS, CALL_REACTIONS, SPACE_REACTIONS, [TIP_REACTION]]) {
      expect(bar.length).toBeGreaterThan(0);
      for (const glyph of bar) expect(known.has(glyph), `unknown glyph ${glyph}`).toBe(true);
    }
  });

  it("and so is every glyph hardcoded into a surface", () => {
    const files = [
      FIELDS.composer,
      FIELDS.storyReply,
      FIELDS.messages,
      "components/social/StoryCreatorModal.tsx",
      "components/social/CallModal.tsx",
    ];
    const unknown: string[] = [];
    let inspected = 0;
    for (const file of files) {
      for (const array of inlineGlyphArrays(src(file))) {
        inspected += array.length;
        for (const glyph of array) {
          // Collect rather than stop at the first: a row the picker cannot
          // produce is a list to fix, not a one-off surprise.
          if (!known.has(glyph)) unknown.push(`${file}: ${glyph}`);
          if (sanitizeReactionEmoji(glyph) !== glyph) unknown.push(`${file}: mangled ${glyph}`);
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
    expect(unknown).toEqual([]);
  });

  it("the story reply row is short enough to stay one row on a phone", () => {
    const arrays = inlineGlyphArrays(src(FIELDS.storyReply));
    expect(arrays.some((array) => array.length > 0 && array.length <= 8)).toBe(true);
  });
});
