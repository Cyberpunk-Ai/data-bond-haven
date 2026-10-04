// A finished call never touches `messages` (cards are derived from the `calls`
// table), so the conversation trigger leaves `preview`/`updated_at` on the last
// *message* — the inbox rail had no way to know a call beat it and showed plain
// text where a photo/video/document gets a glyph. The contract that fixes it:
//   • `getConversations` reads the newest finished call per peer from `calls`
//     and stamps `last_call_at` / `last_call_kind` on the conversation;
//   • the rail row swaps in a phone/video icon + call label when the call beat
//     `updated_at` — decided by the pure `isCallActivity` helper;
//   • `call:resolved` stamps the open page optimistically, so the glyph appears
//     without a reload (the next DB refresh reconciles from the source of truth).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { callPreviewLabel, isCallActivity } from "@/lib/message-helpers";

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

describe("isCallActivity — was the last activity a call?", () => {
  const t = (iso: string) => new Date(iso).toISOString();

  it("is a call only when the call strictly beat the last message", () => {
    expect(isCallActivity(t("2026-10-04T10:00:00Z"), t("2026-10-04T09:00:00Z"))).toBe(true);
    expect(isCallActivity(t("2026-10-04T09:00:00Z"), t("2026-10-04T10:00:00Z"))).toBe(false);
    expect(isCallActivity(t("2026-10-04T10:00:00Z"), t("2026-10-04T10:00:00Z"))).toBe(false);
  });

  it("never claims a call it cannot prove (missing or unreadable call time)", () => {
    expect(isCallActivity(undefined, t("2026-10-04T09:00:00Z"))).toBe(false);
    expect(isCallActivity("", t("2026-10-04T09:00:00Z"))).toBe(false);
    expect(isCallActivity("not-a-date", t("2026-10-04T09:00:00Z"))).toBe(false);
  });

  it("a real call still counts when the conversation timestamp is unreadable", () => {
    expect(isCallActivity(t("2026-10-04T10:00:00Z"), "not-a-date")).toBe(true);
    expect(isCallActivity(t("2026-10-04T10:00:00Z"), undefined)).toBe(true);
  });
});

describe("callPreviewLabel reads like the thread's own wording", () => {
  it("distinguishes voice from video", () => {
    expect(callPreviewLabel("video")).toBe("📹 Video call");
    expect(callPreviewLabel("voice")).toBe("📞 Voice call");
    expect(callPreviewLabel(undefined)).toBe("📞 Voice call");
  });
});

describe("getConversations hydrates the last call per relationship", () => {
  const api = src("lib/api-client.ts");
  const region = between(
    api,
    "export async function getConversations",
    "export async function markThreadRead",
  );

  it("reads the calls table alongside the unread tally", () => {
    expect(region).toContain('.from("calls")');
    expect(region).toContain("caller_id.eq.${userId},callee_id.eq.${userId}");
    // Newest-first so the first finished card per peer is the latest call.
    expect(region).toContain('.order("started_at", { ascending: false })');
  });

  it("drops live rings via callCardFromRow before picking the newest", () => {
    expect(region).toContain("callCardFromRow(row, userId)");
    expect(region).toContain("lastCallByPeer.set(peer,");
  });

  it("stamps last_call_at / last_call_kind onto each conversation", () => {
    expect(region).toContain("last_call_at: lastCall.at, last_call_kind: lastCall.kind");
  });
});

describe("the inbox row swaps the preview glyph for a call", () => {
  const row = src("components/messages/ConversationRow.tsx");

  it("consults isCallActivity before the attachment kinds", () => {
    expect(row).toContain("isCallActivity(conversation.last_call_at, conversation.updated_at)");
    const icon = between(row, "const PreviewIcon = lastWasCall", ";");
    expect(icon).toContain('conversation.last_call_kind === "video"');
    expect(icon).toMatch(/Video\s*$/m);
    expect(icon).toContain(": Phone");
  });

  it("labels the line through callPreviewLabel, not the stale message preview", () => {
    expect(row).toContain("callPreviewLabel(conversation.last_call_kind)");
    expect(row).toContain("previewLabel(conversation.preview)");
  });
});

describe("the messages page stamps the rail the moment a call resolves", () => {
  const route = src("routes/messages.tsx");
  const handler = between(route, 'if (event.type === "call:resolved")', "return;\n    }");

  it("derives the peer from the calls row (either side of the dial)", () => {
    expect(handler).toContain("event.caller_id === currentUserId");
    expect(handler).toContain("event.callee_id");
  });

  it("optimistically stamps last_call_at / last_call_kind on that conversation", () => {
    expect(handler).toContain("c.participant_id === callPeer");
    expect(handler).toContain("last_call_at: callAt");
    expect(handler).toContain('event.kind === "video" ? "video" : "voice"');
  });
});
