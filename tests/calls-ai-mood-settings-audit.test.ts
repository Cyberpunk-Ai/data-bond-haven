// @vitest-environment node
/**
 * Audit contracts for the call lifecycle, AI Sparks, the story mood field,
 * and the settings page:
 *  - an answered callee keeps its status watcher armed, so the caller hanging
 *    up closes the callee's modal instead of being swallowed as a self-echo;
 *  - AI chat demands machine-readable JSON and the quota guard tells the
 *    operator when the *service key* is what failed;
 *  - story mood is free-typed, optional, and absent means no mood chip;
 *  - settings never renders a switch for behaviour the product doesn't have:
 *    unenforced toggles are inert "Soon" placeholders, and the one privacy
 *    switch that can be honoured (hide activity) is wired to presence.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const between = (src: string, start: string, end: string) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  expect(a, `missing marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing marker: ${end}`).toBeGreaterThanOrEqual(0);
  return src.slice(a, b);
};

describe("callee keeps the terminal-event feed armed", () => {
  const src = read("../src/components/calls/IncomingCallProvider.tsx");
  const accept = between(
    src,
    "async function acceptIncomingCall",
    "async function declineIncomingCall",
  );

  it("does not poison handledRef after a successful answer", () => {
    // The answered path must reach setActiveCall without a handledRef.add —
    // a leftover entry gets consumed by watchCall's self-echo guard and the
    // callee then never sees the caller's "ended".
    const answeredPath = between(
      accept,
      'toast.info("This call is no longer available.");',
      "setActiveCall({ user: caller",
    );
    expect(answeredPath).not.toContain("handledRef.current.add(callId)");
  });

  it("still suppresses the echo for the call that was NOT answered", () => {
    expect(accept).toMatch(/if \(!answered\) \{\s*\n\s*handledRef\.current\.add\(callId\);/);
  });

  it("keeps the self-write guards it needs (hang-up, decline, timeout, cancel)", () => {
    const adds = src.match(/handledRef\.current\.add\(/g) ?? [];
    // !answered + startCall timeout + CallModal onClose + decline + ring timeout
    expect(adds.length).toBe(5);
    expect(src).toContain("if (handledRef.current.delete(callId)) return;");
  });
});

describe("AI answers are machine-readable and failures are honest", () => {
  const src = read("../src/lib/ai.functions.ts");

  it("requests OpenAI-compatible JSON output mode on every chat call", () => {
    expect(src).toContain('response_format: { type: "json_object" }');
  });

  it("surfaces a rejected service key as a key problem, not a missing profile", () => {
    expect(src).toMatch(/if \(profileError\)\s*\{[\s\S]*?SUPABASE_SERVICE_ROLE_KEY/);
    expect(src).toMatch(/if \(subError\) \{[\s\S]*?SUPABASE_SERVICE_ROLE_KEY/);
    // ...and the plain "no such profile" answer still exists for the real case.
    expect(src).toContain('throw new Error("Profile not found")');
  });

  it("story captions stay within the 90-char story budget", () => {
    const story = between(src, "export const aiStoryCaption", "export const aiSummarizeSpace");
    expect(story).toContain("parsed.text?.slice(0, 90)");
    expect(story).toContain("mood is a single emoji followed by up to two capitalized words");
  });
});

describe("story mood is typeable and optional", () => {
  const src = read("../src/components/social/StoryCreatorModal.tsx");

  it("starts empty — no default mood is invented", () => {
    expect(src).toContain('const [mood, setMood] = useState("");');
    expect(src).not.toContain('useState("✨ Inspired")');
  });

  it("is a free-text input with suggestions, not a closed select", () => {
    expect(src).toContain("MOOD_SUGGESTIONS");
    const moodBlock = between(src, "Mood", "Stickers Selector");
    expect(moodBlock).not.toContain("<select");
    expect(moodBlock).toContain('type="text"');
    expect(moodBlock).toContain("maxLength={40}");
    expect(moodBlock).toContain('aria-label="Clear mood"');
  });

  it("an unset mood is sent as absent and both renderers hide it", () => {
    expect(src).toContain("mood: mood.trim() || undefined");
    const viewer = read("../src/components/social/StoryModal.tsx");
    expect(viewer).toContain("{currentStory.mood && (");
    expect(src).toContain("{mood && (");
  });

  it("an AI-generated mood lands in the same free-text field", () => {
    expect(src).toContain("if (res.mood) setMood(res.mood);");
  });
});

describe("settings only switches what the product actually does", () => {
  const src = read("../src/routes/settings.tsx");

  it("unenforced toggles are inert Soon placeholders", () => {
    // Only the rows nothing behind them can honour are listed here. "Filter
    // sensitive content" and "Allow message requests" moved out of this
    // quarantine when they got real enforcement (reader-side blur, and a
    // trigger that refuses a closed thread), and "Two-factor authentication"
    // left the screen entirely rather than stay a fake switch.
    for (const label of ["Private account", "Email digest", "Login alerts"]) {
      const block = between(src, `"${label}"`, "/>");
      expect(block, label).toContain("disabled");
      expect(block, label).toContain("soon");
    }
    for (const label of ["Filter sensitive content", "Allow message requests"]) {
      const block = between(src, `"${label}"`, "/>");
      expect(block, label).not.toContain("disabled");
      expect(block, label).toMatch(/onChange=\{set[A-Za-z]+\}/);
    }
    expect(src.toLowerCase()).not.toContain("two-factor");
    // No leftover fake-default switches: `defaultOn` only exists in the Toggle
    // definition itself (prop default, type, and useState), never at a call site.
    const uses = src.match(/defaultOn\s*\n/g) ?? [];
    expect(uses.length).toBe(0);
    expect(src).not.toContain("privAccount");
    expect(src).not.toContain("setNotifyDigest");
  });

  it("hide-activity is wired to the presence publisher, not just stored", () => {
    expect(src).toContain('import { setPresenceHidden } from "@/lib/presence";');
    expect(src).toMatch(
      /const toggleHideActivity = \(next: boolean\) => \{\s*\n\s*setHideActivity\(next\);\s*\n\s*setPresenceHidden\(next\);/,
    );
    const privacyBlock = between(src, '"Hide activity status"', "/>");
    expect(privacyBlock).toContain("onChange={toggleHideActivity}");

    const presence = read("../src/lib/presence.ts");
    expect(presence).toContain('getPreferences().toggles["hide_activity"]');
    expect(presence).toMatch(/status === "SUBSCRIBED" && !presenceHidden\(\)/);
    expect(presence).toContain("export function setPresenceHidden");
    expect(presence).toContain("void channel.untrack();");
  });

  it("sign-out really clears the Supabase session", () => {
    const auth = read("../src/lib/auth-state.ts");
    expect(auth).toMatch(
      /export function setLoggedOut\(\) \{\s*\n\s*void supabase\.auth\.signOut\(\)/,
    );
  });
});
