import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  EMOJI_CATEGORIES,
  MAX_RECENT_EMOJI,
  RECENT_EMOJI_STORAGE_KEY,
  parseRecentEmojis,
  pushRecent,
  searchEmojis,
} from "@/lib/emojis";
import { cn } from "@/lib/utils";

interface EmojiPickerProps {
  /** Called with the chosen character; the picker stays open only if you ask it to. */
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Positioning classes for the panel itself (it is absolutely positioned). */
  className?: string;
  /**
   * Optional inline style for the panel. Passing `position: "fixed"` with
   * measured coordinates lets the caller hoist the panel out of a scrolling /
   * clipping toolbar (an `overflow-x-auto` compose bar would otherwise cut it).
   */
  style?: CSSProperties;
  /** Keep the picker open after a pick — useful for building a message. */
  multiple?: boolean;
  label?: string;
}

/**
 * Recents live in localStorage, not in `user_preferences`.
 *
 * They are a typing shortcut tied to the keyboard you are using, like a phone's
 * own emoji history — a shared login on a borrowed tablet should not push your
 * recents onto it, and a migration plus a round trip for twenty glyphs is not
 * worth it. Unreadable JSON simply means no recents.
 */
function readStoredRecents(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    return parseRecentEmojis(localStorage.getItem(RECENT_EMOJI_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeStoredRecents(recents: string[]) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(RECENT_EMOJI_STORAGE_KEY, JSON.stringify(recents));
  } catch {
    /* private mode or a full quota: the picker still works, just without memory */
  }
}

/**
 * A real emoji picker: search, categories and a recents row.
 *
 * Before this, the compose bar's smiley button appended a fixed " ✨" to your
 * message, so every emoji you sent was the one we picked. The panel is a plain
 * absolutely positioned card (matching the attachment menu) rather than a dialog,
 * because the caller decides where it belongs — above the composer, or beside a
 * message.
 */
export function EmojiPicker({
  onPick,
  onClose,
  className,
  style,
  multiple = false,
  label = "Emoji",
}: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState(EMOJI_CATEGORIES[0]?.id ?? "");
  const [recents, setRecents] = useState<string[]>(readStoredRecents);
  const searching = query.trim().length > 0;
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus matters more than the animation finishing: a keyboard user opening
    // the picker expects to type straight into the search box.
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const results = useMemo(() => (searching ? searchEmojis(query, 56) : []), [query, searching]);

  const category = useMemo(
    () => EMOJI_CATEGORIES.find((c) => c.id === categoryId) ?? EMOJI_CATEGORIES[0],
    [categoryId],
  );

  const choose = useCallback(
    (emoji: string) => {
      const next = pushRecent(recents, emoji, MAX_RECENT_EMOJI);
      setRecents(next);
      writeStoredRecents(next);
      onPick(emoji);
      if (!multiple) onClose();
    },
    [multiple, onPick, onClose, recents],
  );

  // While a person is searching we show only the matches: falling back to the
  // category grid here would put fifty unrelated faces under "No emoji matches".
  const grid = searching ? results : (category?.emojis ?? []);

  return (
    <>
      {/* A transparent catcher: the first tap outside closes the panel instead of
          landing on whatever is underneath and being lost. */}
      <button
        type="button"
        aria-label="Close emoji picker"
        onClick={onClose}
        className="fixed inset-0 z-30 cursor-default"
      />
      <div
        role="dialog"
        aria-label={label}
        style={style}
        className={cn(
          "absolute z-40 w-[19rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-card/98 p-2 shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2",
          className,
        )}
      >
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji…"
          aria-label="Search emoji"
          className="mb-2 w-full rounded-xl border border-border bg-background px-3 py-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-brand/40"
        />

        {recents.length > 0 && !searching && (
          <div className="mb-1.5">
            <p className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Recent
            </p>
            <div className="flex flex-wrap gap-0.5">
              {recents.map((emoji, index) => (
                <button
                  key={`${emoji}-${index}`}
                  type="button"
                  onClick={() => choose(emoji)}
                  title={emoji}
                  className="grid h-8 w-8 place-items-center rounded-lg text-lg transition-colors hover:bg-muted"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 px-1 pb-2 text-base font-bold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand/15 text-brand">
            {category?.icon}
          </span>
          <span className="text-sm font-extrabold tracking-tight">{category?.label}</span>
        </div>

        <div className="mb-2 flex gap-0.5 overflow-x-auto">
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setCategoryId(c.id);
                setQuery("");
              }}
              title={c.label}
              aria-label={c.label}
              aria-pressed={c.id === category?.id && !query}
              className={cn(
                "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base transition-colors cursor-pointer",
                c.id === category?.id && !query
                  ? "bg-brand/20 text-brand"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {c.icon}
            </button>
          ))}
        </div>

        <div className="grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto custom-scrollbar">
          {grid.map((entry, index) => (
            <button
              key={`${entry.char}-${index}`}
              type="button"
              onClick={() => choose(entry.char)}
              title={entry.name}
              aria-label={entry.name}
              className="grid h-8 w-8 place-items-center rounded-lg text-xl transition-transform hover:bg-muted active:scale-90 cursor-pointer"
            >
              {entry.char}
            </button>
          ))}
        </div>

        {searching && grid.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            No emoji matches “{query}”.
          </p>
        )}
      </div>
    </>
  );
}
