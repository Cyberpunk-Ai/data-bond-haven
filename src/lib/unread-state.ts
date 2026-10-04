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

/**
 * The Messages badge is owned PER CONVERSATION, not as one global number.
 *
 * It used to be a single integer that was nudged optimistically (open a thread →
 * subtract) and then overwritten wholesale by a database re-count on every
 * AppShell mount. Those two models fought, and the badge looked broken:
 *   • two re-counts run at once on a navigation (the page you leave and the page
 *     you land each mount an AppShell), and a slow one started BEFORE you read a
 *     thread could resolve AFTER the read and put the number back — "doesn't
 *     reset";
 *   • a single number can't zero just the thread you read, so it could only
 *     guess a subtraction and wait for a debounced re-read — "not responsive".
 *
 * Keeping a `conversationId -> unread` map fixes both: reading a thread zeroes
 * exactly that entry immediately, and a re-count is only trusted when it is the
 * newest one (see `refreshSeq`) and only for threads you did not touch while it
 * was in flight (see `localTouch`).
 */
const unreadByConversation = new Map<string, number>();

// When a conversation was last set locally (opened, read, or an inbound bump),
// so a database snapshot taken before that moment can never overwrite it back.
const localTouch = new Map<string, number>();

// The conversation whose thread is open on screen right now. While it is set,
// an incoming message in it is marked read the moment it lands (useThread's
// ingest calls markThreadRead), so the badge must not count it — otherwise a
// number you have already read is left stranded until a full page reload.
let activeConversationId = "";

export function setActiveMessagesConversation(id: string) {
  activeConversationId = id || "";
}

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

function recomputeMessagesTotal() {
  let sum = 0;
  for (const n of unreadByConversation.values()) sum += n;
  globalUnread.messages = sum;
}

export function setUnreadNotificationsCount(count: number | ((prev: number) => number)) {
  const next = typeof count === "function" ? count(globalUnread.notifications) : count;
  globalUnread.notifications = Math.max(0, next);
  notify();
}

export function decrementUnreadNotifications(amount = 1) {
  globalUnread.notifications = Math.max(0, globalUnread.notifications - amount);
  notify();
}

export function clearAllUnreadNotifications() {
  globalUnread.notifications = 0;
  notify();
}

/**
 * Set one conversation's inbound-unread count and refresh the badge total. This
 * is the optimistic, authoritative move: opening or reading a thread calls it
 * with 0, so the number drops the instant you act rather than after a re-read.
 */
export function setConversationUnread(conversationId: string, count: number) {
  if (!conversationId) return;
  const n = Math.max(0, count);
  if (n === 0) unreadByConversation.delete(conversationId);
  else unreadByConversation.set(conversationId, n);
  localTouch.set(conversationId, Date.now());
  recomputeMessagesTotal();
  notify();
}

/** Nudge one conversation's count — an inbound message arriving elsewhere. */
export function bumpConversationUnread(conversationId: string, delta = 1) {
  if (!conversationId) return;
  setConversationUnread(conversationId, (unreadByConversation.get(conversationId) ?? 0) + delta);
}

/**
 * Reconcile the map from a database conversation list.
 *
 * `fetchedAt` is the moment the read BEGAN. Any conversation touched locally
 * after that instant is already at its true (lower) value — the snapshot we just
 * received was taken before you opened/read it, so trusting the snapshot would
 * resurrect a badge you had already cleared. Those threads keep their local
 * count; everything else adopts the database number.
 */
export function syncFromConversations(
  conversations: Array<{ id: string; unread?: number | null }>,
  fetchedAt = 0,
) {
  const next = new Map<string, number>();
  for (const c of conversations ?? []) {
    const id = String(c.id);
    const u = c.unread || 0;
    if (u > 0) next.set(id, u);
  }
  for (const [id, localCount] of unreadByConversation) {
    if ((localTouch.get(id) ?? 0) > fetchedAt) {
      if (localCount > 0) next.set(id, localCount);
      else next.delete(id);
    }
  }
  unreadByConversation.clear();
  for (const [id, u] of next) unreadByConversation.set(id, u);
  recomputeMessagesTotal();
}

// Only the newest refresh may apply its result: navigations start overlapping
// reads, and a stale one resolving last must never clobber a fresher value.
let refreshSeq = 0;

export async function refreshUnreadCounts() {
  const seq = ++refreshSeq;
  const fetchedAt = Date.now();
  try {
    const [notifs, convs] = await Promise.all([
      getNotifications().catch(() => null),
      getConversations().catch(() => null),
    ]);

    // A newer refresh started while we were awaiting: its numbers are fresher,
    // so drop this response entirely rather than write stale counts back.
    if (seq !== refreshSeq) return;

    if (notifs) {
      globalUnread.notifications = notifs.filter((n) => !n.read).length;
    }
    if (convs) {
      syncFromConversations(convs, fetchedAt);
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
    // Re-count from the database on mount so a fresh navigation (or a return
    // after being away) reflects the truth, reconciled against local touches.
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
        // A message in the thread you are actively reading is marked seen the
        // instant it arrives, so raising the badge for it would strand a count
        // that nothing ever clears (you are already looking at it).
        const convId = event.conversation_id || event.message?.conversation_id;
        if (convId && convId === activeConversationId) return;
        // Attribute the arrival to its own conversation, so the total is the sum
        // of threads and a later read can clear exactly this one.
        if (convId) bumpConversationUnread(convId, 1);
      }
    },
    ["notification", "notification_read", "message", "message:created"],
  );

  return counts;
}

let resyncTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesce a burst of read events into a single database re-count. */
export function scheduleUnreadResync() {
  if (resyncTimer) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    void refreshUnreadCounts();
  }, 750);
}
