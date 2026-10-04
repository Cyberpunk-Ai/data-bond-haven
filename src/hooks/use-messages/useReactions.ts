import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getMessageReactions, toggleMessageReaction } from "@/lib/api-client";

type Counts = Record<string, Record<string, number>>;
type Mine = Record<string, string[]>;

function bump(counts: Counts, msgId: string, emoji: string, delta: number): Counts {
  const msgMap = { ...(counts[msgId] || {}) };
  const next = (msgMap[emoji] ?? 0) + delta;
  if (next <= 0) delete msgMap[emoji];
  else msgMap[emoji] = next;
  return { ...counts, [msgId]: msgMap };
}

/**
 * Reaction tallies for the open thread. Loads them with the thread, applies a
 * remote toggle from realtime, and owns the optimistic add/remove + rollback for
 * the current user — so the pip under a bubble reacts instantly and quietly
 * corrects itself if the write fails.
 */
export function useReactions(args: { conversationId: string; currentUserId: string }) {
  const { conversationId, currentUserId } = args;
  const [counts, setCounts] = useState<Counts>({});
  const [mine, setMine] = useState<Mine>({});

  useEffect(() => {
    if (!conversationId || conversationId.startsWith("c_")) {
      setCounts({});
      setMine({});
      return;
    }
    let alive = true;
    void getMessageReactions(conversationId)
      .then(({ counts: c, mine: m }) => {
        if (!alive) return;
        setCounts(c);
        setMine(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const applyRemote = useCallback(
    (messageId: string, emoji: string, on: boolean, userId: string) => {
      if (userId === currentUserId) return; // optimistic already reflected it
      setCounts((prev) => bump(prev, messageId, emoji, on ? 1 : -1));
    },
    [currentUserId],
  );

  const toggle = useCallback(
    (messageId: string, emoji: string) => {
      const already = (mine[messageId] || []).includes(emoji);
      const turnOn = !already;
      setCounts((prev) => bump(prev, messageId, emoji, turnOn ? 1 : -1));
      setMine((prev) => {
        const list = prev[messageId] || [];
        return {
          ...prev,
          [messageId]: turnOn ? [...list, emoji] : list.filter((e) => e !== emoji),
        };
      });

      void toggleMessageReaction(messageId, emoji, turnOn).catch(() => {
        // Roll back the optimistic change.
        setCounts((prev) => bump(prev, messageId, emoji, turnOn ? -1 : 1));
        setMine((prev) => {
          const list = prev[messageId] || [];
          return {
            ...prev,
            [messageId]: turnOn ? list.filter((e) => e !== emoji) : [...list, emoji],
          };
        });
        toast.error("Couldn't save that reaction");
      });
    },
    [mine],
  );

  return { counts, mine, toggle, applyRemote };
}
