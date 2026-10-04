import { useCallback, useEffect, useRef, useState } from "react";
import { emitRealtime } from "@/lib/realtime";

/** A typing indicator is dropped this long after the last keystroke from them. */
const TYPING_TTL_MS = 4000;
/** Don't broadcast a typing ping more than once per this window. */
const TYPING_THROTTLE_MS = 2000;

/**
 * The "typing…" signal. `notify` is throttled so a burst of keystrokes is one
 * broadcast, not twenty; `applyRemote` records the instant we last saw them
 * typing; an interval quietly expires stale indicators.
 */
export function useTyping(args: { currentUserId: string }) {
  const { currentUserId } = args;
  const [typingIn, setTypingIn] = useState<Record<string, number>>({});
  const lastSentRef = useRef(0);

  const notify = useCallback(
    (conversationId: string) => {
      if (!conversationId) return;
      const now = Date.now();
      if (now - lastSentRef.current < TYPING_THROTTLE_MS) return;
      lastSentRef.current = now;
      emitRealtime("message:typing", { conversationId, userId: currentUserId });
    },
    [currentUserId],
  );

  const applyRemote = useCallback(
    (conversationId: string, userId: string) => {
      if (!userId || userId === currentUserId) return;
      setTypingIn((prev) => ({ ...prev, [conversationId]: Date.now() }));
    },
    [currentUserId],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setTypingIn((prev) => {
        const cutoff = Date.now() - TYPING_TTL_MS;
        let changed = false;
        const next: Record<string, number> = {};
        for (const [key, at] of Object.entries(prev)) {
          if (Number(at) > cutoff) next[key] = Number(at);
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  return { typingIn, notify, applyRemote };
}
