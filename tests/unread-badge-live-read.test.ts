// @vitest-environment node
/**
 * The Messages badge used to keep a number after you had already read the
 * thread: an inbound message in the conversation you are *looking at* is marked
 * seen the instant it lands (useThread.ingest → markThreadRead), yet the global
 * unread store incremented its own counter for it unconditionally, and nothing
 * ever decremented that live arrival — so the bubble only cleared on a full
 * reload.
 *
 * The contract that fixes it:
 *   • unread-state knows which conversation is open and refuses to raise the
 *     badge for a message that belongs to it;
 *   • the messages route publishes that "open conversation" id (and clears it
 *     on unmount) so the store's rule has something to compare against;
 *   • the premise still holds — useThread really does mark the active thread
 *     read on arrival, which is why skipping the increment is safe.
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

describe("the unread store does not count a message you are already reading", () => {
  const store = src("lib/unread-state.ts");

  it("exposes a setter for the currently open conversation", () => {
    expect(store).toContain('let activeConversationId = "";');
    expect(store).toContain("export function setActiveMessagesConversation(id: string)");
    expect(store).toContain('activeConversationId = id || "";');
  });

  it("skips the badge increment when the message is in the open thread", () => {
    const branch = between(
      store,
      'event.type === "message" ||',
      "setUnreadMessagesCount((prev) => prev + 1)",
    );
    // Still ignores our own echo first, then the open-thread guard.
    expect(branch).toContain("if (senderId && senderId === currentUserId) return;");
    expect(branch).toContain(
      "const convId = event.conversation_id || event.message?.conversation_id;",
    );
    expect(branch).toContain("if (convId && convId === activeConversationId) return;");
  });
});

describe("the messages route publishes which thread is open", () => {
  const route = src("routes/messages.tsx");

  it("imports the setter", () => {
    expect(route).toContain("setActiveMessagesConversation");
    expect(route).toMatch(/from "@\/lib\/unread-state"/);
  });

  it("sets it from activeId and clears it on unmount", () => {
    const effect = between(route, "setActiveMessagesConversation(activeId", "}, [activeId]);");
    // A placeholder (`c_…`) thread is not a real conversation, so it must not
    // suppress the badge for a genuine inbound message.
    expect(effect).toContain('!activeId.startsWith("c_")');
    expect(route).toContain('return () => setActiveMessagesConversation("");');
  });
});

describe("the premise: an inbound message in the open thread is marked read live", () => {
  const thread = src("hooks/use-messages/useThread.ts");
  const ingest = between(thread, "const ingest = useCallback(", "const applyEdit = useCallback(");

  it("calls markThreadRead only for a visible inbound message in this thread", () => {
    expect(ingest).toContain("msg.sender_id !== currentUserId");
    expect(ingest).toContain("msg.conversation_id === conversationId");
    expect(ingest).toContain('document.visibilityState === "visible"');
    // The resync chained on the write is what makes the badge *persist*: the DB
    // is re-read only after `read_at` actually committed, so navigating away
    // (AppShell re-counts on mount) cannot resurrect a count already read.
    expect(ingest).toContain("void markThreadRead(conversationId).then(scheduleUnreadResync);");
  });

  it("re-syncs the global badge after the write of every read path, not just live arrivals", () => {
    // Opening a thread marks it read too — that write must reconcile the badge
    // as well, or the resurrected count survives until the next coincidence.
    const load = between(thread, "Load the newest page whenever", "const onScroll = useCallback(");
    expect(load).toContain("void markThreadRead(conversationId).then(scheduleUnreadResync);");
    expect(thread).toContain('import { scheduleUnreadResync } from "@/lib/unread-state"');
  });
});
