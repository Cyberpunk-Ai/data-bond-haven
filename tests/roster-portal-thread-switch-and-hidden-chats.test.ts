// @vitest-environment node
/**
 * Three live defects the user reported, pinned in the house source-contract style.
 *
 *   1. Profile followers/following opened as "just a transparent blurred
 *      background": the roster is a full-screen `fixed inset-0` overlay, but it was
 *      mounted inline inside #app-main (an `lg:overflow-y-auto` scroller) wrapped by
 *      the animated `.route-enter` (which sets `transform`). A transform ancestor
 *      becomes the containing block for a fixed descendant and the scroller clips it,
 *      so only the frosted backdrop painted and the card was lost. Fix: portal it to
 *      <body>, exactly like the image lightbox and the post action menu.
 *
 *   2. Switching between people in Messages "flashed irrelevant messages": the open
 *      thread only replaced the previous person's messages once the new page RESOLVED
 *      (the `c_` placeholder branch cleared, the real-thread branch did not), and the
 *      prior relationship's call cards lingered until their own async re-read landed.
 *      Fix: clear messages + call cards synchronously on the switch, and show a calm
 *      skeleton while the first page is in flight.
 *
 *   3. Hidden chats still counted toward the Messages badge: hiding a thread never
 *      dropped its share from the per-conversation map, and getConversations'
 *      schema-cache fallback read returned hidden rows whose messages are not
 *      individually tombstoned (only "delete for me" tombstones a message; "hide
 *      chat" hides the conversation). Fix: zero the badge on hide AND filter
 *      `hidden_for` off the list regardless of which read served it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const between = (src: string, from: string, to: string) =>
  src.slice(src.indexOf(from), src.indexOf(to));

describe("the profile roster is a portalled overlay, not a clipped inline one", () => {
  const modal = read("src", "components", "social", "ProfileNetworkModal.tsx");

  it("renders through a portal to document.body", () => {
    expect(modal).toContain('import { createPortal } from "react-dom";');
    expect(modal).toContain("return createPortal(");
    expect(modal).toContain("document.body,");
    // Still the same full-screen fixed overlay (the portal is what fixes it).
    expect(modal).toContain("fixed inset-0 z-[100]");
  });

  it("guards SSR and freezes the page behind while open", () => {
    expect(modal).toContain('if (typeof document === "undefined") return null;');
    expect(modal).toContain('document.body.style.overflow = "hidden";');
  });
});

describe("switching threads never leaves the previous person on screen", () => {
  const thread = read("src", "hooks", "use-messages", "useThread.ts");
  const route = read("src", "routes", "messages.tsx");
  const pane = read("src", "components", "messages", "MessageThread.tsx");

  it("useThread exposes a loading flag for the fresh page", () => {
    expect(thread).toContain("const [loading, setLoading] = useState(false);");
    expect(thread).toMatch(/loadingOlder,\s*loading,/);
  });

  it("clears the old messages synchronously before fetching the new thread", () => {
    // The real-thread path (not just the `c_` placeholder) must blank the list so
    // the prior conversation can't linger while this one loads.
    const swap = between(thread, "mountedFor.current = conversationId;", "void getMessagesPage");
    expect(swap).toContain("setMessages([]);");
    expect(swap).toContain("setLoading(true);");
  });

  it("the pane shows a calm skeleton while loading an empty thread", () => {
    expect(pane).toContain("loading: boolean;");
    expect(pane).toContain("loading && timeline.length === 0");
  });

  it("wipes the prior relationship's call cards the instant the partner changes", () => {
    expect(route).toMatch(/useEffect\(\(\) => \{\s*setCallCards\(\[\]\);\s*\}, \[partnerId\]\);/);
    // And hands the loading flag to the thread pane.
    expect(route).toContain("loading={thread.loading}");
  });
});

describe("a hidden chat never counts", () => {
  const route = read("src", "routes", "messages.tsx");
  const api = read("src", "lib", "api-client.ts");

  it("dropping its badge share the moment you hide it", () => {
    const hide = between(route, "const handleHideConversation = ", "void hideConversationForMe");
    expect(hide).toContain("setConversationUnread(conversationId, 0);");
  });

  it("getConversations filters hidden threads regardless of which read served it", () => {
    // The schema-cache fallback (buildConv(false)) returns hidden rows too, so the
    // list — and the unread ids derived from it — must drop them in code.
    const conv = between(api, "export async function getConversations(", "const participantId");
    expect(conv).toContain("!Array.isArray(r.hidden_for)");
    expect(conv).toContain("r.hidden_for.includes(userId)");
  });
});
