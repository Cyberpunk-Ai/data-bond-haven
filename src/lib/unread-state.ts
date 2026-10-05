import { useState, useEffect, useSyncExternalStore } from "react";
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

// The moment (ms) the viewer explicitly READ a conversation this session, i.e.
// its local count was driven to 0. A conversation's inbox `updated_at` advances
// ONLY when a new message arrives (the after-insert trigger stamps the row; a
// read-receipt UPDATE never moves it). So while a thread is latched here, a
// re-count that still reports unread for it WITHOUT a newer `updated_at` is a
// stale snapshot of messages already read — the "counter regenerates after I
// read them" bug — and must be ignored. A real inbound bump (a positive set)
// clears the latch, and a full reload starts fresh from the database truth.
const readClearedAt = new Map<string, number>();

// The conversation whose thread is open on screen right now. While it is set,
// an incoming message in it is marked read the moment it lands (useThread's
// ingest calls markThreadRead), so the badge must not count it — otherwise a
// number you have already read is left stranded until a full page reload.
let activeConversationId = "";

export function setActiveMessagesConversation(id: string) {
  activeConversationId = id || "";
}

const listeners = new Set<(counts: UnreadCounts) => void>();

// The inbox rail (each conversation row) must show the SAME number the nav badge
// does — i.e. the latched `unreadByConversation` map — and not its own re-adopted
// copy of `getConversations().unread`. Publishing a frozen snapshot of the map
// lets the messages page subscribe (useSyncExternalStore) and render the
// authoritative per-thread count, so reading a thread stays cleared in the rail
// across reloads instead of regenerating. The snapshot reference only changes
// when the map's contents actually change, so unrelated notification bumps do
// not re-render the rail.
const rowListeners = new Set<() => void>();
let conversationSnapshot: ReadonlyMap<string, number> = new Map();

function publishConversationUnread() {
  if (conversationSnapshot.size === unreadByConversation.size) {
    let same = true;
    for (const [id, n] of unreadByConversation) {
      if (conversationSnapshot.get(id) !== n) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  conversationSnapshot = new Map(unreadByConversation);
  rowListeners.forEach((listener) => listener());
}

function notify() {
  publishConversationUnread();
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
  if (n === 0) {
    unreadByConversation.delete(conversationId);
    readClearedAt.set(conversationId, Date.now());
  } else {
    unreadByConversation.set(conversationId, n);
    // A genuine count (an inbound bump) supersedes the "already read" latch.
    readClearedAt.delete(conversationId);
  }
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
 * resurrect a badge you had already cleared. The guard consults `localTouch`
 * directly while adopting the snapshot, NOT by walking the map: reading a thread
 * DELETES it from `unreadByConversation` (a zero count is stored as an absence),
 * so a map walk would skip the just-read id entirely and let the older snapshot
 * put its unread back — the "still shows 4 after I read them all" bug.
 */
export function syncFromConversations(
  conversations: Array<{ id: string; unread?: number | null; updated_at?: string }>,
  fetchedAt = 0,
) {
  const next = new Map<string, number>();
  for (const c of conversations ?? []) {
    const id = String(c.id);
    const u = c.unread || 0;
    if (u <= 0) continue;
    // Touched after the snapshot began → already correct locally (zeroed on read,
    // or bumped by a live arrival). Ignore this stale row; the loop below re-adds
    // it only if the local value is a positive count still held in the map.
    if ((localTouch.get(id) ?? 0) > fetchedAt) continue;
    // Read this session: only a NEWER conversation activity (an actual inbound
    // message, which is the sole thing that advances `updated_at`) may bring the
    // badge back — otherwise this unread is a stale snapshot of what we cleared.
    const clearedAt = readClearedAt.get(id);
    if (
      clearedAt !== undefined &&
      !(c.updated_at && new Date(c.updated_at).getTime() > clearedAt)
    ) {
      continue;
    }
    next.set(id, u);
  }
  // Re-apply any locally-touched thread the snapshot did not carry at all (a
  // brand-new inbound bump) as long as its local count is still positive.
  for (const [id, localCount] of unreadByConversation) {
    if ((localTouch.get(id) ?? 0) > fetchedAt && localCount > 0) next.set(id, localCount);
  }
  unreadByConversation.clear();
  for (const [id, u] of next) unreadByConversation.set(id, u);
  recomputeMessagesTotal();
  // The reconcile IS the truth for the badge now, so publish it. Callers may not
  // follow up with another move: the messages route's loadConversations() only
  // calls setConversationUnread (which notifies) when the opened thread happened
  // to carry unread — so without this the nav total could stay stale/disagree
  // with the freshly reconciled map until some unrelated later event fired.
  // refreshUnreadCounts()'s trailing notify() becomes a harmless re-publish.
  notify();
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

function subscribeConversationUnread(onChange: () => void) {
  rowListeners.add(onChange);
  return () => {
    rowListeners.delete(onChange);
  };
}

function getConversationUnreadSnapshot() {
  return conversationSnapshot;
}

/**
 * The authoritative `conversationId -> unread` map, as a React subscription.
 * Only threads with live unread are present (a zero is an absence), so a row
 * renders `map.get(id) ?? 0`. Because this is the SAME latched map the nav badge
 * sums, a thread you have read stays cleared in the inbox rail across reloads —
 * it can no longer be regenerated by a stale `getConversations` snapshot.
 */
export function useConversationUnread(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    subscribeConversationUnread,
    getConversationUnreadSnapshot,
    getConversationUnreadSnapshot,
  );
}
