import { ArrowDown, Loader2 } from "lucide-react";
import type { Message, Profile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/formatters";
import type { ThreadEntry } from "@/lib/call-cards";
import { CallCardChip } from "@/components/social/CallCardChip";
import type { CallKind } from "@/lib/call-cards";
import { Avatar } from "@/components/social/Avatar";
import { DayDivider } from "./DayDivider";
import { MessageBubble } from "./MessageBubble";

/**
 * The scrollable thread body. Owns the container ref that `useThread` drives
 * (near-bottom detection + load-older-on-top), the day dividers, call cards,
 * bubbles, the partner typing indicator, and the "Jump to latest" pill that only
 * appears when a new message arrived while you were reading history.
 */
export function MessageThread({
  timeline,
  now,
  currentUserId,
  reactionCounts,
  reactionMine,
  partner,
  isTyping,
  scrollRef,
  bottomRef,
  onScroll,
  hasMore,
  loadingOlder,
  atEnd,
  pendingCount,
  scrollToLatest,
  menuOpenFor,
  setMenuOpenFor,
  editingId,
  editDraft,
  setEditDraft,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onToggleReaction,
  onOpenCustomReaction,
  onImageOpen,
  onCopy,
  onForward,
  onShare,
  onInfo,
  onDeleteMe,
  onDeleteEveryone,
  onCallReDial,
  onCallHide,
  onCallDelete,
}: {
  timeline: ThreadEntry[];
  now: number;
  currentUserId: string;
  reactionCounts: Record<string, Record<string, number>>;
  reactionMine: Record<string, string[]>;
  partner: Profile | null;
  isTyping: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  hasMore: boolean;
  loadingOlder: boolean;
  atEnd: boolean;
  pendingCount: number;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  menuOpenFor: string | null;
  setMenuOpenFor: (id: string | null) => void;
  editingId: string | null;
  editDraft: string;
  setEditDraft: (value: string) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onStartEdit: (m: Message) => void;
  onToggleReaction: (id: string, emoji: string) => void;
  onOpenCustomReaction: (id: string) => void;
  onImageOpen: (src: string) => void;
  onCopy: (m: Message) => void;
  onForward: (m: Message) => void;
  onShare: (m: Message) => void;
  onInfo: (m: Message) => void;
  onDeleteMe: (id: string) => void;
  onDeleteEveryone: (id: string) => void;
  onCallReDial: (kind: CallKind) => void;
  onCallHide: (callId: string) => void;
  onCallDelete: (callId: string) => void;
}) {
  const lastFive = new Set(timeline.slice(-5).map((e) => e.key));

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full space-y-1 overflow-y-auto p-3 [scrollbar-width:thin] sm:p-4"
      >
        {/* Load-older affordance at the very top of the scroll area. */}
        {hasMore && (
          <div className="flex justify-center py-1">
            {loadingOlder ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading older messages…
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">Scroll up for history</span>
            )}
          </div>
        )}
        {!hasMore && timeline.length > 0 && (
          <div className="py-1 text-center text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Beginning of conversation
          </div>
        )}

        {timeline.map((entry) => {
          if (entry.type === "call") {
            return (
              <div key={entry.key} className="py-0.5">
                {entry.newDay && <DayDivider ms={entry.at} />}
                <CallCardChip
                  card={entry.call}
                  timeLabel={timeAgo(new Date(entry.at).toISOString(), now)}
                  onCall={onCallReDial}
                  onHide={() => onCallHide(entry.call.id)}
                  onDelete={() => onCallDelete(entry.call.id)}
                />
              </div>
            );
          }
          const m = entry.message;
          const mine = m.sender_id === currentUserId;
          const openUpward = lastFive.has(entry.key);
          return (
            <div key={m.id}>
              {entry.newDay && <DayDivider ms={Date.parse(m.created_at)} />}
              <MessageBubble
                message={m}
                mine={mine}
                startsGroup={entry.startsGroup}
                endsGroup={entry.endsGroup}
                openUpward={openUpward}
                now={now}
                reactions={reactionCounts[m.id] || {}}
                myReactions={reactionMine[m.id] || []}
                isEditing={editingId === m.id}
                editDraft={editingId === m.id ? editDraft : ""}
                menuOpen={menuOpenFor === m.id}
                onEditDraftChange={setEditDraft}
                onSaveEdit={() => onSaveEdit(m.id)}
                onCancelEdit={onCancelEdit}
                onToggleMenu={() => setMenuOpenFor(menuOpenFor === m.id ? null : m.id)}
                onToggleReaction={(emoji) => onToggleReaction(m.id, emoji)}
                onOpenCustomReaction={() => onOpenCustomReaction(m.id)}
                onImageOpen={onImageOpen}
                onEdit={() => onStartEdit(m)}
                onCopy={() => onCopy(m)}
                onForward={() => onForward(m)}
                onShare={() => onShare(m)}
                onInfo={() => onInfo(m)}
                onDeleteMe={() => onDeleteMe(m.id)}
                onDeleteEveryone={() => onDeleteEveryone(m.id)}
              />
            </div>
          );
        })}

        {/* Live typing indicator from the other person. */}
        {isTyping && partner && (
          <div className="flex animate-in items-center gap-2 pl-1 fade-in">
            <Avatar
              name={partner.display_name}
              src={partner.avatar_url}
              className="h-6 w-6 text-[10px]"
            />
            <span className="flex items-center gap-1 rounded-full bg-foreground/5 px-3 py-2">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Jump-to-latest pill: only when a new message landed off-screen. */}
      {!atEnd && (
        <button
          type="button"
          onClick={() => scrollToLatest("smooth")}
          className={cn(
            "absolute bottom-4 right-4 z-20 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-border/70 bg-card text-foreground shadow-lg backdrop-blur-sm transition-all hover:scale-105 active:scale-95 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2",
          )}
          aria-label={pendingCount > 0 ? `Jump to latest, ${pendingCount} new` : "Jump to latest"}
        >
          <ArrowDown className="h-4 w-4" />
          {pendingCount > 0 && (
            <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-gradient-to-r from-brand to-brand-pink px-1 text-[0.65rem] font-bold text-white">
              {pendingCount}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
