import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  Phone,
  PhoneOff,
  PictureInPicture2,
  Send,
  Settings2,
  ShieldCheck,
  Speaker,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

import { Avatar } from "@/components/social/Avatar";
import { useCallSession } from "@/hooks/useCallSession";
import {
  CALL_CHAT_HISTORY,
  CALL_REACTION_HISTORY,
  MAX_CALL_CHAT_CHARS,
  callCarriesVideo,
  canRouteAudio,
  formatCallDuration,
  isNewEvent,
  isLiveDevice,
  pickAudioOutput,
  pushBounded,
  readChatPayload,
  readReactionPayload,
  remotePaneContent,
  remotePaneFramed,
  sanitizeCallChat,
  selfTileVisible,
  type RemotePaneContent,
} from "@/lib/call-media";
import { CALL_REACTIONS } from "@/lib/emojis";
import type { Profile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface CallModalProps {
  partner: Profile | null;
  type: "audio" | "video";
  isOpen: boolean;
  /** Receives the connected duration so the call history stops recording 0s. */
  onClose: (seconds: number) => void;
  /** Id of the call row; when present the call is a real connected call. */
  callId?: string | null;
  role?: "caller" | "callee";
  /** "ringing" until the other person picks up, then "active". */
  callStatus?: "ringing" | "active";
}

/**
 * The call's seconds counter, on its own.
 *
 * A tick in the modal body re-rendered the whole sheet every second - both video
 * panes, the chat list and the device picker - on a component whose only job is
 * to keep two streams playing smoothly. Here the tick re-renders one <span>.
 * The count still lives in `tickRef`, which is what `onClose` reports, so a
 * call that minimises or re-renders never loses or double-counts seconds.
 */
function CallDuration({
  running,
  tickRef,
  className,
}: {
  running: boolean;
  tickRef: { current: number };
  className?: string;
}) {
  const [seconds, setSeconds] = useState(tickRef.current);

  useEffect(() => {
    if (!running) return undefined;
    // Adopt the shared counter on mount (this element re-mounts when the call is
    // restored from the corner pill) instead of starting a second clock.
    setSeconds(tickRef.current);
    const timer = setInterval(() => {
      tickRef.current += 1;
      setSeconds(tickRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [running, tickRef]);

  return <span className={className}>{formatCallDuration(seconds)}</span>;
}

const QUALITY_LABEL: Record<string, string> = {
  good: "Strong",
  fair: "Choppy",
  poor: "Weak",
  unknown: "",
};

export function CallModal({
  partner,
  type,
  isOpen,
  onClose,
  callId = null,
  role = "caller",
  callStatus = "active",
}: CallModalProps) {
  const [minimized, setMinimized] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [unread, setUnread] = useState(0);
  const [messages, setMessages] = useState<
    Array<{ id: string; text: string; mine: boolean; at: number }>
  >([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [reactions, setReactions] = useState<Array<{ id: string; emoji: string; left: number }>>(
    [],
  );
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputId, setOutputId] = useState("");
  const [volume, setVolume] = useState(1);
  const [soundOn, setSoundOn] = useState(true);
  const [soundBlocked, setSoundBlocked] = useState(false);
  // The expand buttons must mirror what the browser actually did: pressing Esc
  // leaves fullscreen without going through a click, so an un-listened flag both
  // lies about the icon and makes the next tap try to exit a fullscreen we are
  // no longer in. Same logic for picture-in-picture.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPip, setIsPip] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const showChatRef = useRef(false);
  /** Broadcast ids already applied — a duplicate must not render twice. */
  const seenRef = useRef(new Set<string>());
  const secondsRef = useRef(0);

  const session = useCallSession({
    callId,
    role,
    kind: type,
    enabled: isOpen && Boolean(callId) && callStatus === "active",
  });

  const connected = session.connection === "connected";
  const { peerMedia } = session;

  // Closing the sheet resets the clock for the next call; the counter itself is
  // owned by <CallDuration> so a tick cannot re-render the whole modal.
  useEffect(() => {
    if (!isOpen) secondsRef.current = 0;
  }, [isOpen]);

  // ---- media elements -------------------------------------------------------------
  // One audio path only. The remote <video> is muted and the hidden <audio> is
  // the single thing that plays sound: both elements playing the same stream used
  // to double the audio (and feed it straight back into the microphone), and it
  // also meant the speaker button silenced nothing at all.
  //
  // The streams are attached through callback refs rather than an effect because
  // the local tile swaps between the camera and the desktop, so a fresh element
  // can mount with no effect scheduled to fill it — that is how a preview goes
  // black after a screen share ends.
  //
  // Those refs are memoised. An inline arrow is a new function every render, and
  // React then calls the old one with null and the new one with the node, so any
  // re-render detached and re-attached both panes; and each only re-binds when the
  // stream it holds actually changes identity.
  const remoteStream = session.remoteStream;
  const attachRemoteVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      remoteVideoRef.current = el;
      if (el && el.srcObject !== remoteStream) el.srcObject = remoteStream;
    },
    [remoteStream],
  );

  // One element for the self tile: your camera normally, your desktop while you
  // share. Two sibling <video> nodes swapping meant a fresh decoder plus a replay
  // of the tile's zoom-in animation on every share toggle.
  const selfStream = session.sharing ? session.screenStream : session.localStream;
  const attachSelfVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      localVideoRef.current = el;
      if (el && el.srcObject !== selfStream) el.srcObject = selfStream;
    },
    [selfStream],
  );

  useEffect(() => {
    const audio = remoteAudioRef.current;
    if (!audio) return;
    // Assign only on a real change: re-setting the same stream restarts decoding.
    if (audio.srcObject !== session.remoteStream) audio.srcObject = session.remoteStream;
    if (!session.remoteStream || !soundOn) return;
    let alive = true;
    audio
      .play()
      .then(() => {
        if (alive) setSoundBlocked(false);
      })
      .catch(() => {
        // Autoplay policy, not a broken call: one tap on the banner unlocks it.
        if (alive) setSoundBlocked(true);
      });
    return () => {
      alive = false;
    };
    // Re-running on `soundOn` is the un-mute path: a stream the autoplay policy
    // blocked stays blocked until a gesture re-calls play(), and toggling the
    // speaker button is exactly that gesture.
  }, [session.remoteStream, soundOn]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const el = remoteVideoRef.current;
    if (!el) return;
    const enter = () => setIsPip(true);
    const leave = () => setIsPip(false);
    el.addEventListener("enterpictureinpicture", enter);
    el.addEventListener("leavepictureinpicture", leave);
    return () => {
      el.removeEventListener("enterpictureinpicture", enter);
      el.removeEventListener("leavepictureinpicture", leave);
      setIsPip(false);
    };
  }, [isOpen, session.remoteStream]);

  // Speaker / headphone routing. Falls back to silence when the browser has no
  // say over the output device, rather than pretending to move the audio.
  const activeSinkId = pickAudioOutput(devices, outputId || null);

  useEffect(() => {
    const audio = remoteAudioRef.current;
    if (!audio) return;
    audio.muted = !soundOn;
    audio.volume = volume;
    if (canRouteAudio(audio)) {
      void audio.setSinkId(activeSinkId).catch(() => {
        /* device unplugged mid-call; the OS default still plays */
      });
    }
  }, [activeSinkId, volume, soundOn, session.remoteStream]);

  // ---- device lists ---------------------------------------------------------------
  useEffect(() => {
    if (!isOpen || !navigator.mediaDevices?.enumerateDevices) return undefined;
    let alive = true;
    const list = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((found) => {
          if (alive) setDevices(found);
        })
        .catch(() => undefined);
    void list();
    const onChange = () => void list();
    navigator.mediaDevices.addEventListener?.("devicechange", onChange);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener?.("devicechange", onChange);
    };
  }, [isOpen, session.localStream]);

  /** A reaction is a two-second animation, whoever sent it. */
  const showReaction = useCallback((id: string, emoji: string) => {
    const left = Math.floor(Math.random() * 60) + 20;
    setReactions((prev) => pushBounded(prev, { id, emoji, left }, CALL_REACTION_HISTORY));
    setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== id)), 2400);
  }, []);

  // ---- in-call signals (chat + reactions) ----------------------------------------
  // `onSignal` is a stable callback out of the hook; depending on `session` would
  // resubscribe on every render, which is how a received message ends up twice.
  const { onSignal } = session;
  useEffect(() => {
    const offChat = onSignal("chat", (payload) => {
      const message = readChatPayload(payload);
      if (!message || !isNewEvent(seenRef.current, message.id)) return;
      setMessages((prev) =>
        pushBounded(
          prev,
          { id: message.id, text: message.text, mine: false, at: Date.now() },
          CALL_CHAT_HISTORY,
        ),
      );
      // Read the open/closed state from a ref: setting one piece of state from
      // inside another setter's updater double-counts under StrictMode.
      if (!showChatRef.current) setUnread((n) => n + 1);
    });
    const offReaction = onSignal("reaction", (payload) => {
      const reaction = readReactionPayload(payload);
      if (!reaction || !isNewEvent(seenRef.current, reaction.id)) return;
      showReaction(reaction.id, reaction.emoji);
    });
    return () => {
      offChat();
      offReaction();
    };
  }, [onSignal, showReaction]);

  useEffect(() => {
    if (session.mediaError) toast.error(session.mediaError);
  }, [session.mediaError]);

  useEffect(() => {
    showChatRef.current = showChat;
  }, [showChat]);

  useEffect(() => {
    if (showChat) {
      setUnread(0);
      chatEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [showChat, messages.length]);

  // A screen share arriving mid-conversation is worth announcing; the pane label
  // alone is easy to miss while you are looking at the chat.
  const peerSharingRef = useRef(false);
  const peerName = partner?.display_name ?? "";
  useEffect(() => {
    if (peerMedia.share && !peerSharingRef.current && peerName) {
      toast.info(`${peerName} is sharing their screen`);
    }
    peerSharingRef.current = peerMedia.share;
  }, [peerMedia.share, peerName]);

  if (!isOpen || !partner) return null;

  const statusLabel =
    callStatus === "ringing"
      ? role === "caller"
        ? "Ringing…"
        : "Incoming"
      : connected
        ? "Connected"
        : session.connection === "failed"
          ? "Connection lost"
          : "Connecting…";

  const pane: RemotePaneContent = remotePaneContent({
    hasRemoteVideoTrack: session.remoteHasVideo,
    cameraOn: peerMedia.camera,
    sharing: peerMedia.share,
    videoLive: session.remoteVideoLive,
  });

  /**
   * A call carries video when there is a picture in it, not when it was dialled
   * as one. The kind you chose at dial time is a starting point: either person
   * can switch their camera on from a voice call, and the layout must follow the
   * media rather than freeze on the button somebody pressed a minute ago.
   */
  const hasVideo = callCarriesVideo({
    dialled: type,
    cameraOn: session.cameraOn,
    sharing: session.sharing,
    peerCamera: peerMedia.camera,
    peerShare: peerMedia.share,
  });

  /**
   * `framed` is the smooth-transition trick. On a video call the big pane stays
   * on screen with the avatar composited over it, so the instant their camera
   * starts producing frames the picture is already there underneath and the
   * handover is one opacity change — no remount, no black card, no re-decode.
   * On a voice call there is no picture to wait for, so the pane gives its whole
   * space to the avatar, which is the clean layout people expect of a call that
   * was never going to have video in it.
   */
  const framedPane = remotePaneFramed(pane, hasVideo);

  /**
   * Your own tile exists only while you are actually sending a picture. Showing
   * one with a "Camera off" label in it on a voice call is the chrome people
   * mean when they say a voice call looks broken: there is nothing wrong with
   * the call, and the interface keeps insisting on a camera nobody turned on.
   */
  const showSelfTile = selfTileVisible({
    cameraOn: session.cameraOn,
    sharing: session.sharing,
  });

  const audioOutputs = devices.filter((d) => d.kind === "audiooutput");
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const microphones = devices.filter((d) => d.kind === "audioinput");
  const routingAvailable = canRouteAudio(remoteAudioRef.current) && audioOutputs.length > 1;

  function triggerReaction(emoji: string) {
    const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!isNewEvent(seenRef.current, id)) return;
    showReaction(id, emoji);
    session.sendSignal("reaction", { id, emoji });
  }

  function sendNote() {
    const text = sanitizeCallChat(noteDraft);
    if (!text) return;
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!isNewEvent(seenRef.current, id)) return;
    setMessages((prev) =>
      pushBounded(prev, { id, text, mine: true, at: Date.now() }, CALL_CHAT_HISTORY),
    );
    session.sendSignal("chat", { id, text });
    setNoteDraft("");
  }

  async function toggleShare() {
    if (session.sharing) {
      await session.stopScreenShare();
      toast.info("Stopped sharing your screen");
      return;
    }
    const started = await session.startScreenShare();
    if (started) toast.success("Sharing your screen — the other person sees it now");
  }

  function unlockSound() {
    const audio = remoteAudioRef.current;
    if (!audio) return;
    setSoundBlocked(false);
    void audio.play().catch(() => toast.error("Your browser is still blocking the call audio."));
  }

  function handleEndCall() {
    session.hangUp();
    onClose(secondsRef.current);
  }

  // A call you cannot see out of the way is a call you leave running. Minimising
  // keeps this component (and therefore the peer connection, the timer and the
  // unread chat) mounted, and swaps the sheet for a corner pill.
  if (minimized) {
    return (
      <div className="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/95 py-2 pl-2 pr-3 text-white shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-4">
        <button
          onClick={() => setMinimized(false)}
          aria-label="Return to the call"
          title="Return to the call"
          className="relative cursor-pointer"
        >
          <Avatar
            name={partner.display_name}
            src={partner.avatar_url}
            className="h-9 w-9 ring-2 ring-emerald-400/70"
          />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
        <CallDuration
          running={connected}
          tickRef={secondsRef}
          className="font-mono text-xs text-white/85"
        />
        <button
          onClick={() => session.setMicEnabled(!session.micOn)}
          aria-label={session.micOn ? "Mute microphone" : "Unmute microphone"}
          className={cn(
            "rounded-full p-1.5 transition-colors cursor-pointer",
            session.micOn ? "text-white/80 hover:bg-white/10" : "bg-rose-500 text-white",
          )}
        >
          {session.micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </button>
        <button
          onClick={handleEndCall}
          aria-label="End call"
          title="Hang up"
          className="rounded-full bg-rose-600 p-1.5 text-white hover:bg-rose-700 transition-colors cursor-pointer"
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-in fade-in duration-200",
        !isOpen && "hidden",
      )}
    >
      <div
        className="glass-panel relative flex flex-col justify-between h-[85dvh] max-h-[680px] w-full max-w-md overflow-hidden rounded-3xl p-5 shadow-2xl bg-gradient-to-b from-slate-900 via-slate-950 to-black text-white border border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Reactions float over the call for both people */}
        <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
          {reactions.map((r) => (
            <span
              key={r.id}
              style={{ left: `${r.left}%` }}
              className="absolute bottom-20 text-3xl animate-in fade-in slide-in-from-bottom-8 duration-1000 -translate-y-36 opacity-90"
            >
              {r.emoji}
            </span>
          ))}
        </div>

        {/* Remote audio: the only thing that plays sound in the call */}
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

        {/* Top Header */}
        <div className="flex items-center justify-between gap-2 z-20">
          <div className="flex min-w-0 items-center gap-2">
            {/* What kind of call this is right now — a voice call that grew a
                camera says so here instead of leaving the user to infer it. */}
            <span
              title={hasVideo ? "Video call" : "Voice call"}
              className="flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-[11px] font-bold text-white/80"
            >
              {hasVideo ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
              {hasVideo ? "Video" : "Voice"}
            </span>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold border",
                connected
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  : session.connection === "failed"
                    ? "bg-rose-500/20 text-rose-300 border-rose-500/30"
                    : "bg-amber-500/20 text-amber-300 border-amber-500/30",
              )}
            >
              <span className="relative flex h-2 w-2">
                {connected && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                )}
                <span
                  className={cn(
                    "relative inline-flex h-2 w-2 rounded-full",
                    connected
                      ? "bg-emerald-400"
                      : session.connection === "failed"
                        ? "bg-rose-400"
                        : "bg-amber-400",
                  )}
                />
              </span>
              {statusLabel}
            </span>
            {/* Measured, not claimed: the badge appears only once the DTLS
                handshake reports a negotiated cipher, so it can never promise
                encryption on a call that has not finished setting it up. Icon
                only — the header has to stay readable on a phone. */}
            {session.mediaEncrypted && (
              <span
                title="Call audio and video are encrypted end to end (DTLS-SRTP)"
                aria-label="Call is encrypted end to end"
                className="flex shrink-0 items-center justify-center rounded-full bg-emerald-500/15 p-1 text-emerald-300"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
              </span>
            )}
            {session.quality !== "unknown" && session.quality !== "good" && (
              <span
                title={`Link quality: ${QUALITY_LABEL[session.quality]}`}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold",
                  session.quality === "poor" ? "bg-rose-500/25 text-rose-200" : "bg-white/15",
                )}
              >
                {session.quality === "poor" ? (
                  <WifiOff className="h-3 w-3" />
                ) : (
                  <Wifi
                    className={cn(
                      "h-3 w-3",
                      session.quality === "fair" ? "text-amber-300" : "text-emerald-400",
                    )}
                  />
                )}
                {QUALITY_LABEL[session.quality]}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CallDuration
              running={connected}
              tickRef={secondsRef}
              className="font-mono text-xs font-semibold text-white/95 bg-white/20 px-2.5 py-1 rounded-full"
            />
            {connected && (
              <button
                onClick={() => setMinimized(true)}
                aria-label="Minimise call"
                title="Minimise — the call keeps running"
                className="rounded-full bg-white/15 p-1.5 text-white/90 transition-colors hover:bg-white/25 cursor-pointer"
              >
                <Minimize2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Autoplay is a browser policy, not a broken call — say so once. Hidden
            while the speaker button is off: the banner would offer to enable
            sound the viewer just chose to silence. */}
        {soundBlocked && soundOn && (
          <button
            onClick={unlockSound}
            className="z-20 mt-3 flex items-center justify-center gap-2 rounded-xl bg-amber-500/90 px-3 py-2 text-xs font-bold text-black transition-transform hover:scale-[1.01] cursor-pointer"
          >
            <Volume2 className="h-4 w-4" /> Tap to enable sound
          </button>
        )}

        {/* Being muted without noticing is the most common way a call goes quiet,
            and a small red circle among six is easy to miss while you are looking
            at the other person. So the reminder goes across the top of the stage
            and is the gesture that fixes it. */}
        {!session.micOn && (
          <button
            onClick={() => session.setMicEnabled(true)}
            className="z-20 mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/85 px-3 py-2 text-xs font-bold text-white transition-transform hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
          >
            <MicOff className="h-4 w-4" /> You're muted — tap to speak
          </button>
        )}

        {/* Center Call Area */}
        <div className="my-auto relative flex flex-col items-center justify-center text-center w-full z-10 min-h-0">
          {/* The remote <video> is mounted for the whole call and only hidden with
              CSS when the avatar is showing. Unmounting it used to tear the element
              down and build a new one each time the far side switched camera, share
              or lens cover — a black card for a few hundred milliseconds, which is
              exactly the flickering people reported. */}
          <div
            className={cn(
              "relative w-full overflow-hidden rounded-2xl border border-white/10 bg-black",
              // Fullscreen means fullscreen: the pane is fixed at h-64 on the
              // card, so without this the "expanded" screen is a small video
              // floating in black. The corner radius/border also read oddly at
              // arm's-length from a monitor edge.
              "[&:fullscreen_video]:h-full [&:fullscreen]:rounded-none [&:fullscreen]:border-0",
              pane === "avatar" && !framedPane && "hidden",
            )}
          >
            <video
              ref={attachRemoteVideo}
              autoPlay
              playsInline
              muted
              className="h-64 w-full bg-black object-contain"
            />
            {/* On a video call whose lens is covered, the avatar sits *inside* the
                frame instead of replacing it. The picture is already decoding
                underneath, so their camera arriving is one cross-fade rather than
                a teardown, a remount and a black beat in between. */}
            {pane === "avatar" && framedPane && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-slate-900/85 backdrop-blur-sm transition-opacity duration-300">
                <Avatar
                  name={partner.display_name}
                  src={partner.avatar_url}
                  className="h-20 w-20 text-2xl ring-2 ring-white/20"
                />
                <p className="text-xs font-semibold text-white/75">
                  {peerMedia.camera ? "Starting their camera…" : "Their camera is off"}
                </p>
              </div>
            )}
            <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/65 px-2 py-0.5 text-[10px] font-bold text-white/90">
              {pane === "screen" && <Monitor className="h-3 w-3 text-indigo-300" />}
              {pane === "screen" ? `${partner.display_name}'s screen` : partner.display_name}
            </span>
            {/* Their mute belongs on their picture, not only on the avatar: a
                person waving at a frozen mouth has nothing else telling them the
                microphone is the problem. */}
            {peerMedia.muted && (
              <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-rose-500/85 px-1.5 py-0.5 text-[10px] font-bold text-white">
                <MicOff className="h-3 w-3" /> Muted
              </span>
            )}
            {type === "audio" && pane === "screen" && (
              <span className="absolute top-14 right-2 rounded-md bg-indigo-600/90 px-2 py-0.5 text-[10px] font-bold">
                Screen share
              </span>
            )}
            <button
              onClick={() => {
                const el = remoteVideoRef.current;
                if (!el) return;
                if (document.pictureInPictureElement)
                  void document.exitPictureInPicture().catch(() => {});
                else void el.requestPictureInPicture?.().catch(() => undefined);
              }}
              aria-label={isPip ? "Close picture-in-picture" : "Pop the video out"}
              title={isPip ? "Close picture-in-picture" : "Pop the video out (picture-in-picture)"}
              className={cn(
                "absolute top-2 left-2 rounded-md p-1.5 transition-colors cursor-pointer",
                isPip ? "bg-brand text-white" : "bg-black/60 text-white/90 hover:bg-black/80",
              )}
            >
              <PictureInPicture2 className="h-3.5 w-3.5" />
            </button>
            {/* A shared slide or spreadsheet wants the whole screen. */}
            <button
              onClick={() => {
                const host = remoteVideoRef.current?.parentElement;
                if (!host) return;
                if (document.fullscreenElement === host)
                  void document.exitFullscreen().catch(() => {});
                else void host.requestFullscreen?.().catch(() => undefined);
              }}
              aria-label={isFullscreen ? "Exit fullscreen" : "Toggle fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              className={cn(
                "absolute top-2 right-2 rounded-md p-1.5 transition-colors cursor-pointer",
                isFullscreen
                  ? "bg-brand text-white"
                  : "bg-black/60 text-white/90 hover:bg-black/80",
              )}
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {pane === "avatar" && !framedPane && (
            <div className="relative flex flex-col items-center">
              <div className="relative flex items-center justify-center">
                <div className="absolute -inset-4 rounded-full bg-gradient-to-r from-brand/30 via-brand-pink/30 to-brand-orange/30 blur-xl animate-pulse" />
                <div className="relative rounded-full p-2 ring-4 ring-brand/40 shadow-glow">
                  <Avatar
                    name={partner.display_name}
                    src={partner.avatar_url}
                    className="h-28 w-28 text-3xl ring-4 ring-white/20 shadow-2xl"
                  />
                </div>
                <span className="absolute -bottom-1 -right-1 rounded-full bg-emerald-500 p-2 text-white shadow-md ring-2 ring-slate-950">
                  <Volume2 className="h-4 w-4 animate-pulse" />
                </span>
              </div>

              <h3 className="mt-5 text-xl font-extrabold tracking-tight">{partner.display_name}</h3>
              <p className="text-xs text-white/85 mt-1">
                @{partner.username} · {statusLabel}
              </p>
              {peerMedia.muted && (
                <p className="mt-2 rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold text-white/85">
                  Their microphone is off
                </p>
              )}
            </div>
          )}

          {/* Self tile: the camera normally, your own desktop while sharing. One
              element for both, so stopping a share does not rebuild the preview.
              It only exists while there is a picture to show — a voice call gets no
              black rectangle and no "Camera off" notice, just the clean avatar. */}
          {showSelfTile && (
            <div className="absolute right-2 -bottom-2 w-28 h-36 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-black animate-in zoom-in duration-200">
              <video
                ref={attachSelfVideo}
                autoPlay
                playsInline
                muted
                className={cn(
                  "h-full w-full object-cover",
                  // Your desktop is not a selfie: a mirrored spreadsheet is unreadable.
                  !session.sharing && "scale-x-[-1]",
                )}
              />
              <span className="absolute bottom-1.5 left-1.5 text-[10px] font-bold bg-black/60 px-1.5 py-0.5 rounded-md text-white/90">
                {session.sharing ? "Your screen" : "You"}
              </span>
            </div>
          )}

          {/* In-call chat: real messages over the call's private channel */}
          {showChat && (
            <div className="absolute inset-0 flex flex-col justify-between rounded-2xl border border-white/10 bg-slate-950/95 p-4 animate-in fade-in">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="flex items-center gap-1.5 text-xs font-bold">
                  <MessageSquare className="h-3.5 w-3.5 text-brand" /> Chat with{" "}
                  {partner.display_name}
                </span>
                <button
                  onClick={() => setShowChat(false)}
                  className="text-xs text-white/70 hover:text-white cursor-pointer"
                >
                  Close
                </button>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto py-2 text-left">
                {messages.length === 0 ? (
                  <p className="mt-6 text-center text-xs text-white/60">
                    Say something — it reaches them while you're connected.
                  </p>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={cn(
                        "max-w-[85%] rounded-xl p-2 text-xs",
                        m.mine ? "ml-auto bg-brand/40 text-right" : "bg-white/15",
                      )}
                    >
                      <p className="text-[10px] text-white/70">
                        {m.mine ? "You" : partner.username}
                      </p>
                      <p className="whitespace-pre-wrap break-words">{m.text}</p>
                    </div>
                  ))
                )}
              </div>
              <div className="flex items-center gap-2 border-t border-white/10 pt-2">
                <input
                  type="text"
                  value={noteDraft}
                  maxLength={MAX_CALL_CHAT_CHARS}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      sendNote();
                    }
                  }}
                  placeholder="Type a message..."
                  className="flex-1 rounded-full bg-white/15 px-3 py-1.5 text-xs text-white outline-none placeholder:text-white/50 focus:ring-2 focus:ring-brand/60"
                />
                <button
                  onClick={sendNote}
                  aria-label="Send message"
                  className="rounded-full bg-brand p-1.5 text-white transition-transform active:scale-95 cursor-pointer"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="pt-1 text-center text-[10px] text-white/45">
                In-call messages aren't saved to your chat history.
              </p>
            </div>
          )}

          {/* Device picker */}
          {showDevices && (
            <div className="absolute inset-x-0 top-0 z-30 max-h-full overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/97 p-4 text-left animate-in fade-in">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-bold">
                  <Settings2 className="h-3.5 w-3.5 text-brand" /> Devices
                </span>
                <button
                  onClick={() => setShowDevices(false)}
                  aria-label="Close device settings"
                  className="rounded-full p-1 text-white/70 hover:bg-white/10 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <DeviceGroup
                label="Microphone"
                items={microphones.map((d) => ({
                  id: d.deviceId,
                  label: d.label || "Microphone",
                  active: isLiveDevice(d.deviceId, session.activeDeviceIds.mic),
                }))}
                emptyLabel="No other microphones"
                onPick={(id) => {
                  void session.switchMicrophone(id);
                  toast.success("Microphone switched");
                }}
              />
              <DeviceGroup
                label="Camera"
                items={cameras.map((d) => ({
                  id: d.deviceId,
                  label: d.label || "Camera",
                  active: isLiveDevice(d.deviceId, session.activeDeviceIds.camera),
                }))}
                emptyLabel="No other cameras"
                onPick={(id) => {
                  void session.switchCamera(id);
                  toast.success("Camera switched");
                }}
              />
              <DeviceGroup
                label="Speaker"
                items={audioOutputs.map((d) => ({
                  id: d.deviceId,
                  label: d.label || (d.deviceId ? "Audio device" : "System default"),
                  active: activeSinkId === d.deviceId,
                }))}
                emptyLabel="This browser routes audio for you — use the system control"
                onPick={(id) => {
                  setOutputId(id);
                  setSoundOn(true);
                  toast.success("Audio output changed");
                }}
              />

              <label className="mt-3 block text-[11px] font-semibold text-white/70">
                Call volume
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => {
                    setVolume(Number(e.target.value));
                    setSoundOn(Number(e.target.value) > 0);
                  }}
                  className="mt-1 w-full accent-brand"
                />
              </label>
            </div>
          )}
        </div>

        {/* Quick Reactions Bar */}
        <div className="z-20 flex items-center justify-center gap-2 border-t border-white/10 py-2">
          {CALL_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => triggerReaction(emoji)}
              className="cursor-pointer rounded-full bg-white/15 p-2 text-base transition-transform hover:bg-white/25 active:scale-125"
              title={`Send ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>

        {/* Call Controls */}
        <div className="z-20 flex items-center justify-center gap-2 border-t border-white/10 pt-3">
          <ControlButton
            label={session.micOn ? "Mute microphone" : "Unmute microphone"}
            hint={session.micOn ? "Mute" : "Unmute"}
            danger={!session.micOn}
            onClick={() => session.setMicEnabled(!session.micOn)}
          >
            {session.micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </ControlButton>

          {/* A video switch that is off should not read as an error on a call that
              was dialled for voice: the red paint is reserved for a video call that
              has lost its picture. */}
          <ControlButton
            label={session.cameraOn ? "Turn off camera" : "Turn on camera"}
            hint={session.cameraOn ? "Video on" : "Video off"}
            danger={type === "video" && !session.cameraOn && !session.sharing}
            active={session.cameraOn}
            onClick={() => void session.setCameraEnabled(!session.cameraOn)}
          >
            {session.cameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </ControlButton>

          <ControlButton
            label={
              session.canShareScreen
                ? session.sharing
                  ? "Stop sharing screen"
                  : "Share your screen"
                : "This browser can't share your screen"
            }
            hint={session.sharing ? "Sharing" : "Not sharing"}
            active={session.sharing}
            disabled={!session.canShareScreen}
            onClick={() => void toggleShare()}
          >
            <Monitor className="h-5 w-5" />
          </ControlButton>

          <ControlButton
            label="Open in-call chat"
            hint="Chat"
            active={showChat}
            badge={unread}
            onClick={() => setShowChat((open) => !open)}
          >
            <MessageSquare className="h-5 w-5" />
          </ControlButton>

          <ControlButton
            label={soundOn ? "Silence the call" : "Unsilence the call"}
            hint={soundOn ? (routingAvailable ? "Speaker" : "Sound on") : "Silenced"}
            danger={!soundOn}
            onClick={() => setSoundOn((on) => !on)}
          >
            {soundOn ? <Speaker className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
          </ControlButton>

          <ControlButton
            label="Device settings"
            hint="Devices"
            active={showDevices}
            onClick={() => setShowDevices((open) => !open)}
          >
            <Settings2 className="h-5 w-5" />
          </ControlButton>

          <button
            onClick={handleEndCall}
            aria-label="End call"
            title="Hang up"
            className="rounded-full bg-rose-600 p-3.5 text-white shadow-lg shadow-rose-600/40 transition-all hover:bg-rose-700 active:scale-95 cursor-pointer"
          >
            <PhoneOff className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  children,
  label,
  hint,
  onClick,
  active,
  danger,
  badge,
  disabled,
}: {
  children: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  badge?: number;
  disabled?: boolean;
}) {
  const tone = disabled
    ? "cursor-not-allowed bg-white/5 text-white/35 ring-1 ring-white/10"
    : danger
      ? "bg-rose-500 text-white cursor-pointer"
      : active
        ? "bg-indigo-600 text-white ring-1 ring-indigo-300/50 cursor-pointer"
        : "bg-white/20 text-white ring-1 ring-white/30 hover:bg-white/30 cursor-pointer";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full backdrop-blur-md transition-all active:scale-95",
        tone,
      )}
    >
      {children}
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white">
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
      <span className="sr-only">{hint}</span>
    </button>
  );
}

function DeviceGroup({
  label,
  items,
  emptyLabel,
  onPick,
}: {
  label: string;
  items: Array<{ id: string; label: string; active: boolean }>;
  emptyLabel: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/50">
        {label}
      </p>
      {items.length === 0 ? (
        <p className="text-[11px] text-white/45">{emptyLabel}</p>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <button
              key={item.id || item.label}
              onClick={() => onPick(item.id)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer",
                item.active ? "bg-white/20 font-semibold text-white" : "bg-white/5 text-white/80",
              )}
            >
              <span className="truncate">{item.label}</span>
              {item.active && <ChevronDown className="h-3.5 w-3.5 -rotate-90 opacity-70" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
