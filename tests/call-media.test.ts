import { describe, expect, it } from "vitest";

import {
  MAX_CALL_CHAT_CHARS,
  canApplyAnswer,
  canRouteAudio,
  cameraTrackOf,
  classifyQuality,
  formatCallDuration,
  isNewEvent,
  isScreenShareTrack,
  pickAudioOutput,
  pushBounded,
  readChatPayload,
  readReactionPayload,
  remotePaneContent,
  sanitizeCallChat,
  selectAudioSender,
  selectVideoTransceiver,
  shouldIgnoreIncomingOffer,
  shouldRenderRemoteVideo,
  videoEncodeHint,
} from "@/lib/call-media";

/**
 * The call rules that shipped broken once.
 *
 * Screen share, in-call chat and the speaker button all existed in the UI before
 * any of them were true: sharing replaced the microphone's sender, "stop
 * sharing" handed the wire a null track, and a voice call hid the video that was
 * already arriving. None of those failures need a browser to describe, so they
 * are pinned here as rules rather than probed through WebRTC.
 */

const mic = { kind: "audio" };
const cam = { kind: "video" };
const display = { kind: "video", getSettings: () => ({ displaySurface: "window" }) };

describe("the video channel is chosen by kind, never by elimination", () => {
  it("picks the sender already carrying video", () => {
    const audio = { sender: { track: mic }, receiver: { track: mic } };
    const video = { sender: { track: cam }, receiver: { track: cam } };
    expect(selectVideoTransceiver([audio, video])).toBe(video);
  });

  it("never hands a screen share to the audio sender", () => {
    // The bug this replaces matched "no track and no DTMF", which an audio
    // sender satisfies the moment the microphone is gone — so sharing a screen
    // silently unplugged the caller's voice.
    const orphanAudio = { sender: { track: null }, receiver: { track: mic } };
    expect(selectVideoTransceiver([orphanAudio])).toBeNull();
    expect(selectAudioSender([{ track: null }, { track: mic }])?.track).toBe(mic);
  });

  it("uses a video m-line it only receives on", () => {
    // The peer turned their camera on first: this side has no video sender yet,
    // and replacing that sender's track is what answers them.
    const recvOnly = { sender: { track: null }, receiver: { track: cam } };
    expect(selectVideoTransceiver([recvOnly])?.sender.track).toBeNull();
  });

  it("finds the camera while a share is live", () => {
    const tracks = [mic, display, cam];
    expect(cameraTrackOf(tracks)).toBe(cam);
    expect(isScreenShareTrack(display)).toBe(true);
    expect(isScreenShareTrack(cam)).toBe(false);
    expect(isScreenShareTrack(mic)).toBe(false);
    // An ended track can throw from getSettings; it is never the live share.
    expect(isScreenShareTrack({ kind: "video", getSettings: () => throw_() })).toBe(false);
  });
});

function throw_(): never {
  throw new Error("ended");
}

describe("one offer, one answer, no collision", () => {
  it("makes the caller hold its ground and the callee back down", () => {
    const collision = { makingOffer: true, signalingState: "have-local-offer" };
    expect(shouldIgnoreIncomingOffer({ ...collision, polite: false })).toBe(true);
    expect(shouldIgnoreIncomingOffer({ ...collision, polite: true })).toBe(false);
  });

  it("always applies an offer when both sides are idle", () => {
    expect(
      shouldIgnoreIncomingOffer({ polite: false, makingOffer: false, signalingState: "stable" }),
    ).toBe(false);
  });

  it("applies an answer only for an offer it is still holding", () => {
    expect(canApplyAnswer({ signalingState: "have-local-offer" })).toBe(true);
    // Anything else means we are not waiting: applying it would clobber a live
    // connection. An answer that does not match our offer is refused by the
    // browser itself, so the collision flag must not swallow a good answer here.
    expect(canApplyAnswer({ signalingState: "stable" })).toBe(false);
    expect(canApplyAnswer({ signalingState: "have-remote-offer" })).toBe(false);
  });
});

describe("what the remote pane is actually showing", () => {
  const videoArrived = { hasRemoteVideoTrack: true };

  it("shows a screen share that started from a voice call", () => {
    // Rendering used to be gated on how the call *began*, so the frames that
    // were already on the wire were thrown away.
    expect(shouldRenderRemoteVideo({ ...videoArrived, cameraOn: false, sharing: true })).toBe(true);
    expect(remotePaneContent({ ...videoArrived, cameraOn: false, sharing: true })).toBe("screen");
  });

  it("shows the camera when there is one", () => {
    expect(remotePaneContent({ ...videoArrived, cameraOn: true, sharing: false })).toBe("camera");
  });

  it("falls back to the avatar when they cover the lens", () => {
    expect(remotePaneContent({ ...videoArrived, cameraOn: false, sharing: false })).toBe("avatar");
    expect(remotePaneContent({ hasRemoteVideoTrack: false, cameraOn: true, sharing: false })).toBe(
      "avatar",
    );
  });

  it("trusts frames over the announcement that lost them", () => {
    // The camera/share flags ride a fire-and-forget broadcast. One dropped while
    // a socket reconnects used to leave the pane on an avatar while their video
    // was demonstrably arriving — the report was "the picture of them doesn't
    // work after switching from voice to video".
    expect(
      shouldRenderRemoteVideo({
        ...videoArrived,
        cameraOn: false,
        sharing: false,
        videoLive: true,
      }),
    ).toBe(true);
    expect(
      remotePaneContent({ ...videoArrived, cameraOn: true, sharing: false, videoLive: false }),
    ).toBe("camera");
    // A track that has stopped producing frames and a covered lens is the avatar.
    expect(
      remotePaneContent({ ...videoArrived, cameraOn: false, sharing: false, videoLive: false }),
    ).toBe("avatar");
  });
});

