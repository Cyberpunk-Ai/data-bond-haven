import { useState, useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import {
  Mic,
  MicOff,
  Hand,
  X,
  Sparkles,
  Send,
  Users,
  MessageSquare,
  Headphones,
  Volume2,
  Loader2,
  Shield,
  Heart,
  DollarSign,
  Crown,
  UserPlus,
  UserMinus,
  Radio,
  Disc3,
  Pin,
  AlertTriangle,
} from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import { TipModal } from "@/components/social/TipModal";
import type { Space, Profile } from "@/lib/types";
import { currentUser, getProfile } from "@/lib/profile-service";
import { useSpaceAudio } from "@/hooks/useSpaceAudio";
import {
  joinSpace,
  getSpaceRoom,
  setSpaceParticipantRole,
  leaveSpace,
  toggleSpeaking,
  toggleHandRaised,
  sendSpaceMessage,
  endSpace,
  summarizeSpaceAI,
} from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { ClampText } from "@/components/social/ClampText";
import { toast } from "sonner";

interface SpaceRoomModalProps {
  space: Space | null;
  isOpen: boolean;
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  userId: string;
  body: string;
  timestamp: string;
  isTip?: boolean;
  tipAmount?: number;
}

interface LiveTipAlert {
  id: string;
  senderName: string;
  amount: number;
  message?: string;
}

export function SpaceRoomModal({ space, isOpen, onClose }: SpaceRoomModalProps) {
  if (!isOpen || !space) return null;
  return <SpaceRoomModalContent space={space} onClose={onClose} />;
}

function SpaceRoomModalContent({ space, onClose }: { space: Space; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<"stage" | "chat" | "requests">("stage");
  const [chatDraft, setChatDraft] = useState("");
  const [isMuted, setIsMuted] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary] = useState<{ summary: string; keyTakeaways: string[] } | null>(null);
  const [floatingReactions, setFloatingReactions] = useState<
    { id: string; emoji: string; left: number }[]
  >([]);
  const [activeTipAlert, setActiveTipAlert] = useState<LiveTipAlert | null>(null);
  const [isRecordingSpace, setIsRecordingSpace] = useState(true);
  const [showEndConfirmation, setShowEndConfirmation] = useState(false);
  const [pinnedTopic, setPinnedTopic] = useState<string>(
    "Welcome to the Space! Feel free to ask questions in chat or raise your hand.",
  );

  // Tipping state
  const [tipTargetUser, setTipTargetUser] = useState<{
    username: string;
    display_name: string;
    avatar_url?: string | null;
    plan?: string | null;
  } | null>(null);

  const [participants, setParticipants] = useState<
    {
      id: string;
      role: "host" | "speaker" | "listener";
      isSpeaking?: boolean;
      isMuted?: boolean;
      handRaised?: boolean;
      display_name: string;
      username: string;
      avatar_url?: string;
    }[]
  >([]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const host = getProfile(space.host_id);
  const isCurrentUserHost = space.host_id === currentUser.id;

  // Load the room from the backend: who is here and what has been said.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      type RoomParticipant = {
        id: string;
        role: "host" | "speaker" | "listener";
        isSpeaking: boolean;
        isMuted: boolean;
        handRaised: boolean;
      };
      type RoomMessage = { id: string; userId: string; body: string; created_at: string };
      let loaded: { participants: RoomParticipant[]; messages: RoomMessage[] } = {
        participants: [],
        messages: [],
      };
      try {
        await joinSpace(space.id);
        loaded = await getSpaceRoom(space.id);
      } catch {
        /* offline: fall back to just me */
      }
      if (cancelled) return;

      const seen = new Set<string>();
      const list = loaded.participants
        .filter((p: RoomParticipant) => {
          if (!p?.id || seen.has(p.id)) return false;
          seen.add(p.id);
          return true;
        })
        .map((p: RoomParticipant) => {
          const profile = getProfile(p.id);
          return {
            id: p.id,
            role: p.id === space.host_id ? ("host" as const) : p.role,
            isSpeaking: p.isSpeaking,
            isMuted: p.isMuted,
            handRaised: p.handRaised,
            display_name: profile.display_name,
            username: profile.username,
            avatar_url: profile.avatar_url || undefined,
          };
        });

      if (!seen.has(currentUser.id)) {
        list.push({
          id: currentUser.id,
          role: isCurrentUserHost ? "host" : "listener",
          isSpeaking: false,
          isMuted: true,
          handRaised: false,
          display_name: currentUser.display_name,
          username: currentUser.username,
          avatar_url: currentUser.avatar_url || undefined,
        });
      }

      setParticipants(list);
      setMessages(
        loaded.messages.map((m: RoomMessage) => ({
          id: m.id,
          userId: m.userId,
          body: m.body,
          timestamp: m.created_at,
        })),
      );
    })();

    return () => {
      cancelled = true;
      leaveSpace(space.id).catch(() => {});
    };
  }, [space.id]);

  // Real-time events
  useRealtime(
    (event) => {
      if (event.type === "space:message" || event.type === "space_chat_message") {
        const msg = event.message || event.data;
        const msgSpace = event.spaceId || msg?.spaceId;
        if (msgSpace && msgSpace !== space.id) return;
        if (msg && msg.userId === currentUser.id) return;
        if (msg) {
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id)
              ? prev
              : [
                  ...prev,
                  {
                    id: msg.id || `msg_${Date.now()}`,
                    userId: msg.userId || msg.user_id,
                    body: msg.body || msg.content,
                    timestamp: "Just now",
                  },
                ],
          );
        }
      } else if (event.type === "space:tip" || event.type === "space_tip") {
        const tip = event.tip || event.data;
        if (tip) {
          setActiveTipAlert({
            id: tip.id || `tip_${Date.now()}`,
            senderName: tip.sender_name || "A listener",
            amount: tip.amount || 5,
            message: tip.message,
          });
          setMessages((prev) => [
            ...prev,
            {
              id: `tip_msg_${Date.now()}`,
              userId: tip.sender_id || "u_tip",
              body: `🎉 Tipped $${(tip.amount || 0).toFixed(2)}${tip.message ? `: “${tip.message}”` : " to the stage!"}`,
              timestamp: "Just now",
              isTip: true,
              tipAmount: tip.amount,
            },
          ]);
          triggerReaction("💰");
          setTimeout(() => setActiveTipAlert(null), 6000);
        }
      } else if (event.type === "space:speaking" || event.type === "speaking_state") {
        const data = event.data || event;
        if (data && data.userId) {
          setParticipants((prev) =>
            prev.map((p) =>
              p.id === data.userId
                ? {
                    ...p,
                    isSpeaking: !!(data.isSpeaking ?? data.speaking),
                    isMuted: !!(data.isMuted ?? data.muted),
                  }
                : p,
            ),
          );
        }
      } else if (event.type === "space:hand" || event.type === "hand_raised") {
        const data = event.data || event;
        if (data && data.userId && data.userId !== currentUser.id) {
          const user = getProfile(data.userId);
          toast.info(`${user.display_name} raised their hand!`);
          setParticipants((prev) =>
            prev.map((p) =>
              p.id === data.userId ? { ...p, handRaised: data.raised !== false } : p,
            ),
          );
        }
      } else if (event.type === "space:role") {
        const data = event.data || event;
        if (data && data.userId) {
          setParticipants((prev) =>
            prev.map((p) =>
              p.id === data.userId ? { ...p, role: data.role, handRaised: false } : p,
            ),
          );
        }
      } else if (event.type === "space:left" || event.type === "participant_left") {
        const data = event.data || event;
        if (data && data.userId) {
          setParticipants((prev) => prev.filter((p) => p.id !== data.userId));
        }
      }
    },
    [
      "space:message",
      "space:speaking",
      "space:hand",
      "space:role",
      "space:joined",
      "space:left",
      "space:tip",
    ],
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const triggerReaction = (emoji: string) => {
    const newReaction = {
      id: Math.random().toString(),
      emoji,
      left: Math.floor(Math.random() * 70) + 15,
    };
    setFloatingReactions((prev) => [...prev, newReaction]);
    setTimeout(() => {
      setFloatingReactions((prev) => prev.filter((r) => r.id !== newReaction.id));
    }, 2000);
  };

  async function handleToggleMic() {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    setIsSpeaking(!nextMuted);

    setParticipants((prev) =>
      prev.map((p) =>
        p.id === currentUser.id
          ? {
              ...p,
              isMuted: nextMuted,
              isSpeaking: !nextMuted,
              role: nextMuted ? p.role : "speaker",
            }
          : p,
      ),
    );

    try {
      await toggleSpeaking(space.id, !nextMuted, nextMuted);
    } catch {}

    toast(nextMuted ? "Microphone muted" : "You are now on stage speaking!");
  }

  async function handleToggleHand() {
    const nextRaised = !handRaised;
    setHandRaised(nextRaised);
    try {
      await toggleHandRaised(space.id, nextRaised);
    } catch {}
    toast(nextRaised ? "Hand raised! Host will be notified." : "Hand lowered");
  }

  async function handleSendMessage() {
    if (!chatDraft.trim()) return;
    const newMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      userId: currentUser.id,
      body: chatDraft.trim(),
      timestamp: "Just now",
    };
    setMessages((prev) => [...prev, newMsg]);
    const text = chatDraft.trim();
    setChatDraft("");

    try {
      await sendSpaceMessage(space.id, text);
    } catch {}
  }

  const promoteToSpeaker = (userId: string) => {
    setParticipants((prev) =>
      prev.map((p) => (p.id === userId ? { ...p, role: "speaker", handRaised: false } : p)),
    );
    const target = getProfile(userId);
    void setSpeakerRole(userId, "speaker");
    toast.success(`Invited ${target.display_name} to speak!`);
  };

  const demoteToListener = (userId: string) => {
    setParticipants((prev) =>
      prev.map((p) =>
        p.id === userId ? { ...p, role: "listener", isSpeaking: false, isMuted: true } : p,
      ),
    );
    const target = getProfile(userId);
    void setSpeakerRole(userId, "listener");
    toast.info(`Moved ${target.display_name} to listeners`);
  };

  async function setSpeakerRole(userId: string, role: "speaker" | "listener") {
    try {
      await setSpaceParticipantRole(space.id, userId, role);
    } catch {
      toast.error("Couldn't save that change — try again.");
    }
  }

  async function handleSummarize() {
    setSummarizing(true);
    try {
      const res = await summarizeSpaceAI(
        space.title,
        space.topic,
        messages.map((m) => m.body),
      );
      setSummary(res);
    } catch (err: any) {
      toast.error(String(err?.message ?? "Couldn't summarize this room right now."));
    } finally {
      setSummarizing(false);
    }
  }

  const speakers = participants.filter((p) => p.role === "host" || p.role === "speaker");
  const listeners = participants.filter((p) => p.role === "listener");
  const myRole = participants.find((p) => p.id === currentUser.id)?.role ?? (isCurrentUserHost ? "host" : "listener");
  const audio = useSpaceAudio({
    spaceId: space.id,
    userId: currentUser.id,
    speaker: myRole !== "listener",
    muted: isMuted,
    enabled: true,
  });
  useEffect(() => {
    if (audio.status === "mic-blocked") toast.error("Microphone access was blocked. Allow it in your browser to speak.");
  }, [audio.status]);
  useEffect(() => {
    if (audio.overCapacity) toast.warning("This room is above the live-audio speaker limit; some speakers may not be heard.");
  }, [audio.overCapacity]);

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-2 sm:p-4 animate-in fade-in duration-200">
        <div
          className="glass-panel relative flex flex-col h-[95vh] sm:h-[90vh] max-h-[750px] w-full max-w-2xl overflow-hidden rounded-2xl sm:rounded-3xl border border-border/80 bg-card/95 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Top Header */}
          <div className="flex items-center justify-between border-b border-border/60 p-3 sm:p-4 gap-2">
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <span className="flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 sm:px-3 py-1 text-[11px] sm:text-xs font-bold text-rose-500 shrink-0">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
                </span>
                LIVE STAGE
              </span>
              <span className="truncate rounded-full bg-brand/10 px-2.5 sm:px-3 py-1 text-[11px] sm:text-xs font-bold text-brand">
                {space.topic}
              </span>
            </div>

            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              {/* Tip Host button */}
              <button
                type="button"
                onClick={() =>
                  setTipTargetUser({
                    username: host.username,
                    display_name: host.display_name,
                    avatar_url: host.avatar_url,
                    plan: host.plan,
                  })
                }
                className="flex items-center gap-1.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 px-2.5 sm:px-3 py-1.5 text-xs font-bold transition-all min-h-[36px]"
              >
                <DollarSign className="h-3.5 w-3.5" />
                <span>Tip Host</span>
              </button>

              <button
                onClick={handleSummarize}
                disabled={summarizing}
                className="flex items-center gap-1.5 rounded-full bg-foreground/5 hover:bg-foreground/10 px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition-all disabled:opacity-50 min-h-[36px]"
              >
                {summarizing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-brand" />
                )}
                <span className="hidden xs:inline">AI Summary</span>
              </button>
              <button
                onClick={onClose}
                className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Live Tip Banner Alert */}
          {activeTipAlert && (
            <div className="mx-4 sm:mx-6 mt-2 rounded-2xl bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-amber-500/20 border border-amber-500/40 p-2.5 sm:p-3 text-xs text-foreground flex items-center justify-between shadow-lg animate-in slide-in-from-top duration-300">
              <div className="flex items-center gap-2">
                <span className="p-1.5 rounded-full bg-amber-500 text-white font-bold">
                  <DollarSign className="h-3.5 w-3.5" />
                </span>
                <div>
                  <span className="font-bold text-amber-600 dark:text-amber-400">
                    {activeTipAlert.senderName} tipped ${activeTipAlert.amount.toFixed(2)}!
                  </span>
                  {activeTipAlert.message && (
                    <p className="text-[11px] text-muted-foreground italic truncate max-w-xs">
                      “{activeTipAlert.message}”
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setActiveTipAlert(null)}
                className="text-muted-foreground hover:text-foreground p-1"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Space Title & Info */}
          <div className="px-4 sm:px-6 pt-3 sm:pt-4 pb-2">
            <h2 className="text-lg sm:text-xl font-extrabold tracking-tight line-clamp-2">
              {space.title}
            </h2>
            <div className="flex flex-wrap items-center gap-2 sm:gap-4 mt-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Shield className="h-3.5 w-3.5 text-brand" /> Hosted by {host.display_name}
              </span>
              <span className="flex items-center gap-1">
                <Headphones className="h-3.5 w-3.5" /> {participants.length + space.listeners} in
                room
              </span>
            </div>
          </div>

          {/* Tab switcher */}
          <div className="flex px-4 sm:px-6 pt-2 border-b border-border/40 gap-4">
            <button
              onClick={() => setActiveTab("stage")}
              className={cn(
                "flex items-center gap-2 pb-2 text-xs sm:text-sm font-bold border-b-2 transition-all min-h-[36px] cursor-pointer",
                activeTab === "stage"
                  ? "border-brand text-brand"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Volume2 className="h-4 w-4" /> Stage ({speakers.length})
            </button>
            <button
              onClick={() => setActiveTab("chat")}
              className={cn(
                "flex items-center gap-2 pb-2 text-xs sm:text-sm font-bold border-b-2 transition-all min-h-[36px] cursor-pointer",
                activeTab === "chat"
                  ? "border-brand text-brand"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <MessageSquare className="h-4 w-4" /> Room Chat ({messages.length})
            </button>
            {isCurrentUserHost && (
              <button
                onClick={() => setActiveTab("requests")}
                className={cn(
                  "flex items-center gap-1.5 pb-2 text-xs sm:text-sm font-bold border-b-2 transition-all min-h-[36px] cursor-pointer",
                  activeTab === "requests"
                    ? "border-brand text-brand"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Hand className="h-4 w-4" />
                <span>Requests</span>
                {listeners.filter((p) => p.handRaised).length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-white text-[10px] font-black animate-pulse">
                    {listeners.filter((p) => p.handRaised).length}
                  </span>
                )}
              </button>
            )}
          </div>

          {/* AI Summary Banner */}
          {summary && (
            <div className="mx-4 sm:mx-6 mt-3 rounded-2xl bg-brand/10 border border-brand/20 p-3 sm:p-3.5 text-xs text-foreground space-y-1.5 animate-in fade-in">
              <div className="flex items-center justify-between font-bold text-brand">
                <span className="flex items-center gap-1">
                  <Sparkles className="h-3.5 w-3.5" /> Live AI Insights
                </span>
                <button
                  onClick={() => setSummary(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="leading-relaxed">{summary.summary}</p>
              {summary.keyTakeaways.length > 0 && (
                <ul className="list-disc list-inside space-y-0.5 pt-1 text-muted-foreground font-medium">
                  {summary.keyTakeaways.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Main Content Area */}
          <div className="relative flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 [scrollbar-width:thin]">
            {/* Floating Live Reactions */}
            {floatingReactions.map((r) => (
              <div
                key={r.id}
                style={{ left: `${r.left}%` }}
                className="pointer-events-none absolute bottom-4 z-50 text-2xl animate-in fade-in slide-in-from-bottom-6 duration-1000 select-none animate-bounce"
              >
                {r.emoji}
              </div>
            ))}

            {activeTab === "stage" ? (
              <div className="space-y-5 sm:space-y-6">
                {/* Speakers Section */}
                <div>
                  <div className="flex items-center justify-between mb-3 sm:mb-4">
                    <h3 className="text-[11px] sm:text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Speakers & Hosts
                    </h3>
                    <span className="text-[11px] text-muted-foreground">
                      Tap speaker to tip or view
                    </span>
                  </div>
                  <div className="grid grid-cols-2 xs:grid-cols-3 sm:grid-cols-4 gap-3 sm:gap-4">
                    {speakers.map((speaker, idx) => {
                      const isHost = speaker.id === space.host_id;
                      return (
                        <div
                          key={`stage-speaker-${speaker.id}-${idx}`}
                          className="flex flex-col items-center text-center group relative"
                        >
                          <div className="relative">
                            <div
                              className={cn(
                                "rounded-full p-1 transition-all duration-500",
                                (audio.speakingIds.has(speaker.id) || speaker.isSpeaking)
                                  ? "ring-4 ring-brand shadow-glow animate-pulse"
                                  : "ring-1 ring-border",
                              )}
                            >
                              <Avatar
                                name={speaker.display_name}
                                src={speaker.avatar_url}
                                className="h-14 w-14 sm:h-16 sm:w-16 text-sm sm:text-base"
                              />
                            </div>
                            {isHost && (
                              <span className="absolute -top-1 -right-1 rounded-full bg-amber-500 p-1 text-white shadow-xs">
                                <Crown className="h-3 w-3" />
                              </span>
                            )}
                            {speaker.isMuted ? (
                              <span className="absolute bottom-0 right-0 rounded-full bg-rose-500 p-1 text-white shadow-xs">
                                <MicOff className="h-3 w-3" />
                              </span>
                            ) : (
                              <span className="absolute bottom-0 right-0 rounded-full bg-emerald-500 p-1 text-white shadow-xs">
                                <Mic className="h-3 w-3" />
                              </span>
                            )}
                          </div>

                          <Link
                            to="/profile"
                            search={{ id: speaker.id, user: speaker.username }}
                            onClick={onClose}
                            className="mt-2 truncate w-full text-xs font-bold hover:text-brand transition-colors"
                          >
                            {speaker.display_name}
                          </Link>

                          {/* Sound wave / status indicator */}
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] text-muted-foreground capitalize">
                              {speaker.role}
                            </span>
                            {(audio.speakingIds.has(speaker.id) || speaker.isSpeaking) && (
                              <div className="flex items-center gap-0.5">
                                <span className="h-2 w-0.5 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="h-3.5 w-0.5 rounded-full bg-emerald-500 animate-bounce" />
                                <span className="h-2 w-0.5 rounded-full bg-emerald-500 animate-pulse" />
                              </div>
                            )}
                          </div>

                          {/* Speaker Quick Actions */}
                          <div className="flex items-center gap-1 mt-1.5">
                            {speaker.id !== currentUser.id && (
                              <button
                                type="button"
                                onClick={() =>
                                  setTipTargetUser({
                                    username: speaker.username,
                                    display_name: speaker.display_name,
                                    avatar_url: speaker.avatar_url,
                                  })
                                }
                                title={`Tip ${speaker.display_name}`}
                                className="px-2 py-0.5 rounded-full bg-amber-500/10 hover:bg-amber-500/25 text-[10px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-0.5 transition-colors"
                              >
                                <DollarSign className="h-2.5 w-2.5" /> Tip
                              </button>
                            )}
                            {isCurrentUserHost && speaker.id !== currentUser.id && (
                              <button
                                type="button"
                                onClick={() => demoteToListener(speaker.id)}
                                title="Demote to listener"
                                className="p-1 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-rose-500 transition-colors"
                              >
                                <UserMinus className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Listeners Section */}
                <div>
                  <h3 className="text-[11px] sm:text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3 sm:mb-4">
                    Listeners ({listeners.length + space.listeners})
                  </h3>
                  <div className="grid grid-cols-3 xs:grid-cols-4 sm:grid-cols-5 gap-2.5 sm:gap-3">
                    {listeners.map((listener, idx) => (
                      <div
                        key={`stage-listener-${listener.id}-${idx}`}
                        className="flex flex-col items-center text-center group"
                      >
                        <div className="relative">
                          <Avatar
                            name={listener.display_name}
                            src={listener.avatar_url}
                            className="h-10 w-10 sm:h-12 sm:w-12 text-[10px] sm:text-xs"
                          />
                          {listener.handRaised && (
                            <span className="absolute -top-1 -right-1 rounded-full bg-amber-500 p-1 text-white animate-bounce shadow-xs">
                              <Hand className="h-2.5 w-2.5" />
                            </span>
                          )}
                        </div>
                        <span className="mt-1.5 truncate w-full text-[10px] sm:text-[11px] font-medium text-muted-foreground">
                          {listener.display_name.split(" ")[0]}
                        </span>

                        {isCurrentUserHost && listener.id !== currentUser.id && (
                          <button
                            type="button"
                            onClick={() => promoteToSpeaker(listener.id)}
                            className="mt-1 px-2 py-0.5 rounded-full bg-brand/10 hover:bg-brand/20 text-[9px] font-bold text-brand flex items-center gap-0.5 transition-colors"
                          >
                            <UserPlus className="h-2.5 w-2.5" /> Invite
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : activeTab === "chat" ? (
              /* Chat Tab */
              <div className="flex flex-col h-full space-y-3">
                <div className="flex-1 space-y-3">
                  {messages.map((m) => {
                    const sender = getProfile(m.userId);
                    return (
                      <div
                        key={m.id}
                        className={cn(
                          "flex items-start gap-2.5 p-2 rounded-xl transition-all",
                          m.isTip ? "bg-amber-500/10 border border-amber-500/30" : "",
                        )}
                      >
                        <Avatar
                          name={sender.display_name}
                          src={sender.avatar_url}
                          className="h-7 w-7 text-[0.6rem] shrink-0 mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span
                              className={cn(
                                "text-xs font-bold",
                                m.isTip && "text-amber-600 dark:text-amber-400",
                              )}
                            >
                              {sender.display_name}
                            </span>
                            <span className="text-[10px] text-muted-foreground">{m.timestamp}</span>
                            {m.isTip && (
                              <span className="ml-auto text-[10px] font-extrabold text-amber-600 dark:text-amber-400 bg-amber-500/20 px-1.5 py-0.5 rounded-md">
                                TIP ${m.tipAmount?.toFixed(2)}
                              </span>
                            )}
                          </div>
                          <div
                            className={cn(
                              "text-xs mt-0.5 leading-relaxed",
                              m.isTip
                                ? "font-semibold text-foreground"
                                : "text-foreground/90 bg-foreground/5 p-2 rounded-xl",
                            )}
                          >
                            <ClampText text={m.body} lines={4} limit={240} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>

                {/* Chat Input */}
                <div className="flex gap-2 pt-2">
                  <input
                    type="text"
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                    placeholder="Share your thoughts in the room..."
                    className="flex-1 rounded-2xl bg-foreground/5 px-3.5 sm:px-4 py-2 text-xs outline-none border border-transparent focus:border-brand/40 min-h-[38px]"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={!chatDraft.trim()}
                    className="rounded-2xl bg-brand text-white px-3 py-2 hover:bg-brand/90 transition-all disabled:opacity-40 min-h-[38px] flex items-center justify-center cursor-pointer"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : (
              /* Host Hand Requests Queue */
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Audience Speaking Requests ({listeners.filter((p) => p.handRaised).length})
                </h3>
                {listeners.filter((p) => p.handRaised).length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground space-y-1">
                    <Hand className="h-8 w-8 mx-auto opacity-30" />
                    <p className="font-bold text-xs">No pending requests</p>
                    <p className="text-[11px]">
                      When listeners raise their hands to speak, they will appear here.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {listeners
                      .filter((p) => p.handRaised)
                      .map((req) => (
                        <div
                          key={req.id}
                          className="flex items-center justify-between p-3 rounded-2xl bg-card border border-border/80 shadow-xs"
                        >
                          <div className="flex items-center gap-2.5">
                            <Avatar
                              name={req.display_name}
                              src={req.avatar_url}
                              className="h-9 w-9 text-xs"
                            />
                            <div>
                              <p className="text-xs font-bold">{req.display_name}</p>
                              <p className="text-[10px] text-muted-foreground">@{req.username}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => demoteToListener(req.id)}
                              className="px-3 py-1.5 rounded-xl border border-border text-xs font-semibold hover:bg-muted cursor-pointer"
                            >
                              Dismiss
                            </button>
                            <button
                              type="button"
                              onClick={() => promoteToSpeaker(req.id)}
                              className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-brand to-brand-pink text-white text-xs font-bold shadow-soft hover:brightness-105 cursor-pointer flex items-center gap-1"
                            >
                              <UserPlus className="h-3.5 w-3.5" /> Bring to Stage
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Quick Emoji Reaction Toolbar */}
          <div className="flex items-center justify-center gap-1.5 sm:gap-2 py-2 px-3 sm:px-4 border-t border-border/40 bg-foreground/[0.02] overflow-x-auto [scrollbar-width:none]">
            <span className="text-[10px] font-semibold text-muted-foreground mr-1 shrink-0">
              React:
            </span>
            {["❤️", "🔥", "👏", "🚀", "💡", "💰", "💯"].map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => triggerReaction(emoji)}
                className="text-base sm:text-lg hover:scale-125 transition-transform active:scale-95 p-1.5 rounded-full hover:bg-foreground/5 min-h-[36px] min-w-[36px] flex items-center justify-center shrink-0 cursor-pointer"
              >
                {emoji}
              </button>
            ))}
          </div>

          {/* Bottom Action Bar */}
          <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 border-t border-border/60 p-3 sm:p-4 bg-card/60">
            <div className="flex items-center gap-2">
              <button
                onClick={handleToggleMic}
                className={cn(
                  "flex items-center gap-1.5 sm:gap-2 rounded-full px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs font-bold transition-all active:scale-95 shadow-soft min-h-[38px] sm:min-h-[40px] cursor-pointer",
                  isMuted
                    ? "bg-foreground/10 text-foreground hover:bg-foreground/15"
                    : "bg-emerald-500 text-white hover:bg-emerald-600 shadow-glow",
                )}
              >
                {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {isMuted ? "Unmute" : "Speaking"}
              </button>

              <button
                onClick={handleToggleHand}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 sm:px-4 py-2 sm:py-2.5 text-xs font-bold transition-all active:scale-95 min-h-[38px] sm:min-h-[40px] cursor-pointer",
                  handRaised
                    ? "bg-amber-500 text-white"
                    : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
                )}
              >
                <Hand className="h-4 w-4" />
                <span className="hidden xs:inline">
                  {handRaised ? "Hand Raised" : "Raise Hand"}
                </span>
              </button>
            </div>

            <div className="flex items-center gap-2 ml-auto">
              {isCurrentUserHost ? (
                <button
                  type="button"
                  onClick={() => setShowEndConfirmation(true)}
                  className="rounded-full bg-rose-600 hover:bg-rose-700 text-white font-bold px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs transition-all active:scale-95 min-h-[38px] sm:min-h-[40px] flex items-center gap-1.5 shadow-soft cursor-pointer"
                >
                  <Radio className="h-3.5 w-3.5" />
                  <span>End Space</span>
                </button>
              ) : (
                <button
                  onClick={async () => {
                    try {
                      await leaveSpace(space.id);
                    } catch {
                      /* leaving is best effort */
                    }
                    onClose();
                    toast.info("You left the Space");
                  }}
                  className="rounded-full bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 font-bold px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs transition-all active:scale-95 ml-auto min-h-[38px] sm:min-h-[40px] flex items-center cursor-pointer"
                >
                  Leave Quietly
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* End Space Confirmation Dialog */}
      {showEndConfirmation && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in">
          <div
            className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 text-rose-500">
              <span className="p-2.5 rounded-2xl bg-rose-500/15">
                <AlertTriangle className="h-6 w-6" />
              </span>
              <div>
                <h3 className="text-base font-black">End Space for Everyone?</h3>
                <p className="text-xs text-muted-foreground">
                  The broadcast will stop immediately.
                </p>
              </div>
            </div>
            <p className="text-xs text-foreground/80 leading-relaxed">
              All listeners will receive the AI replay summary. You can review tips and replay stats
              in your Analytics.
            </p>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowEndConfirmation(false)}
                className="flex-1 rounded-2xl border border-border py-2.5 text-xs font-bold hover:bg-muted cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowEndConfirmation(false);
                  try {
                    await endSpace(space.id);
                    toast.success("Space ended for everyone");
                  } catch {
                    toast.error("Couldn't end the Space");
                  }
                  onClose();
                }}
                className="flex-1 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white py-2.5 text-xs font-bold shadow-soft cursor-pointer"
              >
                End Space Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tip Modal */}
      {tipTargetUser && (
        <TipModal
          isOpen={!!tipTargetUser}
          onClose={() => setTipTargetUser(null)}
          recipient={tipTargetUser}
          spaceId={space.id}
        />
      )}
    </>
  );
}
