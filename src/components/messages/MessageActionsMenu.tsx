import { useEffect } from "react";
import { Copy, Edit2, EyeOff, Forward, Info, Share2, SmilePlus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { QUICK_REACTIONS } from "@/lib/emojis";
import { useModalA11y } from "@/hooks/use-messages/useModalA11y";

/**
 * The three-dots popover for one message: a quick-reaction row, then the full
 * action list, then the two delete scopes. It opens on the bubble's side and
 * flips upward near the bottom of the thread so it can't spill out of view.
 *
 * Keyboard: Escape closes, ArrowUp/Down (and Home/End) move between items. Focus
 * enters the first item on open and returns to the trigger on close (useModalA11y
 * owns that); the popover deliberately doesn't lock page scroll because it's an
 * anchored menu, not a full-screen dialog.
 */
export function MessageActionsMenu({
  open,
  onClose,
  isMine,
  openUpward,
  canEditThis,
  isAttachment,
  onReact,
  onOpenCustomReaction,
  onEdit,
  onCopy,
  onForward,
  onShare,
  onInfo,
  onDeleteMe,
  onDeleteEveryone,
}: {
  open: boolean;
  onClose: () => void;
  isMine: boolean;
  openUpward: boolean;
  canEditThis: boolean;
  isAttachment: boolean;
  onReact: (emoji: string) => void;
  onOpenCustomReaction: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onForward: () => void;
  onShare: () => void;
  onInfo: () => void;
  onDeleteMe: () => void;
  onDeleteEveryone: () => void;
}) {
  const panelRef = useModalA11y<HTMLDivElement>({ open, onClose, trapScroll: false });

  // Arrow-key roving focus across whatever items this message actually has.
  useEffect(() => {
    if (!open) return;
    const node = panelRef.current;
    if (!node) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End")
        return;
      const items = Array.from(
        node!.querySelectorAll<HTMLElement>('[role="menuitem"], [data-quick-react]'),
      );
      if (items.length === 0) return;
      e.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
      else next = current <= 0 ? items.length - 1 : (current - 1) % items.length;
      items[next]?.focus();
    }
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [open, panelRef]);

  if (!open) return null;

  const itemClass =
    "flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-foreground/5";

  return (
    <>
      {/* Click-away catcher under the menu. */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="menu"
        aria-orientation="vertical"
        className={cn(
          "absolute z-40 w-[196px] rounded-2xl border border-border/80 bg-card py-1 shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150",
          isMine ? "right-0" : "left-0",
        )}
        style={openUpward ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }}
      >
        <div className="flex flex-wrap items-center gap-0.5 px-2 pb-1.5">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-quick-react
              onClick={() => {
                onReact(emoji);
                onClose();
              }}
              className="cursor-pointer rounded-full p-1 text-sm transition-transform hover:bg-foreground/5 hover:scale-125 motion-reduce:hover:scale-100"
              title={`React with ${emoji}`}
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            data-quick-react
            onClick={() => {
              onClose();
              onOpenCustomReaction();
            }}
            className="ml-auto cursor-pointer rounded-full p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-brand"
            title="Add a custom reaction"
            aria-label="Add a custom reaction"
          >
            <SmilePlus className="h-4 w-4" />
          </button>
        </div>

        <div className="h-px bg-border/60" />

        {isMine && !isAttachment && canEditThis && (
          <button type="button" role="menuitem" onClick={onEdit} className={itemClass}>
            <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
            Edit
          </button>
        )}
        <button type="button" role="menuitem" onClick={onCopy} className={itemClass}>
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          Copy
        </button>
        <button type="button" role="menuitem" onClick={onForward} className={itemClass}>
          <Forward className="h-3.5 w-3.5 text-muted-foreground" />
          Forward
        </button>
        <button type="button" role="menuitem" onClick={onShare} className={itemClass}>
          <Share2 className="h-3.5 w-3.5 text-muted-foreground" />
          Share
        </button>
        <button type="button" role="menuitem" onClick={onInfo} className={itemClass}>
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
          Info
        </button>

        <div className="my-1 h-px bg-border/60" />

        <button type="button" role="menuitem" onClick={onDeleteMe} className={itemClass}>
          <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
          Delete for me
        </button>
        {isMine && canEditThis && (
          <button
            type="button"
            role="menuitem"
            onClick={onDeleteEveryone}
            className={cn(itemClass, "text-rose-600 hover:bg-rose-500/10 dark:text-rose-400")}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete for everyone
          </button>
        )}
      </div>
    </>
  );
}
