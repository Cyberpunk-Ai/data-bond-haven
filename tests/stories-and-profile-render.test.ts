import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isVideoStorySrc,
  storyLayer,
  storyMediaList,
  storyPaintsImmediately,
  storyPreloadIndices,
  storyProgressStep,
  storyShouldHoldClock,
  TEXT_LAYER,
} from "@/lib/story-viewer";
import {
  cacheProfiles,
  findProfile,
  getProfile,
  GUEST_PROFILE,
  isProfilePending,
  rowToProfile,
} from "@/lib/profile-service";
import type { Profile } from "@/lib/types";

/**
 * Two ways a screen used to lie while it was still loading, both reported by
 * hand and both fixed here:
 *
 *  - Stories blinked. Story media lives in the private bucket, so a frame needs
 *    a signed URL *and* a decode before it can be painted. The old viewer asked
 *    for both only when the frame came on screen, and painted it as a CSS
 *    `background-image` — which gives no load event to wait on — so the reader
 *    got a dark panel, then a photo arriving halfway through the six seconds.
 *  - Profiles flashed "Guest" or a raw UUID on reload. The cache stand-in for a
 *    missing row was built *out of the id*, so the name on screen was a
 *    fabrication that the real row replaced a moment later.
 *
 * The fixes are the same shape: never invent an answer, and never advance the
 * clock on a frame that cannot paint yet.
 */

function profile(over: Partial<Profile>): Profile {
  return {
    id: "p-1",
    username: "ada",
    display_name: "Ada Lovelace",
    bio: "",
    avatar_url: null,
    location: "",
    website: "",
    followers: 0,
    following: 0,
    verified: false,
    plan: "free",
    role: "user",
    status: "active",
    warning_count: 0,
    ...over,
  } as Profile;
}

describe("a story knows what it needs before it is shown", () => {
  it("splits, trims and de-duplicates the attachments of one row", () => {
    // `media_url` has always accepted several comma-joined objects; every
    // consumer has to agree on what the list is or the preload queue drifts
    // away from the frame that actually paints.
    expect(storyMediaList({ id: "s", media_url: "a.jpg, b.mp4 ,a.jpg,," })).toEqual([
      "a.jpg",
      "b.mp4",
    ]);
    expect(storyMediaList({ id: "s", media_url: null })).toEqual([]);
    expect(storyMediaList(undefined)).toEqual([]);
  });

  it("chooses the layer by the file, with the row's type as the fallback", () => {
    expect(storyLayer({ id: "s", media_url: "clip.mp4" })).toEqual({
      kind: "video",
      src: "clip.mp4",
    });
    // A signed URL carries a query string; the extension is still the truth.
    expect(isVideoStorySrc("clip.mov?token=abc")).toBe(true);
    expect(isVideoStorySrc("photo.jpg#v2")).toBe(false);
    // Objects without a usable extension (storage paths) fall back to `type`.
    expect(isVideoStorySrc("media/4f8c2a", "video")).toBe(true);
    expect(isVideoStorySrc("media/4f8c2a", "image")).toBe(false);
    expect(storyLayer({ id: "s", media_url: "photo.jpg", type: "image" })).toEqual({
      kind: "image",
      src: "photo.jpg",
    });
  });

  it("says a text panel is paintable and a photo never is until it decodes", () => {
    expect(storyPaintsImmediately({ id: "s", text: "morning", gradient: "sunrise" })).toBe(true);
    expect(storyLayer({ id: "s", text: "hi" })).toEqual(TEXT_LAYER);
    expect(storyPaintsImmediately({ id: "s", media_url: "photo.jpg" })).toBe(false);
  });

  it("warms the frames ahead and the one behind, and never itself", () => {
    expect(storyPreloadIndices(6, 2)).toEqual([1, 3, 4]);
    expect(storyPreloadIndices(6, 0)).toEqual([1, 2]);
    expect(storyPreloadIndices(3, 2)).toEqual([1]);
    expect(storyPreloadIndices(1, 0)).toEqual([]);
    expect(storyPreloadIndices(0, 0)).toEqual([]);
    // Clamped to the queue rather than wrapping: a carousel that preloaded the
    // first story while you read the last would fight the reader for bandwidth.
    expect(storyPreloadIndices(4, 3, 5)).toEqual([2]);
  });

  it("holds the clock only while there is something to wait for", () => {
    const image = storyLayer({ id: "s", media_url: "photo.jpg" });
    // Still minting the signed URL.
    expect(storyShouldHoldClock({ layer: image, hasUrl: false, decoded: false, waitedMs: 0 })).toBe(
      true,
    );
    // Minted, not decoded yet — the blink this prevents.
    expect(
      storyShouldHoldClock({ layer: image, hasUrl: true, decoded: false, waitedMs: 100 }),
    ).toBe(true);
    expect(storyShouldHoldClock({ layer: image, hasUrl: true, decoded: true, waitedMs: 100 })).toBe(
      false,
    );
    expect(
      storyShouldHoldClock({ layer: TEXT_LAYER, hasUrl: false, decoded: false, waitedMs: 0 }),
    ).toBe(false);
    // Patience: a dead object or a captive network must not freeze the carousel.
    expect(
      storyShouldHoldClock({ layer: image, hasUrl: false, decoded: false, waitedMs: 4000 }),
    ).toBe(false);
    expect(
      storyShouldHoldClock({
        layer: image,
        hasUrl: false,
        decoded: false,
        waitedMs: 500,
        patienceMs: 400,
      }),
    ).toBe(false);
  });

  it("moves the progress bar at the story's own rate, and never backwards", () => {
    expect(storyProgressStep(100, 6600)).toBeCloseTo((100 / 6600) * 100, 6);
    expect(storyProgressStep(100, 100)).toBe(100);
    // A nonsense duration ends the frame rather than dividing by zero.
    expect(storyProgressStep(0, 6600)).toBe(100);
    expect(storyProgressStep(100, 0)).toBe(100);
    expect(storyProgressStep(100, -1)).toBe(100);
  });
});

