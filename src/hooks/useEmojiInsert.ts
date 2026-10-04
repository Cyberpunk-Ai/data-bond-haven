import { useCallback, type RefObject } from "react";

import { insertAtCaret, restoreCaret } from "@/lib/emojis";

/**
 * The part of an input or textarea an emoji picker needs, declared structurally
 * so one hook serves `<input>`, `<textarea>` and a test fake alike.
 */
type EmojiField = {
  selectionStart: number | null;
  selectionEnd: number | null;
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
};

/**
 * Give a field the picker behaviour the message composer has.
 *
 * Returns a stable-ish `insert(emoji)` the picker's `onPick` can take directly,
 * and reports `false` when the glyph was refused (over the limit, or not an
 * emoji at all) so a caller can react — a silent no-op is how a picker comes to
 * look broken while the caret stays where it was.
 *
 * The two details that make this worth centralising are both easy to get wrong
 * once per surface: the caret position has to be read *before* the state update
 * and restored *after* the render that applies it, and a caller that appends
 * instead will move the glyph to the end of whatever the person was writing.
 */
export function useEmojiInsert(
  fieldRef: RefObject<EmojiField | null>,
  text: string,
  setText: (next: string) => void,
  options?: { maxLength?: number; onRefused?: (emoji: string) => void },
): (emoji: string) => boolean {
  const { maxLength, onRefused } = options ?? {};

  return useCallback(
    (emoji: string) => {
      const field = fieldRef.current;
      const result = insertAtCaret({
        text,
        insert: emoji,
        start: field?.selectionStart ?? text.length,
        end: field?.selectionEnd ?? text.length,
        maxLength,
      });
      if (!result) {
        onRefused?.(emoji);
        return false;
      }
      setText(result.text);
      // After the paint, not immediately: writing a selection onto the node that
      // still holds the previous value is undone by the render coming after it.
      requestAnimationFrame(() => restoreCaret(field, result.caret));
      return true;
    },
    [fieldRef, maxLength, onRefused, setText, text],
  );
}
