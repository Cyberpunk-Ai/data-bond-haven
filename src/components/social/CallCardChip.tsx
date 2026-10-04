import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  EyeOff,
  MoreVertical,
  Phone,
  PhoneMissed,
  Trash2,
  Video,
} from "lucide-react";

import { callCardIsWarning, callCardStatusText, type CallCard } from "@/lib/call-cards";
import { formatCallDuration } from "@/lib/call-media";
import { cn } from "@/lib/utils";

interface CallCardChipProps {
  card: CallCard;
  /** Redials the same way the call was placed: voice stays voice. */
  onCall: (kind: "audio" | "video") => void;
  /** "2h ago" / "10:41" — whatever the thread uses for its timestamps. */
  timeLabel: string;
  /** Drop the card from *this* person's thread only (soft hide). */
  onHide?: () => void;
  /** Remove the shared call row so it disappears for both people. */
  onDelete?: () => void;
}

/**
 * One finished call inside the chat thread.
 *
 * The card is deliberately *not* a message bubble: it belongs to neither side of
 * the conversation (a missed call is something that happened *to* the thread), so
 * it sits centred as its own little object, the way a day divider does. Every
 * fact it shows comes from the `calls` row, which is why `duration` is only
 * printed for a call the database says was answered — a missed ring showing 0:00
 * reads as a broken timer, and showing the ringing time reads as if somebody
 * picked up.
 *
 * The kebab reveals the two ways to clear a call: hide it from your own thread,
 * or delete it for both people. Both live behind one tap so the row itself stays
 * calm and readable.
 */
export function CallCardChip({ card, onCall, timeLabel, onHide, onDelete }: CallCardChipProps) {
  const warning = callCardIsWarning(card);
  const missed = card.outcome === "missed" || card.outcome === "unanswered";
  // An unanswered ring gets its own glyph; a call that was picked up is typed by
  // what it actually was, so a voice call never wears a video icon.
  const StatusIcon = missed ? PhoneMissed : card.kind === "video" ? Video : Phone;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [menuOpen]);

  const showDelete = !!onHide || !!onDelete;

  return (
    <div
      className={cn(
        "group/call relative mx-auto flex w-full max-w-[24rem] items-center gap-3 rounded-2xl border p-2 pr-2.5 text-left shadow-xs transition-all",
        "motion-safe:hover:-translate-y-px motion-safe:hover:shadow-sm motion-reduce:transform-none",
        // While the kebab menu is open this whole card must sit above its
        // siblings: the popover hangs down over the *next* call card, and a
        // later sibling paints above an earlier one — hovering through it
        // triggered that card's hover-reveal styles underneath the menu, which
        // read as flicker. Position `relative` alone creates no stacking order,
        // so the lift has to happen here.
        menuOpen && "z-50",
        warning
          ? "border-rose-500/20 bg-rose-500/[0.06] dark:bg-rose-500/[0.08]"
          : "border-border/60 bg-card/70 hover:border-border",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white shadow-sm ring-1",
          warning
            ? "bg-gradient-to-br from-rose-500 to-rose-600 ring-rose-500/30"
            : "bg-gradient-to-br from-emerald-500 to-emerald-600 ring-emerald-500/30",
        )}
      >
        <StatusIcon className="h-5 w-5" />
        {/* Which side of the conversation dialled. */}
        <span
          className={cn(
            "absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full border-2 border-card bg-card shadow-sm",
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

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-[13px] font-bold leading-tight text-foreground">
            {card.kind === "video" ? "Video call" : "Voice call"}
          </p>
          {card.answered && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              <Clock className="h-2.5 w-2.5" />
              {formatCallDuration(card.durationSeconds)}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-tight">
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
        </div>
      </div>

      <button
        type="button"
        onClick={() => onCall(card.kind)}
        aria-label={card.kind === "video" ? "Call back — video" : "Call back — voice"}
        title={card.kind === "video" ? "Call back — video" : "Call back — voice"}
        className={cn(
          "flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-all",
          "hover:scale-105 active:scale-95",
          warning
            ? "border-rose-500/25 text-rose-500 hover:bg-rose-500/10"
            : "border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        )}
      >
        {card.kind === "video" ? <Video className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      </button>

      {showDelete && (
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Call options"
            title="Call options"
            className={cn(
              "flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-foreground/5 hover:text-foreground",
              "opacity-100 md:opacity-0 md:group-hover/call:opacity-100",
              menuOpen && "bg-foreground/5 text-foreground opacity-100 md:opacity-100",
            )}
          >
            <MoreVertical className="h-4 w-4" />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-lg animate-in fade-in zoom-in-95 duration-150"
            >
              {onHide && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onHide();
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-foreground transition-colors hover:bg-muted"
                >
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  Remove for me
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-rose-500 transition-colors hover:bg-rose-500/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete for everyone
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
