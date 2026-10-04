// @vitest-environment node
/**
 * Four follow-ups to the messaging rework, pinned together because they share one
 * worry: a bubble must show the *thing*, not the plumbing behind it.
 *
 *  1. own storage paths (`/api/public/media/…`) must never read as a clickable
 *     path — the reader already renders them inline. `isOwnMediaUrl` is pure and
 *     exercised directly; the render/forward wiring is a source contract.
 *  2. forwarding offers only people you have actually messaged, not the whole
 *     directory.
 *  3. a finished call can be removed for yourself or deleted for everyone, which
 *     needs a real write path (RLS + an append RPC) and a realtime drop.
 *  4. the feed composer's emoji panel escapes the scrolling toolbar that used to
 *     clip it, and the app icons are served by a route handler so `www` shows the
 *     same tab mark as the apex.
 *
 * DB-bound, network-bound and render-bound pieces are read out of source where no
 * browser or socket exists to run them — matching how the rest of this suite
 * handles Supabase/fetch/JSX code a unit test cannot safely stand up.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isOwnMediaUrl, previewLabel, OWN_MEDIA_RE } from "@/lib/message-helpers";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const src = (rel: string) => read(`../src/${rel}`);

/** Text between two markers, so an assertion is about one function only. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `marker missing: ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `marker missing: ${to}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

/* --------------------------------------------------- 1. own media never leaks */

describe("isOwnMediaUrl recognises our own storage and nothing else", () => {
  it("matches the read proxy, the upload endpoint and the legacy path", () => {
    expect(isOwnMediaUrl("/api/public/media/messages/blob")).toBe(true);
    expect(isOwnMediaUrl("/api/uploads/clip.mp4")).toBe(true);
    expect(isOwnMediaUrl("/api/media/legacy.png")).toBe(true);
  });

  it("matches the same path with a scheme, since a caption can carry either", () => {
    expect(isOwnMediaUrl("https://spaces1.com/api/public/media/messages/blob")).toBe(true);
  });

  it("leaves genuine external links alone so they still get a preview", () => {
    expect(isOwnMediaUrl("https://example.com/blog/post")).toBe(false);
    expect(isOwnMediaUrl("https://cdn.third-party.dev/x.png")).toBe(false);
  });

  it("is not fooled by a substring that merely looks like a path", () => {
    expect(isOwnMediaUrl("https://example.com/not-our-api/media/x")).toBe(false);
    expect(isOwnMediaUrl("")).toBe(false);
    expect(isOwnMediaUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isOwnMediaUrl("just words /api/ nothing")).toBe(false);
  });

  it("the shared /g regex never carries lastIndex between calls", () => {
    // `isOwnMediaUrl` deliberately uses a scheme-free, non-global twin so a
    // re-render cannot mis-detect on a stale lastIndex.
    expect(OWN_MEDIA_RE.global).toBe(true);
    expect(isOwnMediaUrl("/api/public/media/a")).toBe(true);
    expect(isOwnMediaUrl("https://example.com/a")).toBe(false);
    expect(isOwnMediaUrl("/api/public/media/b")).toBe(true);
  });
});

describe("MessageText renders own media inline and previews only external links", () => {
  const text = src("components/messages/MessageText.tsx");

  it("splits the body so a media reference becomes an AttachmentBubble", () => {
    expect(text).toContain("function splitOwnMedia(");
    expect(text).toContain('segments.push({ kind: "media", value: match[0] })');
    expect(text).toContain("splitOwnMedia(body)");
    expect(text).toMatch(/segment\.kind === "media"/);
    expect(text).toContain("<AttachmentBubble");
  });

  it("withholds a preview card from our own storage paths", () => {
    // A `/api/...` link must not fire the SSRF-vetted preview fetch either.
    expect(text).toContain("extractUrls(body).find((url) => !isOwnMediaUrl(url))");
    expect(text).toContain("<LinkPreviewCard url={firstUrl}");
  });
});

describe("the forward sheet labels an attachment instead of printing its path", () => {
  const sheet = src("components/messages/ForwardSheet.tsx");

  it("runs the message body through previewLabel", () => {
    expect(sheet).toContain('import { previewLabel } from "@/lib/message-helpers"');
    expect(sheet).toContain("{previewLabel(message.body)}");
    // ...so the raw media path never reaches the row.
    expect(sheet).not.toMatch(/>\s*\{message\.body\}/);
  });

  it("previewLabel collapses a media path to a friendly label", () => {
    expect(previewLabel("/api/public/media/messages/blob")).toBe("📎 File Attachment");
    expect(previewLabel("https://cdn/photo.jpg")).toBe("📷 Photo");
    expect(previewLabel("See you at seven")).toBe("See you at seven");
  });
});

