// @vitest-environment node
/**
 * Call polish: what the interface promises, what the wire actually does, and what
 * a chat thread is allowed to say about a call.
 *
 * Three groups, in order of how much they can be trusted to stay true:
 *  1. the rules themselves (`call-cards.ts`, the layout and bandwidth predicates
 *     in `call-media.ts`) — pure, so they are exercised directly;
 *  2. the wiring those rules depend on, read out of the source where no browser
 *     exists to run it (the self-tile gate, DTLS evidence, audio bitrate floor);
 *  3. the security and story-visibility guarantees, which live in SQL and in the
 *     media authoriser and are the parts a UI test could never falsify.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  AUDIO_MAX_BITRATE,
  VIDEO_PROFILES,
  adaptiveVideoProfile,
  callCarriesVideo,
  formatCallDuration,
  isLiveDevice,
  remotePaneContent,
  remotePaneFramed,
  selfTileVisible,
  videoEncodeHint,
} from "@/lib/call-media";
import {
  buildThreadTimeline,
  callCardFromRow,
  callCardIsWarning,
  callCardStatusText,
  callCardsFromRows,
  type CallCard,
  type CallRowLike,
} from "@/lib/call-cards";
import type { Message } from "@/lib/types";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const between = (src: string, start: string, end: string) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  expect(a, `missing marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing marker: ${end}`).toBeGreaterThanOrEqual(0);
  return src.slice(a, b);
};

const ME = "p_me";
const THEM = "p_them";

function row(over: Partial<CallRowLike> = {}): CallRowLike {
  return {
    id: "call_1",
    caller_id: ME,
    callee_id: THEM,
    kind: "audio",
    status: "ended",
    started_at: "2026-10-02T10:00:00.000Z",
    answered_at: "2026-10-02T10:00:05.000Z",
    ended_at: "2026-10-02T10:00:46.000Z",
    duration_seconds: 41,
    ...over,
  };
}

function msg(id: string, sender: string, created_at: string): Message {
  return { id, sender_id: sender, body: `m${id}`, created_at } as Message;
}

function card(over: Partial<CallCard> = {}): CallCard {
  return {
    id: "c1",
    kind: "audio",
    outcome: "connected",
    direction: "outgoing",
    at: "2026-10-02T10:00:00.000Z",
    durationSeconds: 41,
    answered: true,
    ...over,
  };
}

/* ------------------------------------------------------------------ 1. cards */

