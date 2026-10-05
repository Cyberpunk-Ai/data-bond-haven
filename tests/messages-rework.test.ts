// @vitest-environment node
/**
 * The messages rework pulled a pile of behaviour out of the 2,800-line page into
 * pure helpers (`message-helpers`), a server function (`link-preview`) and two
 * paginated read/receipt paths in `api-client`. The pure pieces are exercised for
 * real below; the DB-bound and network-bound pieces are pinned as source
 * contracts, matching how the rest of this suite handles Supabase/fetch code that
 * a unit test cannot safely stand up.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MESSAGE_EDIT_WINDOW_MS } from "@/lib/message-constants";
import {
  attachmentKind,
  canEdit,
  dayLabel,
  extractUrls,
  previewLabel,
  tokenizeBody,
} from "@/lib/message-helpers";
import { extractLinkMeta } from "@/lib/link-preview.functions";
import type { Message } from "@/lib/types";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** Text between two markers, so an assertion is about one function only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    sender_id: "u1",
    body: "hi",
    created_at: new Date().toISOString(),
    ...over,
  } as Message;
}

describe("attachmentKind classifies a body for inline rendering", () => {
  it("recognises media by extension and path", () => {
    expect(attachmentKind("https://cdn/x/photo.PNG")).toBe("image");
    expect(attachmentKind("https://cdn/x/clip.mp4")).toBe("video");
    expect(attachmentKind("https://cdn/song.mp3")).toBe("audio");
    expect(attachmentKind("https://cdn/report.pdf")).toBe("pdf");
    expect(attachmentKind("https://cdn/sheet.xlsx")).toBe("document");
    expect(attachmentKind("/api/public/media/messages/blob")).toBe("document");
  });

  it("recognises data urls and tagged markup", () => {
    expect(attachmentKind("data:image/png;base64,AAAA")).toBe("image");
    expect(attachmentKind("data:application/pdf;base64,AAAA")).toBe("pdf");
    expect(attachmentKind("🎙️ Voice Note (7s) [/api/public/media/x]")).toBe("audio");
    expect(attachmentKind("📄 Document: [a.pdf] [/x]")).toBe("document");
  });

  it("leaves plain text and bare non-media links as text", () => {
    expect(attachmentKind("just words")).toBeNull();
    expect(attachmentKind("https://example.com/blog/post")).toBeNull();
    expect(attachmentKind("")).toBeNull();
  });
});

describe("previewLabel never leaks a raw media path into the inbox rail", () => {
  it("collapses attachments to a friendly label", () => {
    expect(previewLabel("🎙️ Voice Note (7s) [/api/public/media/x]")).toBe("🎙️ Voice message");
    expect(previewLabel("https://cdn/photo.jpg")).toBe("📷 Photo");
    expect(previewLabel("https://cdn/clip.mp4")).toBe("🎬 Video");
    expect(previewLabel("https://cdn/report.pdf")).toBe("📄 PDF Document");
    expect(previewLabel("https://cdn/invoice.pdf")).toBe("📄 PDF Document");
    expect(previewLabel("📄 Document: [invoice.pdf] [/api/x]")).toBe("📎 invoice.pdf");
    expect(previewLabel("https://cdn/sheet.xlsx")).toBe("📎 File Attachment");
    expect(previewLabel("https://files.example.com/x/secret")).toBe("📎 Attachment");
  });

  it("passes a real sentence through untouched", () => {
    expect(previewLabel("See you at seven")).toBe("See you at seven");
  });
});

describe("canEdit honours the shared edit window", () => {
  it("allows a fresh message and refuses a stale one", () => {
    expect(canEdit(msg({ created_at: new Date().toISOString() }))).toBe(true);
    expect(
      canEdit(
        msg({ created_at: new Date(Date.now() - MESSAGE_EDIT_WINDOW_MS - 1000).toISOString() }),
      ),
    ).toBe(false);
  });
});

describe("tokenizeBody splits links, mentions and hashtags", () => {
  it("emits ordered tokens for each entity", () => {
    const tokens = tokenizeBody("hey @ada see https://x.dev/a #shipit ok");
    expect(tokens.map((t) => t.type)).toEqual([
      "text",
      "mention",
      "text",
      "url",
      "text",
      "hashtag",
      "text",
    ]);
    expect(tokens.find((t) => t.type === "url")?.value).toBe("https://x.dev/a");
  });

  it("keeps a URL containing an @ as one link, not a fake mention", () => {
    const tokens = tokenizeBody("read https://site/@user now");
    expect(tokens.filter((t) => t.type === "mention")).toHaveLength(0);
    expect(tokens.filter((t) => t.type === "url")).toHaveLength(1);
  });

  it("returns a single text token for a plain body", () => {
    expect(tokenizeBody("nothing special here")).toEqual([
      { type: "text", value: "nothing special here" },
    ]);
  });
});

describe("extractUrls de-duplicates in first-seen order", () => {
  it("drops repeats but keeps order", () => {
    expect(extractUrls("a https://x.dev b https://y.dev a https://x.dev")).toEqual([
      "https://x.dev",
      "https://y.dev",
    ]);
  });
});

describe("dayLabel names today and yesterday plainly", () => {
  it("collapses the two most recent days", () => {
    const now = new Date();
    expect(dayLabel(now.toISOString())).toBe("Today");
    expect(dayLabel(new Date(now.getTime() - 86_400_000).toISOString())).toBe("Yesterday");
  });
});

describe("extractLinkMeta reads Open Graph / Twitter metadata", () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Hello" />
      <meta property="og:description" content="A page about things" />
      <meta property="og:image" content="/thumb.png" />
    </head><body></body></html>`;

  it("returns title, description and an absolutised image", () => {
    const meta = extractLinkMeta(html, "https://example.com/blog/post");
    expect(meta.ok).toBe(true);
    expect(meta.title).toBe("Hello");
    expect(meta.description).toBe("A page about things");
    expect(meta.image).toBe("https://example.com/thumb.png");
    expect(meta.host).toBe("example.com");
  });

  it("falls back to a <title> tag when there is no og:title", () => {
    const meta = extractLinkMeta(
      "<html><head><title>Fallback</title></head></html>",
      "https://a.dev/",
    );
    expect(meta.title).toBe("Fallback");
  });

  it("reports no preview for a page with neither text metadata", () => {
    const meta = extractLinkMeta("<html><body>nothing</body></html>", "https://a.dev/");
    expect(meta.ok).toBe(false);
  });
});

describe("getMessagesPage pages a thread newest-first and returns ascending", () => {
  const client = read("../src/lib/api-client.ts");
  const fn = between(
    client,
    "export async function getMessagesPage(",
    "export async function markThreadRead(",
  );

  it("rejects a non-uuid conversation before touching the socket", () => {
    expect(fn).toContain("if (!isDbId(conversationId)) return { messages: [], hasMore: false }");
  });

  it("asks for one extra row as the hasMore sentinel", () => {
    expect(fn).toContain('.order("created_at", { ascending: false })');
    expect(fn).toContain(".limit(limit + 1)");
    expect(fn).toContain("const hasMore = rows.length > limit;");
  });

  it("drops the sentinel and reverses to oldest-first for rendering", () => {
    expect(fn).toContain("rows.slice(0, limit) : rows).reverse()");
  });

  it("pages older rows with a strict before cursor", () => {
    expect(fn).toContain('q.lt("created_at", opts.before)');
  });

  it("no longer sends a client-side hidden_for filter — the exclusion is in RLS", () => {
    // 20261006000001 moved the check into `messages participant read`. The
    // old `q.not("hidden_for", "cs", [myId])` was the 400 (supabase-js
    // stringifies a single-element array without the `{}` wrapper PostgREST
    // needs), and the `build(true)/build(false)` retry was only papering
    // over that failure — every thread open paid a bad request first.
    expect(fn).not.toMatch(/\.not\(\s*"hidden_for"\s*,\s*"cs"\s*,\s*\[/);
    expect(fn).not.toContain("build(false)");
    expect(fn).not.toContain("build(true)");
  });
});

describe("markThreadRead is idempotent and emits receipt events", () => {
  const client = read("../src/lib/api-client.ts");
  const fn = between(
    client,
    "export async function markThreadRead(",
    "export async function getCallHistory(",
  );

  it("only writes where the column is still null (repeatable)", () => {
    expect(fn).toContain('.is("delivered_at", null)');
    expect(fn).toContain('.is("read_at", null)');
  });

  it("never marks the viewer's own outbound messages", () => {
    expect(fn.match(/\.neq\("sender_id", myId\)/g)).toHaveLength(2);
  });

  it("broadcasts delivered and read only when it actually changed rows", () => {
    expect(fn).toContain('emitRealtime("message:delivered"');
    expect(fn).toContain('emitRealtime("message:read"');
  });

  it("the legacy getMessages now delegates to the paged read", () => {
    const legacy = between(
      client,
      "export async function getMessages(",
      "export async function getCallHistory(",
    );
    expect(legacy).toContain("getMessagesPage(conversationId, { limit: 1000 })");
    expect(legacy).toContain("markThreadRead(conversationId)");
  });
});

describe("getLinkPreview vets every hop against the SSRF guard", () => {
  const src = read("../src/lib/link-preview.functions.ts");

  it("validates the host on each redirect, not just the first", () => {
    expect(src).toContain("checkSafeUrl(current)");
    expect(src).toMatch(/for \(let hop = 0; hop <= MAX_REDIRECTS; hop\+\+\)/);
  });

  it("follows redirects manually so each hop is re-checked", () => {
    expect(src).toContain('redirect: "manual"');
  });

  it("a rejected hop degrades to a plain link rather than an error card", () => {
    expect(src).toContain("if (err instanceof UnsafeUrlError) return { ok: false }");
    expect(src).toContain("if (!response || !response.ok) return { ok: false }");
  });

  it("only accepts HTML content and caps the body size", () => {
    expect(src).toContain("text\\/html");
    expect(src).toContain("readBounded(response, MAX_BYTES)");
  });
});

describe("the optimistic send path keys bubbles by the row UUID", () => {
  const client = read("../src/lib/api-client.ts");
  const send = between(client, "export async function sendMessage(", "export type ReactionMap =");

  it("writes the well-formed client id straight into messages.id", () => {
    expect(send).toContain("if (isUuid) insertRow.id = clientId;");
  });

  it("treats a primary-key collision as already-sent, not failed", () => {
    expect(send).toContain('error.code === "23505"');
  });
});
