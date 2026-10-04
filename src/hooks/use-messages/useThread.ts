import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "@/lib/types";
import { getMessagesPage, markThreadRead } from "@/lib/api-client";
import { scheduleUnreadResync, setConversationUnread } from "@/lib/unread-state";
import { NEW_PAGE_LIMIT } from "@/lib/message-constants";

/** How close to the bottom (px) counts as "already following the conversation". */
const NEAR_BOTTOM_PX = 120;
/** How close to the top (px) triggers loading an older page. */
const NEAR_TOP_PX = 80;

/**
 * Owns one thread's message list: the first page, load-older pagination, the
 * scroll behaviour, and read receipts — the pieces that were scattered across the
 * page component's state and force-smooth-scrolled on any length change.
 *
 * The defects this fixes:
 *   • history no longer downloads the whole thread on open — one page, then more
 *     as you scroll up, with the visual position preserved across the prepend;
 *   • it only yanks you to the bottom for a new message when you were already
 *     near the bottom, otherwise it counts pending messages behind a
 *     "Jump to latest" pill so reading history isn't hijacked;
 *   • inbound messages while the thread is focused are marked read live (the
 *     sender's ticks advance) instead of only on the next load.
 */
export function useThread(args: { conversationId: string; currentUserId: string }) {
  const { conversationId, currentUserId } = args;

  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Guards the first paint: we jump to the bottom once after the first page,
  // then only on genuinely-new inbound/outbound messages.
  const mountedFor = useRef<string>("");
  const prevCount = useRef(0);
  // The scroll height captured just before an older-page load, so we can restore.
  const anchorHeight = useRef<number | null>(null);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    setPendingCount(0);
    setAtEnd(true);
  }, []);

  // Load the newest page whenever the open thread changes; jump to the bottom
  // instantly (no animation on first paint) and mark the thread read.
  useEffect(() => {
    if (!conversationId || conversationId.startsWith("c_")) {
      setMessages([]);
      setHasMore(false);
      prevCount.current = 0;
      return;
    }
    let alive = true;
    mountedFor.current = conversationId;
    setPendingCount(0);
    void getMessagesPage(conversationId, { limit: NEW_PAGE_LIMIT })
      .then(({ messages: page, hasMore: more }) => {
        if (!alive) return;
        setMessages(page);
        setHasMore(more);
        prevCount.current = page.length;
        // Jump straight to the newest message once the page has painted.
        requestAnimationFrame(() => {
          if (alive) scrollToLatest("auto");
        });
        // Zero this exact conversation the instant the read commits — the badge
        // is a per-thread map, so opening a thread visibly clears just its share
        // now rather than waiting on a debounced re-count of the whole inbox.
        if (page.length > 0)
          void markThreadRead(conversationId).then(() => {
            setConversationUnread(conversationId, 0);
            scheduleUnreadResync();
          });
      })
      .catch((err) => {
        console.warn("Thread load:", err);
      });
    return () => {
      alive = false;
    };
  }, [conversationId, scrollToLatest]);

  // Scroll reaction for list changes that aren't a fresh thread load (a new
  // message arriving, an optimistic send): follow only if already near bottom.
  useEffect(() => {
    if (mountedFor.current !== conversationId) return;
    const count = messages.length;
    const grew = count > prevCount.current;
    const added = count - prevCount.current;
    prevCount.current = count;
    if (!grew) return;
    if (isNearBottom()) {
      requestAnimationFrame(() => scrollToLatest("auto"));
    } else {
      setPendingCount((prev) => prev + added);
    }
  }, [messages.length, conversationId, isNearBottom, scrollToLatest]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setAtEnd(nearBottom);
    if (nearBottom) setPendingCount(0);

    // Load older when scrolled near the top and there is more to fetch.
    if (
      el.scrollTop < NEAR_TOP_PX &&
      hasMore &&
      !loadingOlder &&
      messages.length > 0 &&
      mountedFor.current === conversationId
    ) {
      const oldest = messages[0];
      if (!oldest?.created_at) return;
      setLoadingOlder(true);
      anchorHeight.current = el.scrollHeight;
      void getMessagesPage(conversationId, { before: oldest.created_at, limit: NEW_PAGE_LIMIT })
        .then(({ messages: older, hasMore: more }) => {
          setMessages((prev) => {
            const byId = new Set(prev.map((m) => m.id));
            const fresh = older.filter((m) => !byId.has(m.id));
            return [...fresh, ...prev];
          });
          setHasMore(more);
          // Keep the reader on the message they were looking at across the prepend.
          requestAnimationFrame(() => {
            const node = scrollRef.current;
            if (node && anchorHeight.current != null) {
              node.scrollTop = node.scrollHeight - anchorHeight.current;
            }
            anchorHeight.current = null;
          });
        })
        .catch((err) => console.warn("Older load:", err))
        .finally(() => setLoadingOlder(false));
    }
  }, [conversationId, hasMore, loadingOlder, messages]);

  /** Merge a message by id — the sole de-dupe rule now that every send is keyed
   *  by the UUID `clientId` that becomes the row id. */
  const ingest = useCallback(
    (msg: {
      id: string;
      conversation_id: string;
      sender_id: string;
      body: string;
      created_at: string;
      media_url?: string | null;
    }) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === msg.id);
        if (idx !== -1) {
          // A metadata refresh for a bubble we already hold (media url, etc.).
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...msg };
          return updated;
        }
        return [...prev, { ...msg } as Message];
      });
      // Inbound while this thread is the active, visible one → advance ticks.
      if (
        msg.sender_id !== currentUserId &&
        msg.conversation_id === conversationId &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        void markThreadRead(conversationId).then(() => {
          setConversationUnread(conversationId, 0);
          scheduleUnreadResync();
        });
      }
    },
    [conversationId, currentUserId],
  );

  const applyEdit = useCallback((id: string, body: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, body, is_edited: true } : m)));
  }, []);

  const applyDelete = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const applyMarkRead = useCallback(
    (readerConversationId: string, at?: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.conversation_id === readerConversationId && m.sender_id === currentUserId && !m.read_at
            ? { ...m, read_at: at || new Date().toISOString(), delivered_at: m.delivered_at || at }
            : m,
        ),
      );
    },
    [currentUserId],
  );

  const applyMarkDelivered = useCallback(
    (deliveredConversationId: string, at?: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.conversation_id === deliveredConversationId &&
          m.sender_id === currentUserId &&
          !m.delivered_at
            ? { ...m, delivered_at: at || new Date().toISOString() }
            : m,
        ),
      );
    },
    [currentUserId],
  );

  /** Add an optimistic message (the caller owns the temp UUID for reconcile). */
  const addOptimistic = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const replaceOptimistic = useCallback((tempId: string, next: Partial<Message>) => {
    setMessages((prev) => {
      const updated = prev.map((m) => (m.id === tempId ? { ...m, ...next } : m));
      const seen = new Set<string>();
      return updated.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    });
  }, []);

  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const restoreMessage = useCallback((message: Message) => {
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
  }, []);

  const retargetConversation = useCallback((staleId: string, realId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.conversation_id === staleId ? { ...m, conversation_id: realId } : m)),
    );
  }, []);

  return {
    messages,
    hasMore,
    loadingOlder,
    atEnd,
    pendingCount,
    scrollRef,
    bottomRef,
    onScroll,
    scrollToLatest,
    ingest,
    applyEdit,
    applyDelete,
    applyMarkRead,
    applyMarkDelivered,
    addOptimistic,
    replaceOptimistic,
    removeMessage,
    restoreMessage,
    retargetConversation,
  };
}
