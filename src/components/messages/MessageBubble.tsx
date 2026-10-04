import { Check, CheckCheck, MoreVertical } from "lucide-react";
import type { Message } from "@/lib/types";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/formatters";
import { BUBBLE_MAX_WIDTH_CLASS } from "@/lib/message-constants";
import {
  attachmentKind,
  canEdit as withinEditWindow,
  isVoiceNoteBody,
} from "@/lib/message-helpers";
import { MessageText } from "./MessageText";
import { AttachmentBubble } from "./AttachmentBubble";
import { ReactionsChips } from "./ReactionsChips";
import { MessageActionsMenu } from "./MessageActionsMenu";

/**
 * One message row: the bubble frame, its content (text or attachment), the
 * timestamp/delivery footer, reactions, and the three-dots action menu.
 *
 * The frame keeps a single corner + max-width language for text and media so a
 * photo and a sentence read as the same kind of object; the tail corner only
 * rounds off at the end of a run from the same sender so a burst looks connected.
 */
export function MessageBubble({
  message,
  mine,
  startsGroup,
  endsGroup,
  openUpward,
  now,
  reactions,
  myReactions,
  isEditing,
  editDraft,
  menuOpen,
  onEditDraftChange,
  onSaveEdit,
  onCancelEdit,
  onToggleMenu,
  onToggleReaction,
  onOpenCustomReaction,
  onImageOpen,
  onEdit,
  onCopy,
  onForward,
  onShare,
  onInfo,
  onDeleteMe,
  onDeleteEveryone,
}: {
  message: Message;
  mine: boolean;
  startsGroup: boolean;
  endsGroup: boolean;
  openUpward: boolean;
  now: number;
  reactions: Record<string, number>;
  myReactions: string[];
  isEditing: boolean;
  editDraft: string;
  menuOpen: boolean;
  onEditDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggleMenu: () => void;
  onToggleReaction: (emoji: string) => void;
  onOpenCustomReaction: () => void;
  onImageOpen: (src: string) => void;
  onEdit: () => void;
  onCopy: () => void;
  onForward: () => void;
  onShare: () => void;
  onInfo: () => void;
  onDeleteMe: () => void;
  onDeleteEveryone: () => void;
}) {
  const kind = attachmentKind(message.body);
  const isVoice = isVoiceNoteBody(message.body);
  const isDoc = kind === "pdf" || kind === "document";
  const isAttachment =
    kind !== null ||
    isVoice ||
    isDoc ||
    message.body.startsWith("📄") ||
    message.body.startsWith("📎");
  const editable = mine && !isAttachment && withinEditWindow(message);

  return (
    <div
      className={cn(
        "group relative flex items-end gap-1.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-reduce:animate-none",
        startsGroup ? "mt-3" : "mt-0.5",
        mine ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-3xl border text-xs leading-relaxed shadow-soft transition-all [overflow-wrap:anywhere] sm:text-sm",
          BUBBLE_MAX_WIDTH_CLASS,
          mine
            ? "border-white/10 bg-gradient-to-br from-brand to-brand-pink text-white"
            : "border-black/5 bg-foreground/5 dark:border-white/5",
          isAttachment
            ? kind === "image" || kind === "video" || isDoc
              ? "p-1"
              : "p-1.5 sm:p-2"
            : "px-3.5 py-2 sm:px-4 sm:py-2.5",
          mine
            ? endsGroup
              ? "rounded-br-lg"
              : "rounded-br-3xl"
            : endsGroup
              ? "rounded-bl-lg"
              : "rounded-bl-3xl",
        )}
      >
        {isEditing ? (
          <div className="min-w-[200px] space-y-2 text-foreground">
            <textarea
              value={editDraft}
              onChange={(e) => onEditDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSaveEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelEdit();
                }
              }}
              rows={2}
              className="w-full resize-none rounded-xl border border-border bg-card px-3 py-1.5 text-xs outline-none focus:border-brand sm:text-sm"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={onCancelEdit}
                className="cursor-pointer rounded-lg bg-white/20 px-2 py-1 text-white transition-colors hover:bg-white/30"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSaveEdit}
                className="flex cursor-pointer items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 font-bold text-white transition-colors hover:bg-emerald-600"
              >
                <Check className="h-3 w-3" /> Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {isAttachment ? (
              <AttachmentBubble
                body={message.body}
                isMine={mine}
                endsGroup={endsGroup}
                onImageOpen={onImageOpen}
              />
            ) : (
              <MessageText
                body={message.body}
                isMine={mine}
                endsGroup={endsGroup}
                onImageOpen={onImageOpen}
              />
            )}

            {/* Timestamp & delivery status — only on the last of a run. */}
            <div
              className={cn(
                "mt-1 flex items-center gap-1.5 text-[0.65rem]",
                mine ? "justify-end text-white/80" : "text-muted-foreground",
                endsGroup ? "" : "hidden",
              )}
            >
              <span title={new Date(message.created_at).toLocaleString()}>
                {timeAgo(message.created_at, now)}
              </span>
              {message.is_edited && <span className="italic opacity-80">(edited)</span>}
              {mine && (
                <span
                  className="ml-1 flex items-center gap-0.5"
                  title={message.read_at ? "Seen" : message.delivered_at ? "Delivered" : "Sent"}
                >
                  {message.read_at ? (
                    <CheckCheck className="h-3.5 w-3.5 text-sky-300" />
                  ) : message.delivered_at ? (
                    <CheckCheck className="h-3.5 w-3.5 text-white/70" />
                  ) : (
                    <Check className="h-3.5 w-3.5 text-white/70" />
                  )}
                </span>
              )}
            </div>
          </>
        )}

        <ReactionsChips counts={reactions} mine={myReactions} onToggle={onToggleReaction} />

        {/* Three-dots trigger, pinned just outside the bubble's outer edge so it
            hugs the message without stealing horizontal space: always tappable on
            touch, revealed on hover on desktop. */}
        {!isEditing && (
          <button
            type="button"
            onClick={onToggleMenu}
            title="Message options"
            aria-label="Message options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={cn(
              "absolute top-1/2 z-20 grid h-7 w-7 -translate-y-1/2 cursor-pointer place-items-center rounded-full border border-border/70 bg-card/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:text-foreground",
              "opacity-100 md:opacity-0 md:group-hover:opacity-100",
              menuOpen && "text-foreground opacity-100 md:opacity-100",
              mine ? "right-full mr-1.5" : "left-full ml-1.5",
            )}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        )}
      </div>

      <MessageActionsMenu
        open={menuOpen}
        onClose={onToggleMenu}
        isMine={mine}
        openUpward={openUpward}
        canEditThis={withinEditWindow(message)}
        isAttachment={isAttachment}
        onReact={onToggleReaction}
        onOpenCustomReaction={onOpenCustomReaction}
        onEdit={onEdit}
        onCopy={onCopy}
        onForward={onForward}
        onShare={onShare}
        onInfo={onInfo}
        onDeleteMe={onDeleteMe}
        onDeleteEveryone={onDeleteEveryone}
      />
    </div>
  );
}