describe("a call card only says what the row proves", () => {
  it("shows real talk time for a call that was answered", () => {
    const made = callCardFromRow(row(), ME);
    expect(made).toMatchObject({ outcome: "connected", answered: true, durationSeconds: 41 });
    expect(callCardStatusText(made!, formatCallDuration(made!.durationSeconds))).toBe("0:41");
    expect(callCardIsWarning(made!)).toBe(false);
  });

  it("never prints a duration for a call nobody picked up", () => {
    // `duration_seconds` is written by whoever ended the call, so an unanswered
    // ring can carry a number. "Missed call · 0:41" implies somebody answered.
    const missed = callCardFromRow(
      row({ status: "missed", answered_at: null, duration_seconds: 41 }),
      THEM,
    )!;
    expect(missed.durationSeconds).toBe(0);
    expect(missed.answered).toBe(false);
    expect(callCardStatusText(missed, "0:00")).toBe("Missed call");
    expect(callCardIsWarning(missed)).toBe(true);
  });

  it("reads the same row differently from each end of the call", () => {
    const callee = callCardFromRow(row({ status: "missed", answered_at: null }), THEM)!;
    const caller = callCardFromRow(row({ status: "missed", answered_at: null }), ME)!;
    expect(callee.outcome).toBe("missed");
    expect(callee.direction).toBe("incoming");
    expect(caller.outcome).toBe("unanswered");
    expect(caller.direction).toBe("outgoing");
    expect(callCardStatusText(caller, "")).toBe("No answer");
  });

  it("distinguishes a decline from a hang-up, and blames the right person", () => {
    const declined = callCardFromRow(
      row({ status: "declined", answered_at: null, duration_seconds: 0 }),
      ME,
    )!;
    expect(declined.outcome).toBe("declined");
    expect(callCardStatusText(declined, "")).toBe("Declined");
    // The callee's own thread says who declined it.
    expect(
      callCardStatusText(
        callCardFromRow(row({ status: "declined", answered_at: null }), THEM)!,
        "",
      ),
    ).toBe("You declined");

    const canceled = callCardFromRow(
      row({ status: "ended", answered_at: null, duration_seconds: 0 }),
      ME,
    )!;
    expect(canceled.outcome).toBe("canceled");
    expect(callCardStatusText(canceled, "")).toBe("Canceled");
  });

  it("keeps a call that is still ringing out of the history", () => {
    for (const status of ["ringing", "active"]) {
      expect(callCardFromRow(row({ status }), ME)).toBeNull();
    }
    expect(callCardFromRow(row({ id: "" }), ME)).toBeNull();
    expect(callCardFromRow(row({ started_at: "" }), ME)).toBeNull();
  });

  it("treats any non-video kind as a voice call, so no card wears the wrong icon", () => {
    expect(callCardFromRow(row({ kind: "voice" }), ME)!.kind).toBe("audio");
    expect(callCardFromRow(row({ kind: "audio" }), ME)!.kind).toBe("audio");
    expect(callCardFromRow(row({ kind: "video" }), ME)!.kind).toBe("video");
  });

  it("sorts a retry's duplicate rows into one honest, ordered log", () => {
    const cards = callCardsFromRows(
      [
        row({ id: "b", started_at: "2026-10-02T11:00:00.000Z" }),
        row({ id: "a", started_at: "2026-10-02T10:00:00.000Z" }),
        row({ id: "a", started_at: "2026-10-02T10:00:00.000Z" }),
        row({ id: "ringing", status: "ringing" }),
      ],
      ME,
    );
    expect(cards.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("refuses to invent a card out of garbage", () => {
    expect(callCardsFromRows(null as unknown as CallRowLike[], ME)).toEqual([]);
    expect(callCardFromRow(row({ duration_seconds: -5 }), ME)!.durationSeconds).toBe(0);
    expect(callCardFromRow(row({ duration_seconds: NaN }), ME)!.durationSeconds).toBe(0);
  });
});

/* ----------------------------------------------------------- 2. the timeline */

describe("the thread interleaves calls without rewriting itself", () => {
  const earlier = msg("m1", THEM, "2026-10-01T09:00:00.000Z");
  const before = msg("m2", ME, "2026-10-02T10:00:00.000Z");
  const after = msg("m3", ME, "2026-10-02T10:05:00.000Z");
  const call = card({ at: "2026-10-02T10:02:00.000Z" });

  it("puts the card where the call actually happened", () => {
    const entries = buildThreadTimeline([earlier, after, before], [call]);
    expect(entries.map((e) => e.key)).toEqual(["m:m1", "m:m2", "c:c1", "m:m3"]);
    expect(entries.map((e) => e.type)).toEqual(["message", "message", "call", "message"]);
  });

  it("does not split one person's run of messages around a call", () => {
    const entries = buildThreadTimeline([before, after], [call]);
    const messages = entries.filter((e) => e.type === "message");
    expect(messages[0].startsGroup).toBe(true);
    expect(messages[0].endsGroup).toBe(false);
    expect(messages[1].startsGroup).toBe(false);
    expect(messages[1].endsGroup).toBe(true);
  });

  it("paints exactly one day divider per calendar day", () => {
    // A call at 00:05 and the reply to it at 00:06 used to each print "Today".
    const lateNightCall = card({ id: "cn", at: "2026-10-03T00:05:00.000Z" });
    const lateNightMsg = msg("m9", THEM, "2026-10-03T00:06:00.000Z");
    const entries = buildThreadTimeline([before, lateNightMsg], [lateNightCall]);
    expect(entries.filter((e) => e.newDay).map((e) => e.key)).toEqual(["m:m2", "c:cn"]);
  });

  it("starts a new message group when the day changes", () => {
    const nextDay = msg("m4", ME, "2026-10-03T08:00:00.000Z");
    const entries = buildThreadTimeline([before, nextDay], []);
    expect(entries[1].type === "message" && entries[1].startsGroup).toBe(true);
  });

  it("is stable about a tie: the message the call followed stays first", () => {
    const sameTime = card({ id: "tie", at: "2026-10-02T10:00:00.000Z" });
    const entries = buildThreadTimeline([before], [sameTime]);
    expect(entries.map((e) => e.key)).toEqual(["m:m2", "c:tie"]);
  });

  it("survives an empty side and an unreadable timestamp", () => {
    expect(buildThreadTimeline([], []).length).toBe(0);
    expect(buildThreadTimeline([msg("bx", ME, "not-a-date")], []).length).toBe(1);
    expect(
      buildThreadTimeline(null as unknown as Message[], null as unknown as CallCard[]).length,
    ).toBe(0);
  });
});

/* ------------------------------------------------------- 3. layout of a call */

describe("a voice call looks like a voice call", () => {
  const voiceIdle = {
    dialled: "audio" as const,
    cameraOn: false,
    sharing: false,
    peerCamera: false,
    peerShare: false,
  };

  it("gives a voice call no self tile at all", () => {
    // The old gate was "is there a local stream", and a voice call always has one
    // (the microphone), so every voice call showed a black rectangle reading
    // "Camera off" — chrome that implies a fault nobody has.
    expect(selfTileVisible({ cameraOn: false, sharing: false })).toBe(false);
    expect(callCarriesVideo(voiceIdle)).toBe(false);
    expect(remotePaneFramed("avatar", false)).toBe(false);
  });

  it("shows your tile the moment you send a picture, and only then", () => {
    expect(selfTileVisible({ cameraOn: true, sharing: false })).toBe(true);
    expect(selfTileVisible({ cameraOn: false, sharing: true })).toBe(true);
  });

  it("lets the far side turn their camera on without asking you to turn yours on", () => {
    // Requirement, in one line: their camera arriving must reach them to you.
    const peerTurnedCameraOn = { ...voiceIdle, peerCamera: true };
    expect(callCarriesVideo(peerTurnedCameraOn)).toBe(true);
    const pane = remotePaneContent({
      hasRemoteVideoTrack: true,
      cameraOn: true,
      sharing: false,
      videoLive: true,
    });
    expect(pane).toBe("camera");
    // Video call with a covered lens keeps its frame mounted, so the arrival of
    // their picture is one cross-fade instead of a remount.
    expect(remotePaneFramed("avatar", true)).toBe(true);
    expect(remotePaneFramed("camera", true)).toBe(true);
    expect(remotePaneFramed("screen", true)).toBe(true);
  });

  it("still calls a video call a video call when both lenses are covered", () => {
    expect(callCarriesVideo({ ...voiceIdle, dialled: "video" })).toBe(true);
  });
});

describe("the device picker ticks the device in use", () => {
  it("matches on the live id when the browser exposed one", () => {
    expect(isLiveDevice("mic-a", "mic-a")).toBe(true);
    expect(isLiveDevice("mic-b", "mic-a")).toBe(false);
    // The backwards rule this replaces (`active: !deviceId`) highlighted the row
    // with *no* id and dimmed the microphone actually being used.
    expect(isLiveDevice("mic-a", "")).toBe(false);
  });

  it("falls back to the default row only while nothing is known", () => {
    expect(isLiveDevice("", "")).toBe(true);
    expect(isLiveDevice(undefined, undefined)).toBe(true);
  });
});

/* -------------------------------------------------------- 4. lag and quality */

describe("bandwidth is partitioned so speech wins", () => {
  it("caps audio far below video, so congestion sacrifices the picture first", () => {
    expect(AUDIO_MAX_BITRATE).toBeLessThan(videoEncodeHint("camera").maxBitrate!);
    expect(AUDIO_MAX_BITRATE).toBeLessThan(videoEncodeHint("screen").maxBitrate!);
    expect(AUDIO_MAX_BITRATE).toBeGreaterThanOrEqual(32_000);
  });

  it("protects resolution over frame rate for a shared screen", () => {
    expect(videoEncodeHint("screen").degradationPreference).toBe("maintain-resolution");
    expect(videoEncodeHint("camera").degradationPreference).toBe("balanced");
    expect(videoEncodeHint("screen").contentHint).toBe("detail");
    expect(videoEncodeHint("camera").contentHint).toBe("motion");
    expect(videoEncodeHint("screen").maxBitrate!).toBeGreaterThan(
      videoEncodeHint("camera").maxBitrate!,
    );
  });

  it("steps resolution down as the link degrades, and never up while it is bad", () => {
    expect(adaptiveVideoProfile("good")).toBe("full");
    expect(adaptiveVideoProfile("fair")).toBe("reduced");
    expect(adaptiveVideoProfile("poor")).toBe("minimal");
    expect(adaptiveVideoProfile("unknown")).toBe("full");

    const { full, reduced, minimal } = VIDEO_PROFILES;
    expect(reduced.width * reduced.height).toBeLessThan(full.width * full.height);
    expect(minimal.width * minimal.height).toBeLessThan(reduced.width * reduced.height);
    expect(minimal.frameRate).toBeLessThan(full.frameRate);
  });
});

/* --------------------------------------------------------- 5. wiring in source */

describe("CallModal is driven by the predicates above", () => {
  const modal = read("../src/components/social/CallModal.tsx");

  it("renders no camera-off notice in the self tile", () => {
    // The words may appear in comments explaining what was removed; what must
    // not appear is a UI element saying it.
    expect(modal).not.toMatch(/>\s*Camera off/);
    expect(modal).not.toMatch(/["`(]\s*Camera off\s*["`)\]]\s*[;<]/);
    const selfTile = between(modal, "{showSelfTile && (", "{/* In-call chat");
    expect(selfTile).not.toContain("VideoOff");
    expect(selfTile).toContain("showSelfTile");
    expect(modal).toMatch(/\{!session\.micOn && \(/);
  });

  it("composites the avatar over the pane instead of replacing the video", () => {
    expect(modal).toContain('{pane === "avatar" && framedPane && (');
    expect(modal).toContain('pane === "avatar" && !framedPane && "hidden"');
    expect(modal).toContain('{pane === "avatar" && !framedPane && (');
  });

  it("says a call is encrypted only once the handshake proves it", () => {
    expect(modal).toContain("session.mediaEncrypted &&");
    expect(modal).toMatch(/title=\{?"Call audio and video are encrypted end to end/);
  });

  it("keeps the quality chip out of the way while the link is fine", () => {
    expect(modal).toContain('session.quality !== "unknown" && session.quality !== "good"');
  });

  it("disables screen share where the browser cannot do it, instead of lying", () => {
    expect(modal).toContain("disabled={!session.canShareScreen}");
    expect(modal).not.toMatch(/<MonitorOff/);
  });

  it("marks the peer's mute on their picture, not only on the avatar", () => {
    expect(modal).toContain("{peerMedia.muted && (");
  });
});

describe("the session earns the polish it claims", () => {
  const session = read("../src/hooks/useCallSession.ts");

  it("measures encryption off the DTLS handshake", () => {
    expect(session).toContain('"dtls-transport"');
    expect(session).toMatch(/state === "connected" && !!t\.dtlsCipher/);
  });

  it("tunes the audio sender on connect", () => {
    expect(session).toContain("void tuneAudioSender(selectAudioSender(pc.getSenders()))");
  });

  it("adapts resolution with applyConstraints, which never renegotiates", () => {
    const adaptive = between(
      session,
      "const wanted = adaptiveVideoProfile(quality);",
      "}, [quality, connection]);",
    );
    expect(adaptive).toContain("applyConstraints");
    // A share must not be dragged down to somebody's webcam profile.
    expect(adaptive).toContain("if (sharingRef.current) return;");
    // ...and an oscillating quality chip must not re-ask twice a second.
    expect(adaptive).toContain("appliedProfileRef.current");
    // A fresh camera opens at the profile already in force, not at full again.
    expect(session).toContain("cameraConstraintsFor(appliedProfileRef.current)");
  });

  it("asks for audio politely, so a driver that cannot honour a flag still gives a mic", () => {
    expect(session).toMatch(/echoCancellation: \{ ideal: true \}/);
    expect(session).toMatch(/sampleRate: \{ ideal: /);
  });

  it("takes a covered camera off the wire rather than sending black frames", () => {
    expect(session).toContain('await setVideoOnWire(null, "camera")');
  });

  it("opens a video m-line explicitly when a voice call grows a camera", () => {
    expect(session).toContain("pc.addTrack(track, stream)");
    expect(session).toMatch(/transceiver\.direction = "sendrecv"/);
  });
});

describe("messages shows the call without a second copy of history", () => {
  const thread = read("../src/routes/messages.tsx");
  const api = read("../src/lib/api-client.ts");
  const feed = read("../src/lib/realtime.ts");

  it("renders the merged timeline through the card component", () => {
    expect(thread).toContain("buildThreadTimeline(thread, callCards)");
    expect(thread).toContain("<CallCardChip");
    expect(thread).toMatch(/if \(entry\.type === "call"\)/);
  });

  it("reads calls straight off the calls table, under its own RLS", () => {
    const fn = between(
      api,
      "export async function getCallHistory",
      "export async function getOrCreateConversation",
    );
    expect(fn).toContain('from("calls")');
    expect(fn).toContain("callCardsFromRows");
    // Deriving the card is what keeps a stranger from writing a fake "Missed
    // call" into somebody else's thread: no new write path exists at all.
    expect(fn).not.toContain('from("messages")');
  });

  it("leaves a card in the thread the moment either phone hangs up", () => {
    expect(feed).toContain('table: "calls"');
    expect(feed).toContain('"call:resolved"');
    expect(thread).toContain('event.type === "call:resolved"');
  });
});

/* --------------------------------------------- 6. security and story guards */

describe("what is encrypted, and who may see a story", () => {
  const signals = read("../db/migrations/20260925000013_call_signals.sql");
  const channels = read("../db/migrations/20260925000009_realtime_channel_rls.sql");
  const stories = read("../db/migrations/20260924000005_story_graph_and_fees.sql");
  const buckets = read("../db/migrations/20261001000099_media_public_private_buckets.sql");
  const authz = read("../src/lib/media-authz.server.ts");
  const api = read("../src/lib/api-client.ts");

  it("scopes signalling to the two people on the call, append-only", () => {
    expect(signals).toMatch(/create policy "call_signals participant read"/);
    expect(signals).toMatch(/create policy "call_signals participant write"/);
    expect(signals).toMatch(/revoke update, delete on public\.call_signals/);
    expect(channels).toMatch(/call-signal/);
  });

  it("keeps story bytes in a bucket only the author can list", () => {
    expect(buckets).toMatch(/media-private/);
    const storiesFolder = read("../src/lib/media-folders.server.ts");
    expect(storiesFolder).toMatch(/stories/);
  });

  it("guards a story on the row and on the bytes with the same rule", () => {
    expect(stories).toMatch(/create policy "stories graph read"/);
    expect(stories).toMatch(/expires_at > now\(\)/);
    expect(stories).toMatch(/public\.follows/);
    expect(stories).toMatch(/owns_profile\(user_id\)/);
    expect(authz).toContain("isAuthorizedForStoryMedia");
    // The author is read out of the object key (`stories/<profileId>/…`), which
    // the upload route mints from the verified caller — never from a header
    // somebody sent, and it fails closed when the key has no author in it.
    const gate = between(authz, "export async function canReadMediaPath", "const mediaUrlFor");
    expect(gate).toContain('folder === "stories"');
    expect(gate).toContain("return false");
    const storyRule = between(
      authz,
      "async function isAuthorizedForStoryMedia",
      "async function isAuthorizedForRecording",
    );
    expect(storyRule).toContain("segments[1]");
    expect(storyRule).toContain("if (!authorId) return false;");
    expect(storyRule).toMatch(/from\("follows"\)/);
  });

  it("only ever asks the database for stories that have not expired", () => {
    const fn = between(
      api,
      "export async function getStories",
      "export async function createStory",
    );
    expect(fn).toContain('.gt("expires_at"');
    // No by-id shortcut that would skip the graph policy.
    expect(fn).not.toContain('.eq("id"');
  });
});
