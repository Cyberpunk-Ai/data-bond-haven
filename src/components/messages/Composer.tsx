import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Music, Paperclip, Send, Smile, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "@/components/social/EmojiPicker";
import { useEmojiInsert } from "@/hooks/useEmojiInsert";
import { ACCEPT_ALL } from "@/lib/message-constants";
import {
  MAX_MESSAGE_CHARS,
  isMessageWithinLimit,
  messageCharsOver,
  messageCounterLabel,
  shouldShowMessageCounter,
} from "@/lib/message-length";
import type { PendingAttachment } from "@/lib/message-helpers";
import { AttachMenu } from "./AttachMenu";

/** Grow the textarea to fit its content, up to `maxPx`, then let it scroll. */
function autoGrow(el: HTMLTextAreaElement | null, maxPx = 160) {
  if (!el) return;
  el.style.height = "0px";
  el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
}

/**
 * The message input. A single-line <input> used to cap every message to one
 * physical line (Shift+Enter did nothing); this is an auto-growing <textarea>
 * that keeps Enter-to-send and adds Shift+Enter for a newline, and stages pasted
 * or dropped files as attachments.
 */
export function Composer({
  partnerName,
  draft,
  onDraftChange,
  notifyTyping,
  onSend,
  sending,
  pendingAttachments,
  onDropAttachment,
  onStageFiles,
  recording,
}: {
  partnerName: string;
  draft: string;
  onDraftChange: (value: string) => void;
  notifyTyping: () => void;
  onSend: () => void;
  sending: boolean;
  pendingAttachments: PendingAttachment[];
  onDropAttachment: (id: string) => void;
  onStageFiles: (files: File[]) => void;
  recording: {
    isRecording: boolean;
    duration: number;
    onStart: () => void;
    onCancel: () => void;
    onSend: () => void;
  };
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttach, setShowAttach] = useState(false);

  const insertEmoji = useEmojiInsert(textRef, draft, onDraftChange, {
    maxLength: MAX_MESSAGE_CHARS,
  });

  useEffect(() => {
    autoGrow(textRef.current);
  }, [draft]);

  function openPicker(accept: string) {
    setShowAttach(false);
    if (fileRef.current) {
      fileRef.current.accept = accept;
      fileRef.current.click();
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      onStageFiles(files);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onStageFiles(files);
  }

  if (recording.isRecording) {
    return (
      <div className="border-t border-border/60 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:p-3 sm:pb-3">
        <div className="flex animate-in items-center justify-between rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 fade-in">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
            </span>
            <span className="text-xs font-bold text-rose-600 dark:text-rose-400">
              Recording audio... {recording.duration}s
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={recording.onCancel}
              className="cursor-pointer rounded-full bg-foreground/10 px-3 py-1 text-xs font-semibold text-muted-foreground transition-all hover:bg-foreground/20"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={recording.onSend}
              className="flex cursor-pointer items-center gap-1 rounded-full bg-rose-500 px-3 py-1 text-xs font-bold text-white transition-all hover:bg-rose-600"
            >
              <Send className="h-3 w-3" /> Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  const canSend =
    (draft.trim().length > 0 || pendingAttachments.length > 0) &&
    !sending &&
    isMessageWithinLimit(draft);

  return (
    <div
      className="relative border-t border-border/60 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:p-3 sm:pb-3"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ACCEPT_ALL}
        onChange={(e) => {
          onStageFiles(Array.from(e.target.files || []));
          e.target.value = "";
        }}
        className="hidden"
      />

      {/* Staged attachments — files wait here until Send. */}
      {pendingAttachments.length > 0 && (
        <div className="mb-2 flex animate-in gap-2 overflow-x-auto px-0.5 pb-1 pt-1 fade-in slide-in-from-bottom-2 [scrollbar-width:thin]">
          {pendingAttachments.map((att) => (
            <div key={att.id} className="relative shrink-0">
              <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/40 shadow-xs">
                {att.isMedia && att.previewUrl ? (
                  <img src={att.previewUrl} alt={att.name} className="h-16 w-16 object-cover" />
                ) : (
                  <div className="flex h-16 w-40 items-center gap-2 px-2.5">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
                      {att.isMedia ? (
                        <Music className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-bold leading-tight">{att.name}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {att.sizeLabel}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDropAttachment(att.id)}
                aria-label={`Remove ${att.name}`}
                className="absolute right-1 top-1 grid h-5 w-5 cursor-pointer place-items-center rounded-full bg-black/70 text-white shadow-sm ring-1 ring-white/30 backdrop-blur-sm transition-colors hover:bg-rose-600"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showAttach && <AttachMenu onPick={openPicker} onVoice={recording.onStart} />}

      <div className="flex items-end gap-1.5 rounded-3xl bg-foreground/5 px-2.5 py-1.5 sm:gap-2 sm:px-3 sm:py-2">
        <button
          type="button"
          onClick={() => {
            setShowAttach((prev) => !prev);
            setShowEmoji(false);
          }}
          aria-expanded={showAttach}
          title="Attach file, photo or document"
          aria-label="Attach"
          className={cn(
            "flex min-h-[36px] min-w-[36px] shrink-0 cursor-pointer items-center justify-center rounded-full p-2 transition-colors",
            showAttach ? "bg-brand/20 text-brand" : "text-muted-foreground hover:text-brand",
          )}
        >
          <Paperclip className="h-4 w-4" />
        </button>

        <textarea
          ref={textRef}
          value={draft}
          onChange={(e) => {
            onDraftChange(e.target.value);
            notifyTyping();
          }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          rows={1}
          placeholder={`Message ${partnerName.split(" ")[0]}…`}
          aria-label="Message"
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />

        {/* Only appears as you run out of room. Typing past the cap is allowed on
            purpose — a hard maxLength silently eats a paste, and the number goes
            negative so the reason is visible. */}
        {shouldShowMessageCounter(draft) && (
          <span
            aria-label={`${messageCounterLabel(draft)} characters left in this message`}
            className={cn(
              "shrink-0 text-[10px] font-bold tabular-nums",
              messageCharsOver(draft) > 0 ? "text-rose-500" : "text-muted-foreground",
            )}
          >
            {messageCounterLabel(draft)}
          </span>
        )}

        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setShowEmoji((open) => !open);
              setShowAttach(false);
            }}
            aria-expanded={showEmoji}
            title="Pick an emoji"
            aria-label="Emoji"
            className={cn(
              "flex min-h-[36px] min-w-[36px] cursor-pointer items-center justify-center rounded-full p-2 transition-colors",
              showEmoji ? "bg-brand/20 text-brand" : "text-muted-foreground hover:text-brand",
            )}
          >
            <Smile className="h-4 w-4" />
          </button>
          {showEmoji && (
            <EmojiPicker
              multiple
              label="Emoji"
              className="bottom-full right-0 mb-2"
              onPick={(emoji) => {
                if (insertEmoji(emoji)) notifyTyping();
              }}
              onClose={() => setShowEmoji(false)}
            />
          )}
        </div>

        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          title={
            isMessageWithinLimit(draft)
              ? "Send message"
              : `A message can be up to ${MAX_MESSAGE_CHARS} characters`
          }
          aria-label="Send message"
          className="grid h-9 w-9 min-w-[36px] shrink-0 cursor-pointer place-items-center rounded-full bg-gradient-to-r from-brand to-brand-pink text-white transition-all duration-300 hover:shadow-glow active:scale-95 disabled:opacity-40"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
