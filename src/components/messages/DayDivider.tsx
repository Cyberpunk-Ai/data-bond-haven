import { dayLabel } from "@/lib/message-helpers";

/** The dated strip that separates one calendar day of the thread from the next. */
export function DayDivider({ ms }: { ms: number }) {
  const safe = Number.isFinite(ms) ? ms : Date.now();
  return (
    <div className="my-4 flex items-center gap-3">
      <span className="h-px flex-1 bg-border/60" />
      <span className="rounded-full bg-foreground/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {dayLabel(new Date(safe).toISOString())}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}
