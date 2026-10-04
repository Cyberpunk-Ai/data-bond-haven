import { Search, X } from "lucide-react";
import type { Message, Profile } from "@/lib/types";
import { Avatar } from "@/components/social/Avatar";
import { previewLabel } from "@/lib/message-helpers";
import { DialogShell } from "./DialogShell";

const TITLE_ID = "forward-title";

/**
 * The forward-to sheet reached from a bubble's three-dots menu. Lists only the
 * people you already have a conversation with, searchable. Picking a target
 * re-sends the message body (and its media) into that existing thread.
 */
export function ForwardSheet({
  open,
  onClose,
  message,
  targets,
  query,
  onQueryChange,
  onForwardTo,
}: {
  open: boolean;
  onClose: () => void;
  message: Message | null;
  targets: Profile[];
  query: string;
  onQueryChange: (value: string) => void;
  onForwardTo: (participantId: string) => void;
}) {
  if (!message) return null;

  return (
    <DialogShell open={open} onClose={onClose} labelledBy={TITLE_ID}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id={TITLE_ID} className="text-lg font-black tracking-tight">
            Forward message
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded-full p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="line-clamp-3 rounded-2xl border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {previewLabel(message.body)}
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search your chats..."
            aria-label="Search chats to forward to"
            className="w-full rounded-2xl border border-border bg-muted/40 py-2.5 pl-9 pr-4 text-sm outline-none focus:border-brand"
          />
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto [scrollbar-width:thin]">
          {targets.map((t) => (
            <button
              key={`fwd-${t.id}`}
              type="button"
              onClick={() => onForwardTo(t.id)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-2xl p-2.5 text-left transition-colors hover:bg-muted/50"
            >
              <Avatar
                name={t.display_name}
                src={t.avatar_url ?? undefined}
                className="h-10 w-10 text-xs"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{t.display_name}</p>
                <p className="truncate text-[11px] text-muted-foreground">@{t.username}</p>
              </div>
              <span className="rounded-full bg-brand/10 px-3 py-1 text-[11px] font-bold text-brand">
                Send
              </span>
            </button>
          ))}
          {targets.length === 0 && (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              {query.trim()
                ? "No matching chats. You can only forward to people you've already messaged."
                : "No chats yet — start a conversation to forward messages."}
            </p>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