describe("an unknown profile is an id, not a name", () => {
  // Node has no `document`, which is exactly the server-render case: `findProfile`
  // must hand back null without opening a request for a render that cannot repaint.
  it("refuses to invent a display name out of the id", () => {
    const uuid = "0f1e2d3c-4b5a-4978-8675-645342210f0e";
    const pending = getProfile(uuid);
    expect(pending.id).toBe(uuid);
    expect(pending.display_name).toBe("");
    expect(pending.username).toBe("");
    expect(pending.display_name).not.toContain(uuid.slice(0, 8));
    expect(pending.display_name).not.toBe(GUEST_PROFILE.display_name);
    expect(isProfilePending(pending)).toBe(true);
  });

  it("keeps the identity usable while the name is missing", () => {
    // Keys, links and follow checks all read `id`; only the two printable
    // fields are withheld — which is why the row is a profile and not a null.
    const pending = getProfile("someone-42");
    expect(pending.id).toBe("someone-42");
    expect(pending.status).toBe("active");
    expect(findProfile("someone-42")).toBeNull();
  });

  it("treats the signed-out placeholder as settled, not as pending", () => {
    // "Guest" is the honest label for nobody being signed in; making it look
    // like a row still loading would shimmer forever.
    expect(isProfilePending(GUEST_PROFILE)).toBe(false);
    expect(getProfile(undefined)).toBe(GUEST_PROFILE);
    expect(getProfile("guest")).toBe(GUEST_PROFILE);
    expect(findProfile("guest")).toBeNull();
    expect(findProfile(null)).toBeNull();
    expect(isProfilePending(null)).toBe(true);
    expect(isProfilePending(undefined)).toBe(true);
  });

  it("resolves the moment the row is cached, under id and username alike", () => {
    const ada = profile({ id: "ada-id", username: "ada", display_name: "Ada Lovelace" });
    cacheProfiles([ada]);
    expect(getProfile("ada-id")).toBe(ada);
    expect(getProfile("ada")).toBe(ada);
    expect(isProfilePending(getProfile("ada-id"))).toBe(false);
    // A name that has no name in it is still pending, however it got cached.
    expect(isProfilePending(profile({ id: "x-1", username: "", display_name: "  " }))).toBe(true);
  });

  it("maps a database row defensively, because rows are not always complete", () => {
    const row = rowToProfile({ id: "r1", username: "grace", display_name: null });
    expect(row.display_name).toBe("grace"); // falls back to the handle, not to "Guest"
    expect(rowToProfile({}).display_name).toBe("Unknown");
    expect(rowToProfile({ id: "r2" }).plan).toBe("free");
    expect(rowToProfile({ id: "r2" }).followers).toBe(0);
  });
});

describe("the viewer and the screens keep the promise those rules make", () => {
  // Source-level: painting, decoding and a tab regaining focus cannot be
  // observed outside a browser.
  const modal = readFileSync("src/components/social/StoryModal.tsx", "utf8");
  const feed = readFileSync("src/routes/feed.tsx", "utf8");
  const profileRoute = readFileSync("src/routes/profile.tsx", "utf8");
  const room = readFileSync("src/components/social/SpaceRoomModal.tsx", "utf8");

  it("paints a story in an element that reports back", () => {
    // The old `style={{ backgroundImage }}` gave no load event to hold the
    // clock on, which is why the timer ran out over an empty panel.
    expect(modal).not.toContain("backgroundImage");
    expect(modal).toMatch(/<img[\s\S]{0,400}onLoad=\{\(\) => markSettled\(currentId\)\}/);
    expect(modal).toMatch(/<video[\s\S]{0,400}onCanPlay=\{\(\) => markSettled\(currentId\)\}/);
    // A clip's sound belongs to the reader, not to whoever opened the room.
    expect(modal).toContain("muted={!storySound}");
    // Minted and decoded, not fetched on arrival: the neighbours are warmed.
    expect(modal).toContain("storyPreloadIndices");
    expect(modal).toContain("authorizedMediaUrl");
  });

  it("stops the overlay sitting under its own media", () => {
    // With the picture now a real layer, everything drawn above it needs a
    // stacking context — otherwise the caption and the reply box hide behind it.
    expect(modal.match(/relative z-10/g)?.length).toBeGreaterThanOrEqual(3);
    expect(modal).toContain("holdClock");
    expect(modal).toMatch(/if \(!isOpen[\s\S]{0,160}holdClock\) return;/);
  });

  it("shimmers a waiting name instead of printing a stand-in", () => {
    // The rail labels story rings by author, so a cold cache must not read as
    // "Guest" beside six identical circles.
    expect(feed).toContain("useProfiles(storyUserIds)");
    expect(feed).toMatch(/isProfilePending\(user\)[\s\S]{0,240}animate-pulse/);
    expect(profileRoute).toContain("isProfilePending(userProfile)");
    expect(profileRoute).toMatch(/headerPending[\s\S]{0,320}animate-pulse/);
    expect(room).toContain("isProfilePending(getProfile(p.id))");
    expect(room).toContain("fetchProfile(p.id)");
  });

  it("asks the network again when it is asked for a fresh number", () => {
    // `fetchProfile` answers from the cache first, so the counts-refresh effect
    // has to go through the read that does not — deleting this import once made
    // the follower counts silently stop refreshing.
    expect(profileRoute).toMatch(/import \{[^}]*getUserProfile[^}]*\} from "@\/lib\/api-client"/);
    expect(profileRoute).toContain("getUserProfile(id)");
  });
});
