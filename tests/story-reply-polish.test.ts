// @vitest-environment node
/**
 * Story replies are DMs to the author, and the reply box lives inside an
 * auto-advancing carousel. These contracts keep the honest, well-targeted
 * behaviour:
 *  - the DM body quotes the story only when there is text, and only ellipsizes
 *    text that was actually truncated;
 *  - composing freezes the carousel and owns the keyboard (arrows move the
 *    caret, not the story);
 *  - a failed send keeps the draft and says so — never a fake "Reply sent";
 *  - a draft never follows the viewer onto someone else's story;
 *  - you can't DM yourself, so your own stories show a heart, not a reply box.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storyReplyBody } from "@/lib/formatters";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const between = (src: string, start: string, end: string) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  expect(a, `missing marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing marker: ${end}`).toBeGreaterThanOrEqual(0);
  return src.slice(a, b);
};

describe("storyReplyBody quotes the story honestly", () => {
  it("quotes short text verbatim, with no trailing ellipsis", () => {
    expect(storyReplyBody({ text: "Hi" }, "lol")).toBe('Replied to your story "Hi": lol');
  });

  it("falls back to the caption, and to no quote for media-only stories", () => {
    expect(storyReplyBody({ caption: "sunset" }, "wow")).toBe(
      'Replied to your story "sunset": wow',
    );
    expect(storyReplyBody({}, "yo")).toBe("Replied to your story: yo");
    expect(storyReplyBody({ text: "   ", caption: null }, "yo")).toBe("Replied to your story: yo");
  });

  it("truncates long text at 40 chars, trimming the cut point before the ellipsis", () => {
    const exact = "a".repeat(40);
    expect(storyReplyBody({ text: exact }, "hi")).toBe(`Replied to your story "${exact}": hi`);

    const body = storyReplyBody({ text: "a".repeat(45) }, "hi");
    expect(body).toBe(`Replied to your story "${"a".repeat(40)}…": hi`);

    const midWord = storyReplyBody({ text: `${"ab ".repeat(14)}tail`, caption: null }, "x");
    expect(midWord).not.toContain(" …"); // no space before the ellipsis
  });
});

describe("composing a reply owns the viewer", () => {
  const modal = read("../src/components/social/StoryModal.tsx");

  it("freezes the carousel while the reply box has focus or a send is in flight", () => {
    // `|| holdClock` arrived with the smooth-paint work: a frame that cannot
    // paint yet is a third reason not to run the clock, alongside the two here.
    // `|| replyEmojiOpen` joined with the emoji picker: its search box takes the
    // caret off the reply, so `replyFocused` goes false mid-composition.
    expect(modal).toMatch(
      /if \(\s*!isOpen \|\|[\s\S]{0,300}?isPaused \|\|\s*replyFocused \|\|\s*replyEmojiOpen \|\|\s*sendingReply \|\|\s*holdClock\s*\)\s*return;/,
    );
    expect(modal).toContain("onFocus={() => setReplyFocused(true)}");
    expect(modal).toContain("onBlur={() => setReplyFocused(false)}");
    // A guard is not a freeze by itself: an interval already running only stops
    // when the effect re-runs, so every value the guard reads must also be a
    // dependency. `replyFocused`/`sendingReply` were once left out of that list
    // and typing a reply advanced the story anyway.
    const timer = between(modal, "// Auto-progress timer", "// Reset progress when index changes");
    const deps = timer.slice(timer.lastIndexOf("}, ["));
    for (const flag of [
      "isPaused",
      "replyFocused",
      "replyEmojiOpen",
      "sendingReply",
      "holdClock",
    ]) {
      expect(deps, `the timer effect must depend on ${flag}`).toContain(flag);
    }
  });

  it("keeps typing out of the story keyboard shortcuts", () => {
    const keys = between(
      modal,
      "// Keyboard navigation",
      "if (!isOpen || !currentStory || !author)",
    );
    expect(keys).toContain('el.tagName === "INPUT"');
    expect(keys).toContain('el.tagName === "TEXTAREA"');
    expect(keys).toContain("el.isContentEditable");
  });

  it("drops the draft when the story changes, so it can't retarget to a new author", () => {
    const reset = between(modal, "// Reset progress when index changes", "// Keyboard navigation");
    expect(reset).toContain('setReplyText("");');
    expect(reset).toContain("replyInputRef.current?.blur();");
  });
});

describe("send results are honest", () => {
  const modal = between(
    read("../src/components/social/StoryModal.tsx"),
    "async function handleSendReply",
    "const gradientClass",
  );

  it("keeps the draft and surfaces the error when the DM fails", () => {
    expect(modal).toContain("toast.error(friendlyError(err");
    expect(modal).toContain("Couldn't send your reply");
    // No fake success anywhere in the failure path (or in the file at all).
    expect(modal).not.toContain("toast.info");
    // The draft clears only after a confirmed send.
    const [tryBlock] = modal.split("} catch");
    expect(tryBlock).toContain('setReplyText("")');
    expect(modal.indexOf('setReplyText("")')).toBeLessThanOrEqual(modal.indexOf("} catch"));
  });

  it("emoji buttons draft into the reply box without claiming a reaction was sent", () => {
    const src = read("../src/components/social/StoryModal.tsx");
    expect(src).not.toContain("Reacted with");
    // Refocusing is the shared hook's job now: it puts the glyph at the caret,
    // then focuses the field and restores the caret after the render — the thing
    // a bare `replyInputRef.current?.focus()` used to do by hand, mid-append.
    expect(src).toMatch(/const insertReplyEmoji = useEmojiInsert\(replyInputRef,/);
    expect(src).toContain("onClick={() => insertReplyEmoji(emoji)}");
    expect(src).not.toMatch(/prev \? `\$\{prev\} \$\{emoji\}`/);
  });

  it("offers a heart, not a DM-to-self, on your own story", () => {
    const src = read("../src/components/social/StoryModal.tsx");
    expect(src).toContain("{isMyStory ? (");
    expect(src.indexOf("isMyStory ? (")).toBeLessThan(
      src.indexOf("<form onSubmit={handleSendReply}"),
    );
  });
});
