import { useState, useEffect, useRef } from "react";
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Sparkles,
  Volume2,
  VolumeX,
  Monitor,
  Heart,
  Flame,
  Laugh,
  ThumbsUp,
  MessageSquare,
  Send,
  Wifi,
} from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import { useCallSession } from "@/hooks/useCallSession";
import { type Profile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface CallModalProps {
  partner: Profile | null;
  type: "audio" | "video";
  isOpen: boolean;
  onClose: () => void;
  /** Id of the call row; when present the call is a real connected call. */
  callId?: string | null;
  role?: "caller" | "callee";
  /** "ringing" until the other person picks up, then "active". */
  callStatus?: "ringing" | "active";
}

export function CallModal({
  partner,
  type,
  isOpen,
  onClose,
  callId = null,
  role = "caller",
  callStatus = "active",
}: CallModalProps) {
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(type === "audio");
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [showInCallChat, setShowInCallChat] = useState(false);
  const [inCallNotes, setInCallNotes] = useState<string[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [reactions, setReactions] = useState<Array<{ id: string; emoji: string; left: number }>>(
    [],
  );
  const [noiseSuppression, setNoiseSuppression] = useState(true);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);

  const session = useCallSession({
    callId,
    role,
    kind: type,
    enabled: isOpen && Boolean(callId) && callStatus === "active",
  });

  const connected = session.connection === "connected";

  // Timer starts once the two sides are actually connected.
  useEffect(() => {
    if (!isOpen || !connected) {
      if (!isOpen) setSeconds(0);
      return undefined;
    }
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [isOpen, connected]);

  // Attach media streams to the elements.
  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = session.localStream;
    cameraTrackRef.current = session.localStream?.getVideoTracks()[0] ?? null;
  }, [session.localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = session.remoteStream;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = session.remoteStream;
  }, [session.remoteStream]);

  useEffect(() => {
    if (session.mediaError) toast.error(session.mediaError);
  }, [session.mediaError]);

  useEffect(() => {
    session.setMicEnabled(!muted);
  }, [muted, session]);

  useEffect(() => {
    session.setCameraEnabled(!videoOff);
  }, [videoOff, session]);

  useEffect(() => {
    if (remoteAudioRef.current) remoteAudioRef.current.muted = !isSpeakerOn;
  }, [isSpeakerOn]);

  const handleEndCall = () => {
    session.hangUp();
    onClose();
  };

  if (!isOpen || !partner) return null;

  const formattedTime = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;

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

  const hasRemoteVideo = (session.remoteStream?.getVideoTracks().length ?? 0) > 0;

  function triggerReaction(emoji: string) {
    const id = `react_${Date.now()}_${Math.random()}`;
    const left = Math.floor(Math.random() * 60) + 20;
    setReactions((prev) => [...prev, { id, emoji, left }]);
    setTimeout(() => {
      setReactions((prev) => prev.filter((r) => r.id !== id));
    }, 2000);
  }

  async function handleToggleScreenShare() {
    if (isScreenSharing) {
      await session.replaceVideoTrack(cameraTrackRef.current);
      setIsScreenSharing(false);
      toast.info("Screen sharing ended");
      return;
    }
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        toast.error("Screen sharing isn't supported in this browser.");
        return;
      }
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = displayStream.getVideoTracks()[0];
      if (!track) return;
      await session.replaceVideoTrack(track);
      setIsScreenSharing(true);
      toast.success("Sharing your screen");
      track.onended = () => {
        void session.replaceVideoTrack(cameraTrackRef.current);
        setIsScreenSharing(false);
      };
    } catch {
      // user cancelled the picker
    }
  }

  function handleSendNote() {
    if (!noteDraft.trim()) return;
    setInCallNotes((prev) => [...prev, noteDraft.trim()]);
    setNoteDraft("");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div
        className="glass-panel relative flex flex-col justify-between h-[85vh] max-h-[640px] w-full max-w-md overflow-hidden rounded-3xl p-5 shadow-2xl bg-gradient-to-b from-slate-900 via-slate-950 to-black text-white border border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Floating live reaction hearts/emojis */}
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

        {/* Remote audio always plays, even on an audio-only call */}
        {session.remoteStream && (
          <audio
            ref={(el) => {
              (remoteAudioRef as any).current = el;
              if (el) el.srcObject = session.remoteStream;
            }}
            autoPlay
            playsInline
            className="hidden"
          />
        )}

        {/* Top Header */}
        <div className="flex items-center justify-between z-20">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold border",
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
            <span className="flex items-center gap-1 text-[11px] text-white/85 bg-white/20 px-2 py-0.5 rounded-full">
              <Wifi className="h-3 w-3 text-emerald-400" /> {type === "video" ? "Video" : "Audio"}
            </span>
          </div>
          <span className="font-mono text-xs font-semibold text-white/95 bg-white/20 px-2.5 py-1 rounded-full">
            {formattedTime}
          </span>
        </div>

        {/* Center Calling Area */}
        <div className="my-auto relative flex flex-col items-center justify-center text-center w-full z-10">
          {/* Remote video when the other person has their camera on */}
          {type === "video" && hasRemoteVideo && session.remoteStream ? (
            <div className="relative w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
              <video
                ref={(el) => {
                  (remoteVideoRef as any).current = el;
                  if (el) el.srcObject = session.remoteStream;
                }}
                autoPlay
                playsInline
                className="h-64 w-full object-cover"
              />
              <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white/90">
                {partner.display_name}
              </span>
            </div>
          ) : (
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
            </div>
          )}

          {/* Self Camera Inset (if video active) */}
          {!videoOff && session.localStream && (
            <div className="absolute right-2 bottom-0 w-28 h-36 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-black animate-in zoom-in duration-200">
              <video
                ref={(el) => {
                  (localVideoRef as any).current = el;
                  if (el) el.srcObject = session.localStream;
                }}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
              <span className="absolute bottom-1.5 left-1.5 text-[10px] font-bold bg-black/60 px-1.5 py-0.5 rounded-md text-white/90">
                You
              </span>
            </div>
          )}

          {/* In-Call Quick Notes/Chat Overlay */}
          {showInCallChat && (
            <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md rounded-2xl p-4 flex flex-col justify-between border border-white/10 animate-in fade-in">
              <div className="flex items-center justify-between pb-2 border-b border-white/10">
                <span className="text-xs font-bold flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5 text-brand" /> Quick In-Call Chat
                </span>
                <button
                  onClick={() => setShowInCallChat(false)}
                  className="text-xs text-white/85 hover:text-white"
                >
                  Close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 py-2 text-left">
                <div className="rounded-xl bg-white/20 p-2 text-xs">
                  <p className="text-white/85 text-[10px]">@{partner.username}</p>
                  <p>Audio is super clear!</p>
                </div>
                {inCallNotes.map((n, i) => (
                  <div key={i} className="rounded-xl bg-brand/30 p-2 text-xs text-right">
                    <p className="text-white/85 text-[10px]">You</p>
                    <p>{n}</p>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-white/10">
                <input
                  type="text"
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendNote()}
                  placeholder="Type a message..."
                  className="flex-1 bg-white/20 rounded-full px-3 py-1.5 text-xs text-white placeholder:text-white/70 outline-none"
                />
                <button onClick={handleSendNote} className="p-1.5 rounded-full bg-brand text-white">
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Quick Reactions Bar */}
        <div className="flex items-center justify-center gap-2 py-2 border-t border-white/10 z-20">
          {[
            { emoji: "❤️", icon: Heart },
            { emoji: "🔥", icon: Flame },
            { emoji: "👏", label: "Clap" },
            { emoji: "😂", icon: Laugh },
            { emoji: "👍", icon: ThumbsUp },
          ].map((item, idx) => (
            <button
              key={idx}
              onClick={() => triggerReaction(item.emoji)}
              className="rounded-full bg-white/20 hover:bg-white/20 p-2 text-base transition-transform active:scale-125 cursor-pointer"
              title={`Send ${item.emoji}`}
            >
              {item.emoji}
            </button>
          ))}
        </div>

        {/* Bottom Call Controls */}
        <div className="flex items-center justify-center gap-3 pt-3 border-t border-white/10 z-20">
          {/* Mute Mic */}
          <button
            onClick={() => setMuted(!muted)}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            className={cn(
              "rounded-full p-3.5 backdrop-blur-md transition-all active:scale-95 shadow-md cursor-pointer",
              muted
                ? "bg-rose-500 text-white"
                : "bg-white/25 text-white ring-1 ring-white/40 hover:bg-white/40",
            )}
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
          </button>

          {/* Toggle Video */}
          <button
            onClick={() => setVideoOff(!videoOff)}
            aria-label={videoOff ? "Turn on camera" : "Turn off camera"}
            className={cn(
              "rounded-full p-3.5 backdrop-blur-md transition-all active:scale-95 shadow-md cursor-pointer",
              videoOff
                ? "bg-rose-500 text-white"
                : "bg-white/25 text-white ring-1 ring-white/40 hover:bg-white/40",
            )}
            title={videoOff ? "Turn on video" : "Turn off video"}
          >
            {videoOff ? <VideoOff className="h-6 w-6" /> : <Video className="h-6 w-6" />}
          </button>

          {/* Screen Share */}
          <button
            onClick={handleToggleScreenShare}
            aria-label="Share screen"
            className={cn(
              "rounded-full p-3.5 backdrop-blur-md transition-all active:scale-95 shadow-md cursor-pointer",
              isScreenSharing
                ? "bg-indigo-600 text-white"
                : "bg-white/25 text-white ring-1 ring-white/40 hover:bg-white/40",
            )}
            title={isScreenSharing ? "Stop sharing" : "Share screen"}
          >
            <Monitor className="h-6 w-6" />
          </button>

          {/* Chat Toggle */}
          <button
            onClick={() => setShowInCallChat(!showInCallChat)}
            aria-label="Open in-call chat"
            className={cn(
              "rounded-full p-3.5 backdrop-blur-md transition-all active:scale-95 shadow-md cursor-pointer",
              showInCallChat
                ? "bg-brand text-white"
                : "bg-white/25 text-white ring-1 ring-white/40 hover:bg-white/40",
            )}
            title="In-call chat"
          >
            <MessageSquare className="h-6 w-6" />
          </button>

          {/* Speaker Toggle */}
          <button
            onClick={() => {
              setIsSpeakerOn(!isSpeakerOn);
              toast(isSpeakerOn ? "Audio routed to earpiece" : "Speakerphone enabled");
            }}
            aria-label="Toggle speaker"
            className={cn(
              "rounded-full p-3.5 backdrop-blur-md transition-all active:scale-95 shadow-md cursor-pointer",
              !isSpeakerOn
                ? "bg-amber-500 text-white"
                : "bg-white/25 text-white ring-1 ring-white/40 hover:bg-white/40",
            )}
            title={isSpeakerOn ? "Speaker ON" : "Speaker OFF"}
          >
            {isSpeakerOn ? <Volume2 className="h-6 w-6" /> : <VolumeX className="h-6 w-6" />}
          </button>

          {/* End Call */}
          <button
            onClick={handleEndCall}
            aria-label="End call"
            className="rounded-full bg-rose-600 hover:bg-rose-700 p-3.5 text-white transition-all active:scale-95 shadow-lg shadow-rose-600/40 cursor-pointer"
            title="Hang up"
          >
            <PhoneOff className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  );
}
