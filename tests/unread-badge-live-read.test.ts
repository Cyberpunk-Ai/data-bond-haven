// @vitest-environment node
/**
 * The Messages badge used to be a SINGLE global number that was both nudged
 * optimistically (open a thread → subtract) and overwritten wholesale by a
 * database re-count on every AppShell mount. The two models fought, and the
 * bubble looked broken:
 *   • it didn't drop the instant you read a thread ("not responsive") because a
 *     lone integer can only guess a subtraction and wait for a debounced re-read;
 *   • a slow re-count that started *before* you read a thread could resolve
 *     *after* the read and put the number back ("doesn't reset").
 *
 * The contract that fixes it — the badge is owned PER CONVERSATION:
 *   • the store keeps a `conversationId -> unread` map, so reading a thread
 *     zeroes exactly that entry the moment you act (setConversationUnread), and
 *     the visible total is just the sum of the map;
 *   • every database re-count carries a sequence number and only the newest one
 *     may apply its result (refreshSeq) — a stale read resolving last can never
 *     clobber a fresher value;
 *   • a re-count is reconciled against a local-touch overlay (syncFromConversations):
 *     a thread you touched after the read BEGAN keeps its local value, so a
 *     snapshot taken before you read it cannot resurrect a cleared badge;
 *   • an inbound message in the conversation you are *looking at* is marked seen
 *     the instant it lands (useThread.ingest → markThreadRead), so the store
 *     refuses to raise the badge for it; the messages route publishes that open
 *     id (and clears it on unmount) for the rule to compare against.
 *
 * Store/JSX/realtime code a node test cannot stand up is read out of source,
 * matching the rest of this suite.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const src = (rel: string) => read(`../src/${rel}`);

/** Text between two markers, so an assertion is about one region only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe("the badge is a per-conversation map, not one global number", () => {
  const store = src("lib/unread-state.ts");

  it("owns a conversationId -> unread map and derives the total from it", () => {
    expect(store).toContain("const unreadByConversation = new Map<string, number>();");
    expect(store).toContain("function recomputeMessagesTotal()");
    // The visible Messages count is the sum of the map, so zeroing one thread
    // drops exactly its share instead of guessing at a single subtraction.
    expect(
      between(store, "function recomputeMessagesTotal()", "globalUnread.notifications"),
    ).toContain("globalUnread.messages = sum");
  });

  it("exposes the moves the app needs and drops the old single-number setters", () => {
    expect(store).toContain(
      "export function setConversationUnread(conversationId: string, count: number)",
    );
    expect(store).toContain(
      "export function bumpConversationUnread(conversationId: string, delta = 1)",
    );
    expect(store).toContain("export function syncFromConversations(");
    // The whole inbox can no longer be overwritten with one optimistic integer.
    expect(store).not.toMatch(/export function (setUnreadMessagesCount|decrementUnreadMessages)\b/);
  });

  it("zeroes exactly the thread you read, and stamps a local touch so it stays down", () => {
    const setter = between(
      store,
      "export function setConversationUnread(conversationId: string, count: number)",
      "export function bumpConversationUnread",
    );
    expect(setter).toContain("if (n === 0) unreadByConversation.delete(conversationId);");
    expect(setter).toContain("localTouch.set(conversationId, Date.now());");
  });
});

describe("a stale database re-count can never resurrect a cleared badge", () => {
  const store = src("lib/unread-state.ts");

  it("only trusts the newest refresh (sequence guard)", () => {
    expect(store).toContain("let refreshSeq = 0;");
    const refresh = between(
      store,
      "export async function refreshUnreadCounts()",
      "export function useUnreadCounts",
    );
    expect(refresh).toContain("const seq = ++refreshSeq;");
    expect(refresh).toContain("if (seq !== refreshSeq) return;");
  });

  it("keeps a locally touched thread over a snapshot taken before the touch", () => {
    const sync = between(store, "export function syncFromConversations(", "let refreshSeq = 0;");
    // `fetchedAt` is when the read BEGAN; anything touched after that keeps its
    // (already lower) local value rather than adopting the older snapshot.
    expect(sync).toContain("(localTouch.get(id) ?? 0) > fetchedAt");
    const refresh = between(
      store,
      "export async function refreshUnreadCounts()",
      "export function useUnreadCounts",
    );
    expect(refresh).toContain("syncFromConversations(convs, fetchedAt)");
  });
});

describe("the store does not count a message you are already reading", () => {
  const store = src("lib/unread-state.ts");

  it("exposes a setter for the currently open conversation", () => {
    expect(store).toContain('let activeConversationId = "";');
    expect(store).toContain("export function setActiveMessagesConversation(id: string)");
    expect(store).toContain('activeConversationId = id || "";');
  });

  it("attributes an inbound message to its own conversation, after the guards", () => {
    const branch = between(
      store,
      'event.type === "message" ||',
      "bumpConversationUnread(convId, 1)",
    );
    // Still ignores our own echo first, then the open-thread guard.
    expect(branch).toContain("if (senderId && senderId === currentUserId) return;");
    expect(branch).toContain(
      "const convId = event.conversation_id || event.message?.conversation_id;",
    );
    expect(branch).toContain("if (convId && convId === activeConversationId) return;");
  });
});

describe("the messages route drives the per-conversation badge", () => {
  const route = src("routes/messages.tsx");

  it("imports the map setters, not a global count", () => {
    expect(route).toContain("setConversationUnread");
    expect(route).toContain("syncFromConversations");
    expect(route).toContain("setActiveMessagesConversation");
    expect(route).toMatch(/from "@\/lib\/unread-state"/);
    expect(route).not.toMatch(/setUnreadMessagesCount|decrementUnreadMessages/);
  });

  it("stamps fetch time and reconciles + zeroes the open thread on load", () => {
    const load = between(route, "const fetchedAt = Date.now();", "} else if (targetUserParam) {");
    expect(load).toContain("syncFromConversations(data, fetchedAt)");
    expect(load).toContain("setConversationUnread(targetConvId, 0)");
  });

  it("zeroes the conversation the moment you select it", () => {
    const select = between(
      route,
      "function selectConversation(id: string)",
      "// Tell the global badge",
    );
    expect(select).toContain("setConversationUnread(id, 0);");
  });

  it("publishes the open id and clears it on unmount", () => {
    const effect = between(route, "setActiveMessagesConversation(activeId", "}, [activeId]);");
    // A placeholder (`c_…`) thread is not a real conversation, so it must not
    // suppress the badge for a genuine inbound message.
    expect(effect).toContain('!activeId.startsWith("c_")');
    expect(route).toContain('return () => setActiveMessagesConversation("");');
  });
});

describe("the premise: reading a thread zeroes it immediately, not after a re-read", () => {
  const thread = src("hooks/use-messages/useThread.ts");

  it("imports the per-conversation setter", () => {
    expect(thread).toContain(
      'import { scheduleUnreadResync, setConversationUnread } from "@/lib/unread-state"',
    );
  });

  it("zeroes the conversation the instant a live arrival is marked read", () => {
    const ingest = between(thread, "const ingest = useCallback(", "const applyEdit = useCallback(");
    expect(ingest).toContain("msg.sender_id !== currentUserId");
    expect(ingest).toContain("msg.conversation_id === conversationId");
    expect(ingest).toContain('document.visibilityState === "visible"');
    expect(ingest).toContain("void markThreadRead(conversationId).then(() => {");
    expect(ingest).toContain("setConversationUnread(conversationId, 0);");
  });

  it("zeroes it on the open/load path too, so the count never survives a navigation", () => {
    const load = between(thread, "Load the newest page whenever", "const onScroll = useCallback(");
    expect(load).toContain("void markThreadRead(conversationId).then(() => {");
    expect(load).toContain("setConversationUnread(conversationId, 0);");
  });
});
