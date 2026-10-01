/**
 * The rules behind a 1:1 call, kept apart from WebRTC.
 *
 * Same reasoning as `spaces-stage.ts`: the parts of a call that decide *what is
 * sent, what is rendered and what is ignored* are the parts that regress
 * quietly, and none of them need a browser to be checked. Track swapping,
 * offer/answer collisions and quality thresholds live here so the hook stays
 * plumbing and the tests can drive them directly.
 *
 * Every function takes structural types, so a test can pass a plain object
 * where the browser would pass a MediaStreamTrack.
 */

/** A signal that carries something a user sees rather than SDP. */
export const CALL_UI_SIGNALS = ["media", "chat", "reaction"] as const;
export type CallUiSignalKind = (typeof CALL_UI_SIGNALS)[number];

/** Signalling events that are pure transport (offer/answer/ICE/ready). */
export const CALL_TRANSPORT_SIGNALS = ["offer", "answer", "ice", "ready"] as const;

export const MAX_CALL_CHAT_CHARS = 500;
/** In-call chat is ephemeral, but a long call should not grow without bound. */
export const CALL_CHAT_HISTORY = 200;
/** Reactions are fire-and-forget animations; cap what one call can hold. */
export const CALL_REACTION_HISTORY = 40;
/** A burst of duplicate broadcasts must not double-render a message. */
export const CALL_EVENT_MEMORY = 300;

/** Anything with the shape we read off a MediaStreamTrack. */
export interface TrackLike {
  kind: "audio" | "video" | string;
  enabled?: boolean;
  getSettings?: () => { deviceId?: string; displaySurface?: string };
}

/**
 * `RTCRtpSender` at runtime; the structural type below is what makes the rule
 * testable with plain objects, while the generic `select*` helpers keep the
 * caller's real browser type — so `selectVideoTransceiver(pc.getTransceivers())`
 * still hands back an `RTCRtpTransceiver` whose `sender.replaceTrack()` exists.
 */
export interface SenderLike {
  track?: TrackLike | null;
}

/** Anything with the shape we read off an RTCRtpTransceiver. */
export interface TransceiverLike {
  sender: SenderLike;
  receiver: SenderLike;
}

export interface AudioDeviceLike {
  deviceId: string;
  kind?: string;
  label?: string;
}

/**
 * A screen-share track is the one video track that came from `getDisplayMedia`.
 * Browsers mark it with `displaySurface` ("monitor" | "window" | "browser" |
 * "application"); a camera never sets it.
 */
export function isScreenShareTrack(track: TrackLike | null | undefined): boolean {
  if (!track || track.kind !== "video") return false;
  try {
    return !!track.getSettings?.().displaySurface;
  } catch {
    // A track the browser has already ended can throw here. An ended track is
    // never the live share we are looking for.
    return false;
  }
}

export function cameraTrackOf(tracks: TrackLike[]): TrackLike | null {
  return tracks.find((t) => t.kind === "video" && !isScreenShareTrack(t)) ?? null;
}

export function screenTrackOf(tracks: TrackLike[]): TrackLike | null {
  return tracks.find(isScreenShareTrack) ?? null;
}

/**
 * Which transceiver carries the call's single video stream?
 *
 * Getting this wrong is what made screen share one-way: the old lookup matched
 * "a sender with no track and no DTMF", which an *audio* sender satisfies the
 * moment its microphone is removed — so a screen share could replace the
 * microphone and the peer kept hearing nothing. Match on kind only, and never
 * fall back to something we cannot identify.
 */
export function selectVideoTransceiver<T extends TransceiverLike>(
  transceivers: readonly T[],
): T | null {
  const list = transceivers ?? [];
  const senderVideo = list.find((t) => t.sender?.track?.kind === "video");
  if (senderVideo) return senderVideo;
  // A video m-line we only receive on (the peer added video first).
  return list.find((t) => t.receiver?.track?.kind === "video") ?? null;
}

