import { useId, useState } from "react";
import { Smile } from "lucide-react";

import { EmojiPicker } from "@/components/social/EmojiPicker";
import { sanitizeReactionEmoji } from "@/lib/emojis";
import { cn } from "@/lib/utils";

interface LogoEmojiFieldProps {
  /** Text above the field; also names the picker button for screen readers. */
  label: string;
  value: string;
  onChange: (emoji: string) => void;
  /** Classes for the text field, so each host keeps its own skin. */
  inputClassName?: string;
}

/**
 * A workspace logo glyph: type one, or pick one from the real picker.
 *
 * Three hosts used to hand-roll this as a bare `<input maxLength={2}>`, which
 * quietly mangled most emoji. `maxLength` counts UTF-16 units, and a modern
 * glyph is several of them: a 2-unit cap reduced 🧑‍💻 to a face with no laptop
 * and 👍🏽 to a hand with no skin tone, while a 4-unit cap cut ❤️‍🔥 between the
 * joiner and its flame and left the dangling half in the database. Code points
 * are the unit that survives a copy, a paste and Postgres, so the value is
 * capped in those by `sanitizeReactionEmoji` — the same boundary a reaction
 * already passes through.
 *
 * The panel opens as a centred overlay rather than anchored to the field, for
 * the same reason the reaction picker in messages does: these inputs live in
 * dialogs and scroll boxes that clip an absolutely positioned child.
 */
export function LogoEmojiField({ label, value, onChange, inputClassName }: LogoEmojiFieldProps) {
  const [picking, setPicking] = useState(false);
  const fieldId = useId();

  return (
    <div>
      <label
        htmlFor={fieldId}
        className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </label>
      <div className="mt-1 flex items-stretch gap-1">
        <input
          id={fieldId}
          type="text"
          value={value}
          onChange={(e) => onChange(sanitizeReactionEmoji(e.target.value))}
          placeholder="✨"
          aria-label={`${label} emoji`}
          className={cn(
            "w-full min-w-0 rounded-xl border border-border bg-muted/40 text-center text-xl outline-none focus:border-brand",
            inputClassName,
          )}
        />
        <button
          type="button"
          onClick={() => setPicking(true)}
          aria-label={`Pick a ${label.toLowerCase()} emoji`}
          aria-expanded={picking}
          className="grid aspect-square shrink-0 place-items-center rounded-xl border border-border bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
        >
          <Smile className="h-4 w-4" />
        </button>
      </div>

      {picking && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setPicking(false)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <EmojiPicker
              label={label}
              className="relative bottom-0 m-3 w-[20rem]"
              onClose={() => setPicking(false)}
              // A logo is one glyph: picking replaces what is there instead of
              // building a sentence out of emojis the 4rem circle cannot show.
              onPick={(emoji) => {
                onChange(emoji);
                setPicking(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
