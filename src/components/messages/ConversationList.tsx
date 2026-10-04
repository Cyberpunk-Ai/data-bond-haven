import { Plus, RefreshCw, Search } from "lucide-react";
import type { Conversation, Profile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationRow } from "./ConversationRow";

function ConvsSkeleton() {
  return (
    <div className="space-y-2 p-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl p-3">
          <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-28 rounded-md" />
              <Skeleton className="h-3 w-10 rounded-md" />
            </div>
            <Skeleton className="h-3 w-40 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The inbox rail: title, a "New" action, a search field, then the conversation
 * rows. The load state distinguishes a failed fetch (offer retry) from a genuine
 * empty inbox (offer a start-a-conversation CTA) — the old list showed the same
 * "No conversations found" for both, which hid errors as emptiness.
 */
export function ConversationList({
  conversations,
  profiles,
  presence,
  activeId,
  loading,
  error,
  query,
  onQueryChange,
  onOpen,
  onHide,
  onNew,
  onRetry,
  className,
}: {
  conversations: Conversation[];
  profiles: Record<string, Profile>;
  presence: Record<string, { online?: boolean }>;
  activeId: string;
  loading: boolean;
  error: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onOpen: (id: string) => void;
  onHide: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
  className?: string;
}) {
  const q = query.trim().toLowerCase();
  const rows = conversations.filter((c) => {
    if (!q) return true;
    const p = profiles[c.participant_id];
    if (!p) return true;
    return p.display_name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q);
  });

  return (
    <div className={cn("flex min-h-0 flex-col border-border/60 lg:border-r", className)}>
      <div className="mb-3 border-b border-border/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-xl font-extrabold tracking-tight">Messages</h1>
          <button
            type="button"
            onClick={onNew}
            className="flex cursor-pointer items-center gap-1 rounded-full bg-brand/10 px-3 py-1.5 text-xs font-bold text-brand transition-all hover:bg-brand/20 active:scale-95"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New</span>
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-full bg-foreground/5 px-4 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-width:thin]">
        {loading ? (
          <ConvsSkeleton />
        ) : error ? (
          <div className="space-y-3 p-6 text-center text-sm text-muted-foreground">
            <p>We couldn't load your conversations.</p>
            <button
              type="button"
              onClick={onRetry}
              className="mx-auto flex cursor-pointer items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white transition-all hover:bg-brand/90"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="space-y-2 p-6 text-center text-sm text-muted-foreground">
            <p>{q ? "No conversations match your search." : "No conversations yet."}</p>
            {!q && (
              <button
                type="button"
                onClick={onNew}
                className="cursor-pointer rounded-full bg-brand px-4 py-2 text-xs font-bold text-white transition-all hover:bg-brand/90"
              >
                Start a conversation
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-0.5">
            {rows.map((c) => {
              const p = profiles[c.participant_id];
              if (!p) return null;
              return (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  profile={p}
                  isActive={c.id === activeId}
                  isOnline={!!presence[c.participant_id]?.online}
                  onOpen={onOpen}
                  onHide={onHide}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
