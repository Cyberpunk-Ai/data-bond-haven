import { useState, useEffect } from "react";
import { getNotifications, getConversations } from "@/lib/api-client";
import { currentUserId } from "@/lib/profile-service";
import { useRealtime } from "@/lib/realtime";

interface UnreadCounts {
  notifications: number;
  messages: number;
}

const globalUnread: UnreadCounts = {
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
      if (event.type === "notification") {
        // Only the addressed DB row lights the bell — the feed listener already
        // filters by recipient. Raw "like"/"follow" broadcasts are *someone's*
        // actions on the shared bus (including your own optimistic echo); the
        // notification row the database creates for the recipient is the one
        // event that should ever increment, so counting both double-tipped.
        const notif = event.notification ?? (event.recipient_id ? event : null);
        if (notif?.id) setUnreadNotificationsCount((prev) => prev + 1);
      } else if (event.type === "notification_read") {
        // Read on another device — debounced re-count from the database keeps
        // the badge truthful ("mark all read" fires one UPDATE per row).
        scheduleUnreadResync();
      } else if (
        event.type === "message" ||
        event.type === "new_direct_message" ||
        event.type === "message:created"
      ) {
        // Never count our own optimistic echo — only an incoming message from
        // someone else should light up the Messages badge.
        const senderId = event.message?.sender_id || event.sender_id;
        if (senderId && senderId === currentUserId) return;
        setUnreadMessagesCount((prev) => prev + 1);
      }
    },
    ["notification", "notification_read", "message", "message:created"],
  );

  return counts;
}

let resyncTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesce a burst of read events into a single database re-count. */
function scheduleUnreadResync() {
  if (resyncTimer) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    void refreshUnreadCounts();
  }, 750);
}
