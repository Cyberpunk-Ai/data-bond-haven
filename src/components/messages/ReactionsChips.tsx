import { cn } from "@/lib/utils";

/**
 * The reaction pills shown under a bubble. Clicking the one you already sent
 * clears it; clicking any other adds it — the parent owns the optimistic write
 * and the server round-trip via `onToggle`.
 */
export function ReactionsChips({
  counts,
  mine,
  onToggle,
}: {
  counts: Record<string, number>;
  mine: string[];
  onToggle: (emoji: string) => void;
}) {
  const entries = Object.entries(counts).filter(([, count]) => Number(count) > 0);
  if (entries.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {entries.map(([emoji, count]) => {
        const active = mine.includes(emoji);
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => onToggle(emoji)}
            aria-pressed={active}
            aria-label={`${active ? "Remove" : "Add"} reaction ${emoji}`}
            className={cn(
              "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-foreground shadow-xs backdrop-blur-xs transition-transform hover:scale-105 motion-reduce:hover:scale-100",
              active
                ? "border-brand/50 bg-brand/15"
                : "border-border/40 bg-background/80 dark:bg-card/90",
            )}
          >
            <span>{emoji}</span>
            {Number(count) > 1 && (
              <span className="text-[10px] font-bold text-muted-foreground">{String(count)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