describe("outgoing video is encoded for what it is", () => {
  it("protects frame rate for a face and sharpness for a desktop", () => {
    expect(videoEncodeHint("camera").contentHint).toBe("motion");
    expect(videoEncodeHint("screen").contentHint).toBe("detail");
    expect(videoEncodeHint("screen").degradationPreference).toBe("maintain-resolution");
  });

  it("keeps a ceiling, and keeps video below what a call can afford", () => {
    // No ceiling at all is how a camera eats the microphone on a weak link.
    expect(videoEncodeHint("camera").maxBitrate).toBeGreaterThan(300_000);
    expect(videoEncodeHint("screen").maxBitrate).toBeGreaterThan(
      videoEncodeHint("camera").maxBitrate,
    );
    expect(videoEncodeHint("camera").maxBitrate).toBeLessThanOrEqual(2_000_000);
  });
});

describe("in-call chat is text, not whatever a peer sent", () => {
  it("trims, and rejects what is left with nothing in it", () => {
    expect(sanitizeCallChat("  hello  \n")).toBe("hello");
    expect(sanitizeCallChat("   ")).toBeNull();
    expect(sanitizeCallChat("\n\n")).toBeNull();
    expect(sanitizeCallChat(42)).toBeNull();
    expect(sanitizeCallChat(null)).toBeNull();
  });

  it("clips a broadcast that is far too long instead of rendering it", () => {
    const huge = sanitizeCallChat("a".repeat(50_000)) ?? "";
    expect(huge.length).toBe(MAX_CALL_CHAT_CHARS);
    expect(huge.endsWith("…")).toBe(true);
  });

  it("drops payloads that are not shaped like a message", () => {
    expect(readChatPayload({ text: "hi" })).toBeNull(); // no id to dedupe on
    expect(readChatPayload({ id: "1", text: "  " })).toBeNull();
    expect(readChatPayload({ id: "1", text: "hi" })).toEqual({ id: "1", text: "hi" });
    expect(readReactionPayload({ id: "1" })).toBeNull();
    expect(readReactionPayload({ id: "1", emoji: "👍" })).toEqual({ id: "1", emoji: "👍" });
  });

  it("applies a broadcast once, however many times it arrives", () => {
    const seen = new Set<string>();
    expect(isNewEvent(seen, "c1")).toBe(true);
    expect(isNewEvent(seen, "c1")).toBe(false);
    expect(isNewEvent(seen, "")).toBe(true); // nothing to remember
  });

  it("keeps only what it can afford to remember", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) isNewEvent(seen, `id${i}`, 50);
    expect(seen.size).toBeLessThanOrEqual(50);
  });

  it("caps the transcript from the oldest end", () => {
    let list: number[] = [];
    for (let i = 0; i < 10; i += 1) list = pushBounded(list, i, 4);
    expect(list).toEqual([6, 7, 8, 9]);
  });
});

describe("the quality chip says something only when it means something", () => {
  it("calls a healthy link good", () => {
    expect(classifyQuality({ rttMs: 40, lossRatio: 0 })).toBe("good");
  });

  it("notices the first dropped packets", () => {
    expect(classifyQuality({ rttMs: 40, lossRatio: 0.02 })).toBe("fair");
    expect(classifyQuality({ rttMs: 250, lossRatio: 0 })).toBe("fair");
  });

  it("calls a bad link bad", () => {
    expect(classifyQuality({ rttMs: 900, lossRatio: 0 })).toBe("poor");
    expect(classifyQuality({ rttMs: 30, lossRatio: 0.2 })).toBe("poor");
  });

  it("admits when there are no numbers yet", () => {
    expect(classifyQuality({ rttMs: null, lossRatio: null })).toBe("unknown");
  });
});

describe("audio output", () => {
  const devices = [
    { deviceId: "", kind: "audiooutput", label: "Default" },
    { deviceId: "speakers", kind: "audiooutput", label: "Speakers" },
    { deviceId: "mic", kind: "audioinput", label: "Mic" },
  ];

  it("uses the chosen speaker", () => {
    expect(pickAudioOutput(devices, "speakers")).toBe("speakers");
  });

  it("falls back to the system default when the device is gone", () => {
    // A headset unplugged mid-call must not leave the call pointed at a device
    // that no longer exists.
    expect(pickAudioOutput(devices, "unplugged")).toBe("");
    expect(pickAudioOutput(devices, null)).toBe("");
  });

  it("never routes to an input device", () => {
    expect(pickAudioOutput(devices, "mic")).toBe("");
  });

  it("only claims routing when the element can do it", () => {
    expect(canRouteAudio({ setSinkId: () => {} })).toBe(true);
    expect(canRouteAudio({})).toBe(false);
    expect(canRouteAudio(null)).toBe(false);
  });
});

describe("durations", () => {
  it("reads like a call timer", () => {
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(65)).toBe("1:05");
    expect(formatCallDuration(599)).toBe("9:59");
    expect(formatCallDuration(3725)).toBe("1:02:05");
    expect(formatCallDuration(-5)).toBe("0:00");
  });
});