/** Same rule for audio: only ever touch a sender that is actually the mic. */
export function selectAudioSender<T extends SenderLike>(senders: readonly T[]): T | null {
  return (senders ?? []).find((s) => s.track?.kind === "audio") ?? null;
}

/**
 * Perfect negotiation, the collision rule (RFC 8863 in spirit).
 *
 * Both sides may want to renegotiate at the same instant — the classic case is
 * one person screen-sharing while the other is still answering the call's first
 * offer. Without this, the two offers collide, one side lands in a broken
 * signalling state and the share never appears. Exactly one side ("polite")
 * backs down and waits to be re-offered; the caller is polite-free on purpose
 * because it already owns the first offer.
 */
export function shouldIgnoreIncomingOffer({
  polite,
  makingOffer,
  signalingState,
}: {
  polite: boolean;
  makingOffer: boolean;
  signalingState: string;
}): boolean {
  const collision = makingOffer || signalingState !== "stable";
  return collision && !polite;
}

/**
 * A reply may only be applied by the side that is still holding an unanswered
 * offer; anything else would clobber a live connection.
 *
 * The collision flag is deliberately *not* consulted here. The obvious-looking
 * rule ("an answer that followed an offer I ignored must be stale") also
 * discards the answer to the offer I am actually waiting for, which dead-ends a
 * call that would otherwise connect - and the browser already refuses an answer
 * that does not match the description it was offered.
 */
export function canApplyAnswer({ signalingState }: { signalingState: string }): boolean {
  return signalingState === "have-local-offer";
}

/**
 * Should the remote pane show video?
 *
 * Keyed on what is actually arriving rather than on how the call *started*: a
 * voice call that turned into a screen share has no business hiding the video
 * that is already on the wire.
 *
 * `videoLive` is the stronger of the two signals. The camera/share flags travel
 * as a fire-and-forget broadcast, so one lost during a reconnect leaves the pane
 * on an avatar while their picture is demonstrably arriving; a track the browser
 * reports as producing frames is evidence, not an announcement.
 */
export function shouldRenderRemoteVideo({
  hasRemoteVideoTrack,
  cameraOn,
  sharing,
  videoLive,
}: {
  hasRemoteVideoTrack: boolean;
  cameraOn: boolean;
  sharing: boolean;
  videoLive?: boolean;
}): boolean {
  if (!hasRemoteVideoTrack) return false;
  if (videoLive) return true;
  return sharing || cameraOn;
}

/** The far side turned its camera off and is not sharing: show the avatar. */
export function shouldShowRemoteAvatar(state: {
  hasRemoteVideoTrack: boolean;
  cameraOn: boolean;
  sharing: boolean;
  videoLive?: boolean;
}): boolean {
  return !shouldRenderRemoteVideo(state);
}

export type CallQuality = "good" | "fair" | "poor" | "unknown";

/**
 * A one-word verdict the user can act on. Loss is weighted harder than delay:
 * a shaky call is usually somebody's wifi, and "Reconnecting" is more honest
 * than a number nobody reads.
 */
export function classifyQuality({
  rttMs,
  lossRatio,
}: {
  rttMs: number | null;
  lossRatio: number | null;
}): CallQuality {
  if (rttMs === null && lossRatio === null) return "unknown";
  const rtt = rttMs ?? 0;
  const loss = lossRatio ?? 0;
  if (loss >= 0.05 || rtt >= 400) return "poor";
  if (loss >= 0.01 || rtt >= 180) return "fair";
  return "good";
}

/**
 * Pick the speaker output. An empty id means "whatever the OS says", which is
 * the correct default: headphones, bluetooth and a phone's earpiece are all
 * decided by the system, and guessing a device id is how you silence a call.
 */
export function pickAudioOutput(devices: AudioDeviceLike[], preferredId: string | null): string {
  const outputs = (devices ?? []).filter((d) => d.kind === "audiooutput" && d.deviceId);
  if (preferredId && outputs.some((d) => d.deviceId === preferredId)) return preferredId;
  return "";
}

