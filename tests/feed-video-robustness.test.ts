// @vitest-environment node
/**
 * Feed videos must "play well and never break." Two invariants guard that,
 * end to end, so a silent drift can't turn a real video into a broken image:
 *
 *  1. DETECTION — a post's video is chosen purely by `isVideoUrl` reading the
 *     extension the uploader stamped into the `/api/public/media/<key>` path.
 *     The allowlist (what content types are video), the extension map (what the
 *     key gets named with) and `isVideoUrl` (what the card trusts) MUST agree,
 *     or a video renders as an <img> and shows nothing.
 *  2. PLAYBACK / SERVING — the read proxy serves those types inline and honours
 *     byte ranges (206) so seeking + progressive playback work; and when a load
 *     still fails, the player must degrade to a clean fallback rather than leave
 *     a stuck spinner and dead controls covering the frame.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isVideoUrl } from "@/lib/utils";
import { ALLOWED_CONTENT_TYPES } from "@/lib/storage/provider.server";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("feed videos are always detected, never mis-rendered as images", () => {
  it("every allowed VIDEO content type maps to an extension isVideoUrl recognises", () => {
    const route = read("../src/routes/api/uploads/index.ts");
    const extMap = route.slice(
      route.indexOf("EXTENSION_BY_CONTENT_TYPE"),
      route.indexOf("function json("),
    );

    const videoTypes = Object.keys(ALLOWED_CONTENT_TYPES).filter(
      (t) => ALLOWED_CONTENT_TYPES[t as keyof typeof ALLOWED_CONTENT_TYPES] === "video",
    );
    expect(videoTypes.length).toBeGreaterThan(0);

    for (const type of videoTypes) {
      const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = extMap.match(new RegExp(`"${escaped}":\\s*"([a-z0-9]+)"`));
      expect(
        m,
        `no EXTENSION_BY_CONTENT_TYPE entry for ${type} — it would be stored as .bin`,
      ).toBeTruthy();
      const ext = m![1];
      // The exact path shape the uploader writes; the card must call it a video.
      expect(
        isVideoUrl(`/api/public/media/posts/uuid/1700000000000-abc.${ext}`),
        `${type} -> .${ext} is NOT detected as a video (would render as a broken image)`,
      ).toBe(true);
    }
  });

  it("the media proxy serves video types inline and honours byte ranges", () => {
    const proxy = read("../src/routes/api/public/media/$.ts");
    // Inline-safe allowlist must include each type we accept as video, or the
    // player would be handed an `attachment` download instead of a stream.
    for (const type of Object.keys(ALLOWED_CONTENT_TYPES).filter(
      (t) => ALLOWED_CONTENT_TYPES[t as keyof typeof ALLOWED_CONTENT_TYPES] === "video",
    )) {
      expect(proxy, `proxy must serve ${type} inline`).toContain(`"${type}"`);
    }
    // Seeking + progressive load require 206 partial responses and range support.
    expect(proxy).toMatch(/status:\s*206/);
    expect(proxy).toMatch(/"Accept-Ranges":\s*"bytes"/);
    expect(proxy).toMatch(/416/); // clamps an over-read seek instead of retrying forever
  });
});

describe("a feed video that fails to load degrades cleanly", () => {
  const player = read("../src/components/social/ModernVideoPlayer.tsx");

  it("resets loading and hides every overlay on error (no stuck spinner)", () => {
    // onError must both flag the error AND clear the loader, since a failed
    // load never fires onCanPlay/onPlaying to clear it.
    expect(player).toMatch(/setHasError\(true\);\s*setIsLoading\(false\);/);
    // Every floating overlay is gated so it can't sit over the fallback frame.
    expect(player).toMatch(/\{isLoading && !hasError &&/);
    expect(player).toMatch(/\{playFeedback && !hasError &&/);
    expect(player).toMatch(/\{!isPlaying && !isLoading && !hasError &&/);
    expect(player).toMatch(/hasError && "hidden"/);
    // And there is a real, non-empty fallback state rather than a blank box.
    expect(player).toMatch(/Video unavailable/);
  });

  it("preloads metadata so the first frame and duration resolve promptly", () => {
    expect(player).toMatch(/preload="metadata"/);
    // Autoplay in-feed must be muted, or browsers block it and it looks broken.
    expect(player).toMatch(/muted=\{isMuted\}/);
    expect(player).toMatch(/playsInline/);
  });
});
