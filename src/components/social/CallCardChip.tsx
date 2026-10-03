import { ArrowDownLeft, ArrowUpRight, Phone, PhoneMissed, Video } from "lucide-react";

import { callCardIsWarning, callCardStatusText, type CallCard } from "@/lib/call-cards";
import { formatCallDuration } from "@/lib/call-media";
import { cn } from "@/lib/utils";

interface CallCardChipProps {
  card: CallCard;
  /** Redials the same way the call was placed: voice stays voice. */
  onCall: (kind: "audio" | "video") => void;
  /** "2h ago" / "10:41" — whatever the thread uses for its timestamps. */
  timeLabel: string;
}

/**
 * One finished call inside the chat thread.
 *
 * The card is deliberately *not* a message bubble: it belongs to neither side of
 * the conversation (a missed call is something that happened *to* the thread), so
 * it sits centred and neutral, the way a day divider does. Every fact it shows
 * comes from the `calls` row, which is why `duration` is only printed for a call
 * the database says was answered — a missed ring showing 0:00 reads as a broken
 * timer, and showing the ringing time reads as if somebody picked up.
 */
export function CallCardChip({ card, onCall, timeLabel }: CallCardChipProps) {
  const warning = callCardIsWarning(card);
  const missed = card.outcome === "missed" || card.outcome === "unanswered";
  // An unanswered ring gets its own glyph; a call that was picked up is typed by
  // what it actually was, so a voice call never wears a video icon.
  const StatusIcon = missed ? PhoneMissed : card.kind === "video" ? Video : Phone;

  return (
    <div className="mx-auto flex w-full max-w-[22rem] items-center gap-3 px-1 py-0.5">
      <span
        aria-hidden="true"
        className={cn(
          "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
          warning
            ? "border-rose-500/25 bg-rose-500/10 text-rose-500"
            : "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        )}
      >
        <StatusIcon className="h-4 w-4" />
        {/* Which side of the conversation dialled. */}
        <span
          className={cn(
            "absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-background bg-background shadow-sm",
            warning ? "text-rose-500" : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {card.direction === "outgoing" ? (
            <ArrowUpRight className="h-2.5 w-2.5" />
          ) : (
            <ArrowDownLeft className="h-2.5 w-2.5" />
          )}
        </span>
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold leading-tight text-foreground">
          {card.kind === "video" ? "Video call" : "Voice call"}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-tight">
          <span
            className={cn(
              "truncate font-medium",
              warning ? "text-rose-500" : "text-muted-foreground",
            )}
          >
            {callCardStatusText(card, formatCallDuration(card.durationSeconds))}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground/80">{timeLabel}</span>
        </span>
      </span>

      <button
        type="button"
        onClick={() => onCall(card.kind)}
        aria-label={card.kind === "video" ? "Call back — video" : "Call back — voice"}
        title={card.kind === "video" ? "Call back — video" : "Call back — voice"}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all",
          "cursor-pointer hover:scale-105 active:scale-95",
          warning
            ? "border-rose-500/25 text-rose-500 hover:bg-rose-500/10"
            : "border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        )}
      >
        {card.kind === "video" ? (
          <Video className="h-3.5 w-3.5" />
        ) : (
          <Phone className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