/** Only audio elements honour `setSinkId`; video elements do not everywhere. */
export function canRouteAudio(el: unknown): boolean {
  return (
    typeof el === "object" &&
    el !== null &&
    typeof (el as { setSinkId?: unknown }).setSinkId === "function"
  );
}

export interface CallChatMessage {
  id: string;
  text: string;
  /** Whose device produced it — the payload of a broadcast proves nothing. */
  mine: boolean;
  at: number;
}

/**
 * The only gate a broadcast message passes through. Trimmed, bounded, plain
 * text: an in-call message is small by design, and a peer that sends megabytes
 * or markup must not be able to render it.
 */
export function sanitizeCallChat(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r/g, "").trim();
  if (!text) return null;
  return text.length > MAX_CALL_CHAT_CHARS ? `${text.slice(0, MAX_CALL_CHAT_CHARS - 1)}…` : text;
}

/** Drop a message that is not a usable object, or that we already applied. */
export function readChatPayload(raw: unknown): { id: string; text: string } | null {
  const p = raw as { id?: unknown; text?: unknown } | null;
  if (!p || typeof p.id !== "string" || !p.id) return null;
  const text = sanitizeCallChat(p.text);
  return text ? { id: p.id, text } : null;
}

export function readReactionPayload(raw: unknown): { id: string; emoji: string } | null {
  const p = raw as { id?: unknown; emoji?: unknown } | null;
  if (!p || typeof p.id !== "string" || !p.id) return null;
  const emoji = typeof p.emoji === "string" ? Array.from(p.emoji.trim()).slice(0, 4).join("") : "";
  return emoji ? { id: p.id, emoji } : null;
}

/**
 * Has this broadcast already been applied?
 *
 * Broadcasts can arrive twice (the realtime channel plus a retry), so every
 * user-visible event carries an id and the receiving side keeps a bounded
 * memory of it. Returns false and remembers when it is new.
 */
export function isNewEvent(seen: Set<string>, id: string, limit = CALL_EVENT_MEMORY): boolean {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > limit) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

/** Append, keeping only the most recent `cap` entries. */
export function pushBounded<T>(list: T[], item: T, cap: number): T[] {
  const next = [...list, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function formatCallDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * What the big pane is showing right now, so the label on it can tell the
 * truth instead of always naming the person.
 */
export type RemotePaneContent = "screen" | "camera" | "avatar";

export function remotePaneContent(state: {
  hasRemoteVideoTrack: boolean;
  cameraOn: boolean;
  sharing: boolean;
  videoLive?: boolean;
}): RemotePaneContent {
  if (state.sharing) return "screen";
  if (shouldRenderRemoteVideo(state)) return "camera";
  return "avatar";
}

/**
 * How each outgoing video stream should be encoded.
 *
 * Leaving this to the browser's defaults is why a call on hotel wifi turns to
 * blocks: a camera stream happily spends the whole available bandwidth and
 * starves the audio, and a screen share gets smoothed as if it were motion.
 * `contentHint` picks the right trade for each (frame rate for a face, sharp
 * text for a desktop) and the ceiling keeps video from eating the microphone.
 */
export type OutgoingVideoKind = "camera" | "screen";

export interface VideoEncodeHint {
  contentHint: string;
  maxBitrate: number;
  degradationPreference: RTCDegradationPreference;
}

/** 720p30 is ~1.2 Mbps of real detail; a 1080p desktop needs more for text. */
export const VIDEO_ENCODE_HINTS: Record<OutgoingVideoKind, VideoEncodeHint> = {
  camera: {
    contentHint: "motion",
    maxBitrate: 1_200_000,
    degradationPreference: "balanced",
  },
  screen: {
    contentHint: "detail",
    maxBitrate: 2_200_000,
    degradationPreference: "maintain-resolution",
  },
};

export function videoEncodeHint(kind: OutgoingVideoKind): VideoEncodeHint {
  return VIDEO_ENCODE_HINTS[kind] ?? VIDEO_ENCODE_HINTS.camera;
}