/* --------------------------------------------- 2. forward only known chats    */

describe("forwarding lists only people you already have a thread with", () => {
  const route = src("routes/messages.tsx");
  const forward = between(route, "const forwardTargets = useMemo(", "const isTyping");

  it("builds targets from conversations, not the candidate directory", () => {
    expect(forward).toContain("for (const c of conversations)");
    expect(forward).not.toContain("availableCandidates");
    expect(forward).toContain("p.id !== currentUserId");
  });

  it("still filters by the search box and sorts by display name", () => {
    expect(forward).toContain("forwardQuery.trim().toLowerCase()");
    expect(forward).toContain(".localeCompare(");
  });

  it("the New Message sheet keeps the full candidate pool", () => {
    // Only forwarding is restricted; starting a brand-new chat is not.
    expect(route).toContain("const availableCandidates = useMemo(");
    expect(route).toContain("availableCandidates.filter(");
  });
});

/* --------------------------------------------- 3. deleting / hiding a call    */

describe("a finished call has a real write path", () => {
  const api = src("lib/api-client.ts");

  it("hides via the append RPC, never by writing the array from the client", () => {
    const fn = between(
      api,
      "export async function hideCallForMe(",
      "export async function deleteCallForEveryone(",
    );
    expect(fn).toContain('db.rpc("hide_call_for_me", { p_call_id: callId })');
    expect(fn).toContain("if (!isDbId(meId) || !isDbId(callId)) return;");
    expect(fn).toContain("throw new Error(error.message)");
  });

  it("deletes the shared row through the delete policy", () => {
    const fn = between(
      api,
      "export async function deleteCallForEveryone(",
      "export async function getOrCreateConversation(",
    );
    expect(fn).toContain('.from("calls").delete().eq("id", callId)');
    expect(fn).toContain("if (!isDbId(meId) || !isDbId(callId)) return;");
  });

  it("the route removes the card optimistically and rolls back on failure", () => {
    const route = src("routes/messages.tsx");
    const hide = between(route, "const handleHideCall = ", "const handleDeleteCall = ");
    expect(hide).toContain("setCallCards((prev) => prev.filter((c) => c.id !== callId))");
    expect(hide).toContain("setCallCards(snapshot)");
    expect(hide).toContain("void hideCallForMe(callId)");
    const del = between(route, "const handleDeleteCall = ", "const isTyping");
    expect(del).toContain("void deleteCallForEveryone(callId)");
    expect(del).toContain("setCallCards((prev) => prev.filter((c) => c.id !== callId))");
    expect(del).toContain("setCallCards(snapshot)");
  });

  it("a peer's device drops the card when the row is deleted", () => {
    const feed = src("lib/realtime.ts");
    const del = between(
      feed,
      '{ event: "DELETE", schema: "public", table: "calls" }',
      ".subscribe();",
    );
    expect(del).toContain("const row = p.old;");
    expect(del).toContain('dispatchLocal("call:resolved"');
    expect(del).toContain("row.caller_id === currentUserId || row.callee_id === currentUserId");
  });

  it("the card offers both actions behind a single kebab menu", () => {
    const chip = src("components/social/CallCardChip.tsx");
    expect(chip).toContain("const showDelete = !!onHide || !!onDelete;");
    expect(chip).toContain('role="menu"');
    expect(chip).toContain("Remove for me");
    expect(chip).toContain("Delete for everyone");
  });
});

