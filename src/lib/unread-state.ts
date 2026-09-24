import { useState, useEffect, useCallback } from "react";
import { getNotifications, getConversations } from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";

interface UnreadCounts {
  notifications: number;
  messages: number;
}

let globalUnread: UnreadCounts = {
  notifications: 0,
  messages: 0,
};

const listeners = new Set<(counts: UnreadCounts) => void>();

function notify() {
  listeners.forEach((listener) => listener({ ...globalUnread }));
  if (typeof window !== "undefined") {
    queueMicrotask(() => {
      window.dispatchEvent(
        new CustomEvent("spaces:unread_updated", { detail: { ...globalUnread } }),
      );
    });
  }
}

export function setUnreadNotificationsCount(count: number | ((prev: number) => number)) {
  const next = typeof count === "function" ? count(globalUnread.notifications) : count;
  globalUnread.notifications = Math.max(0, next);
  notify();
}

export function setUnreadMessagesCount(count: number | ((prev: number) => number)) {
  const next = typeof count === "function" ? count(globalUnread.messages) : count;
  globalUnread.messages = Math.max(0, next);
  notify();
}

export function decrementUnreadNotifications(amount = 1) {
  globalUnread.notifications = Math.max(0, globalUnread.notifications - amount);
  notify();
}

export function decrementUnreadMessages(amount = 1) {
  globalUnread.messages = Math.max(0, globalUnread.messages - amount);
  notify();
}

export function clearAllUnreadNotifications() {
  globalUnread.notifications = 0;
  notify();
}

export async function refreshUnreadCounts() {
  try {
    const [notifs, convs] = await Promise.all([
      getNotifications().catch(() => null),
      getConversations().catch(() => null),
    ]);

    if (notifs) {
      globalUnread.notifications = notifs.filter((n) => !n.read).length;
    }
    if (convs) {
      globalUnread.messages = convs.reduce((sum, c) => sum + (c.unread || 0), 0);
    }
    notify();
  } catch (err) {
    console.warn("Error refreshing unread counts:", err);
  }
}

export function useUnreadCounts() {
  const [counts, setCounts] = useState<UnreadCounts>(() => ({ ...globalUnread }));

  useEffect(() => {
    listeners.add(setCounts);
    // Initial fetch if counts are zero
    refreshUnreadCounts();
    return () => {
      listeners.delete(setCounts);
    };
  }, []);

  // Listen to realtime events
  useRealtime(
    (event) => {
      if (
        event.type === "notification" ||
        event.type === "like" ||
        event.type === "repost" ||
        event.type === "follow"
      ) {
        setUnreadNotificationsCount((prev) => prev + 1);
      } else if (event.type === "message" || event.type === "new_direct_message") {
        setUnreadMessagesCount((prev) => prev + 1);
      }
    },
    ["notification", "like", "repost", "follow", "message"],
  );

  return counts;
}