describe("the call hide/delete migration is safe and scoped", () => {
  const sql = read("../db/migrations/20261004000003_call_delete_hide.sql");

  it("wraps in a transaction and is idempotent", () => {
    expect(sql).toContain("begin;");
    expect(sql).toContain("commit;");
    expect(sql).toContain("add column if not exists hidden_for uuid[] not null default '{}'");
    expect(sql).toContain("create index if not exists calls_hidden_for_gin");
    expect(sql).toContain("drop policy if exists");
    expect(sql).toContain("create or replace function public.hide_call_for_me");
  });

  it("excludes a hidden row from the hider only, leaving the peer's history", () => {
    expect(sql).toMatch(
      /create policy "calls participant read"[\s\S]*?owns_profile\(caller_id\)[\s\S]*?owns_profile\(callee_id\)[\s\S]*?not \(hidden_for @> array\[auth\.uid\(\)\]\)/,
    );
  });

  it("lets either participant hard-delete, and nothing else", () => {
    expect(sql).toMatch(
      /create policy "calls participant delete" on public\.calls for delete to authenticated[\s\S]*?owns_profile\(caller_id\) or public\.owns_profile\(callee_id\)/,
    );
  });

  it("the RPC is SECURITY DEFINER and only appends auth.uid() for a member", () => {
    const fn = between(
      sql,
      "create or replace function public.hide_call_for_me",
      "-- ---------- 5. Grants",
    );
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public");
    expect(fn).toContain("array_append(hidden_for, auth.uid())");
    expect(fn).toContain("not (hidden_for @> array[auth.uid()])");
    expect(fn).toContain("(caller_id = auth.uid() or callee_id = auth.uid())");
    expect(sql).toContain(
      "grant execute on function public.hide_call_for_me(uuid) to authenticated;",
    );
  });
});

/* --------------------------------------------- 4. composer emoji + app icons  */

describe("the feed composer escapes the toolbar that used to clip the picker", () => {
  const composer = src("components/social/Composer.tsx");

  it("anchors the panel with position: fixed measured from the button", () => {
    expect(composer).toContain("const emojiAnchorRef = useRef<HTMLDivElement>(null);");
    expect(composer).toContain("const rect = el.getBoundingClientRect();");
    expect(composer).toContain('setEmojiStyle({ position: "fixed"');
    expect(composer).toContain("ref={emojiAnchorRef}");
    expect(composer).toContain("style={emojiStyle ?? undefined}");
  });

  it("re-measures as the page moves so the panel never detaches", () => {
    expect(composer).toContain('window.addEventListener("resize", place)');
    expect(composer).toContain('window.addEventListener("scroll", place, true)');
    expect(composer).toContain('window.removeEventListener("resize", place)');
  });

  it("the picker honours an override style on its panel", () => {
    const picker = src("components/social/EmojiPicker.tsx");
    expect(picker).toContain("style?: CSSProperties;");
    expect(picker).toMatch(/<div[\s\S]*?style=\{style\}/);
  });
});

describe("app icons are served by a route handler, not only static hosting", () => {
  const lib = src("lib/app-icons.server.ts");

  it("serves only a whitelist, never a caller-supplied path", () => {
    for (const name of [
      "favicon.ico",
      "favicon.svg",
      "favicon-16x16.png",
      "favicon-32x32.png",
      "favicon-48x48.png",
      "favicon-256x256.png",
      "icon-192.png",
      "icon-512.png",
      "apple-touch-icon.png",
      "manifest.webmanifest",
    ]) {
      expect(lib).toContain(`"${name}":`);
    }
    expect(lib).toContain("const contentType = ICON_ASSETS[name];");
    expect(lib).toContain('if (!contentType) return new Response("Not found", { status: 404 });');
  });

  it("caches hard and fails closed to 404", () => {
    expect(lib).toContain('"cache-control": "public, max-age=31536000, immutable"');
    expect(lib).toContain('"cross-origin-resource-policy": "cross-origin"');
    expect(lib).toMatch(/return new Response\("Not found", \{ status: 404 \}\);\s*\}/);
  });

  it("each icon route dynamically imports the server module in its GET handler", () => {
    for (const [file, asset] of [
      ["routes/favicon[.]ico.ts", "favicon.ico"],
      ["routes/favicon[.]svg.ts", "favicon.svg"],
      ["routes/favicon-16x16[.]png.ts", "favicon-16x16.png"],
      ["routes/favicon-32x32[.]png.ts", "favicon-32x32.png"],
      ["routes/favicon-48x48[.]png.ts", "favicon-48x48.png"],
      ["routes/favicon-256x256[.]png.ts", "favicon-256x256.png"],
      ["routes/icon-192[.]png.ts", "icon-192.png"],
      ["routes/icon-512[.]png.ts", "icon-512.png"],
      ["routes/apple-touch-icon[.]png.ts", "apple-touch-icon.png"],
      ["routes/manifest[.]webmanifest.ts", "manifest.webmanifest"],
    ] as const) {
      const route = src(file);
      expect(route, file).toContain('await import("@/lib/app-icons.server")');
      expect(route, file).toContain(`serveIconAsset("${asset}")`);
    }
  });
});
