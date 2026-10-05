import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import {
  Mic,
  MicOff,
  Hand,
  X,
  Sparkles,
  Send,
  MessageSquare,
  Headphones,
  Volume2,
  VolumeX,
  Loader2,
  Shield,
  DollarSign,
  Crown,
  UserPlus,
  UserMinus,
  Radio,
  Disc3,
  Play,
  Pause,
  AlertTriangle,
  LogOut,
  Circle,
  Trash2,
  Download,
} from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import { TipModal } from "@/components/social/TipModal";
import type { Space } from "@/lib/types";
import {
  currentUser,
  getProfile,
  findProfile,
  fetchProfile,
  isProfilePending,
  useProfile,
} from "@/lib/profile-service";
import { useSpaceAudio } from "@/hooks/useSpaceAudio";
import {
  joinSpace,
  spaceHeartbeat,
  SPACE_HEARTBEAT_MS,
  getSpaceRoom,
  setSpaceParticipantRole,
  leaveSpace,
  toggleSpeaking,
  toggleHandRaised,
  sendSpaceMessage,
  endSpace,
  summarizeSpaceAI,
  setSpaceRecording,
  reportSpaceRecordingBytes,
  finalizeSpaceRecording,
  recordSpaceReplayView,
  setSpaceParticipantMute,
  removeSpaceParticipant,
  deleteSpaceRecording,
  uploadMedia,
  sendSpaceReaction,
} from "@/lib/api-client";
import { timeAgo, usd } from "@/lib/formatters";
import { SPACE_REACTIONS } from "@/lib/emojis";
import { isNewEvent } from "@/lib/call-media";
import {
  REACTION_MEMORY,
  applyReactions,
  canTapReaction,
  dismissTipAlert,
  emptyReactionLayer,
  nextTipAlertDelay,
  pruneReactionLayer,
  pruneTipAlerts,
  pushTipAlert,
  readReactionPayload,
  readTipAlert,
  reactionFor,
  reactionId,
  sortedTally,
  tipSparkles,
} from "@/lib/space-reactions";
import type { FloatingReaction, ReactionLayer, TipAlert } from "@/lib/space-reactions";
import { appConfig } from "@/lib/config";
import { useAuthorizedMediaUrl } from "@/lib/media-access";
import { friendlyError } from "@/lib/error-messages";
import { useRealtime } from "@/lib/realtime";
import { usePlatform } from "@/lib/platform-state";
import { cn } from "@/lib/utils";
import { canBroadcast, initialMutedFor, micStateAfterRoleChange } from "@/lib/spaces-stage";
import {
  formatBytes,
  isSpaceStorageExhausted,
  perRecordingCapBytes,
  spaceRecordingAllowed,
  spaceStorageFullMessage,
} from "@/lib/spaces-storage";
import { getSpaceStorageState } from "@/lib/spaces-storage.functions";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
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
}

/** One person in the room, as the room's UI needs it: the participant row plus
 *  the name and face the profile cache supplies. */
interface RoomRosterRow {
  id: string;
  role: "host" | "speaker" | "listener";
  isSpeaking?: boolean;
  isMuted?: boolean;
  handRaised?: boolean;
  display_name: string;
  username: string;
  avatar_url?: string;
}

/** A room's host is always the host, whatever their participant row says. */
type RoomParticipant = {
  id: string;
  role: "host" | "speaker" | "listener";
  isSpeaking: boolean;
  isMuted: boolean;
  handRaised: boolean;
};

function toRosterRow(p: RoomParticipant, hostId: string): RoomRosterRow {
  const profile = getProfile(p.id);
  return {
    id: p.id,
    role: p.id === hostId ? "host" : p.role,
    isSpeaking: p.isSpeaking,
    isMuted: p.isMuted,
    handRaised: p.handRaised,
    display_name: profile.display_name,
    username: profile.username,
    avatar_url: profile.avatar_url || undefined,
  };
}

export function SpaceRoomModal({ space, isOpen, onClose }: SpaceRoomModalProps) {
  if (!isOpen || !space) return null;
  return <SpaceRoomModalContent space={space} onClose={onClose} />;
}

function SpaceRoomModalContent({ space, onClose }: { space: Space; onClose: () => void }) {
  // AI room summaries belong to the AI subsystem the console can switch off.
  const { aiEnabled } = usePlatform();
  // Recording is a plan feature; broadcasting never is. The tier decides what a
  // host may keep afterwards, not whether they can go live.
  const { currentPlan } = usePlan();
  const canRecordSpace = spaceRecordingAllowed(currentPlan);
  // How long/take this browser may record before the upload would be refused:
  // the plan's per-file allowance, clamped by the global safety cap.
  const recordingCapBytes = perRecordingCapBytes(currentPlan, appConfig.realtime.recordingMaxMb);
  // Real numbers from the server (plan_limits + media_objects), so the room
  // never promises a cap the upload endpoint is about to refuse. Null until
  // loaded, and stays null if the lookup fails — the copy below degrades to the
  // plan's own figures rather than guessing.
  const [storage, setStorage] = useState<{
    usedBytes: number;
    quotaBytes: number;
    replays: number;
  } | null>(null);
  // Who owns the room is known from the first render, and it decides whether the
  // microphone comes on: the host is broadcasting a live room, so their voice is
  // what the room hears. A listener is never even asked for mic access.
  const isCurrentUserHost = space.host_id === currentUser.id;
  const [activeTab, setActiveTab] = useState<"stage" | "chat" | "manage">("stage");
  const [chatDraft, setChatDraft] = useState("");
  const [isMuted, setIsMuted] = useState(() =>
    initialMutedFor(isCurrentUserHost ? "host" : "listener"),
  );
  const [handRaised, setHandRaised] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary] = useState<{ summary: string; keyTakeaways: string[] } | null>(null);
  // The room's celebration layer. Reactions are shared: a tap is broadcast and
  // arrives back as an event, so every member sees the same emoji in the same
  // place. Tip banners queue instead of overwriting one another.
  const [reactionLayer, setReactionLayer] = useState<ReactionLayer>(emptyReactionLayer);
  const [tipAlerts, setTipAlerts] = useState<TipAlert[]>([]);
  // Event ids already applied. A Set in a ref because it is an identity, not
  // render data — copying three hundred of them per sparkle would be waste.
  const eventIdsRef = useRef(new Set<string>());
  const lastTapAtRef = useRef(0);
  const [isRecordingSpace, setIsRecordingSpace] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [showEndConfirmation, setShowEndConfirmation] = useState(false);
  const [showDeleteRecording, setShowDeleteRecording] = useState(false);
  const [deletingRecording, setDeletingRecording] = useState(false);

  // Tipping state
  const [tipTargetUser, setTipTargetUser] = useState<{
    username: string;
    display_name: string;
    avatar_url?: string | null;
    plan?: string | null;
  } | null>(null);

  const [participants, setParticipants] = useState<RoomRosterRow[]>([]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // Live replay count once this open has been recorded; the `space` prop only
  // carries the (stale) number captured when the list rendered.
  const [liveReplayCount, setLiveReplayCount] = useState<number | null>(null);

  const { profile: hostProfile } = useProfile(space.host_id);
  // Use the resolved profile when we have it; otherwise fall back to the cached
  // placeholder so the header never shows a raw UUID once it loads.
  const host = hostProfile ?? getProfile(space.host_id);
  // An ended room with a saved recording is a replay: play the stored audio
  // instead of pretending the live stage is still up. Recordings belong to the
  // host alone — nobody else gets a replay view (mirrors the `spaces public
  // read` RLS and the recordings/ media ACL, which both fail closed for others).
  const isReplay =
    !space.live && Boolean(space.recorded && space.recording_url) && isCurrentUserHost;
  const shownReplays = liveReplayCount ?? space.replay_count ?? 0;

  // Load the room from the backend: who is here and what has been said.
  useEffect(() => {
    let cancelled = false;
    // Captured for the cleanup below. The dedupe set is created once per room,
    // so this is the same object either way — but teardown should not have to
    // trust what a ref points at by then.
    const appliedEvents = eventIdsRef.current;

    void (async () => {
      type RoomMessage = { id: string; userId: string; body: string; created_at: string };
      let loaded: { participants: RoomParticipant[]; messages: RoomMessage[] } = {
        participants: [],
        messages: [],
      };
      try {
        await joinSpace(space.id);
        loaded = await getSpaceRoom(space.id);
        if (isReplay) {
          const rec = await recordSpaceReplayView(space.id).catch(() => null);
          if (rec && typeof rec.replayCount === "number") setLiveReplayCount(rec.replayCount);
        }
      } catch (err) {
        // A full room (host plan cap reached) must not open — tell the user and
        // back out. Any other failure stays offline-tolerant (fall back to just me).
        const msg = err instanceof Error ? err.message : "";
        if (/full|capacity/i.test(msg)) {
          if (!cancelled) {
            toast.error(msg || "This Space is full.");
            onClose();
          }
          return;
        }
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
        .map((p: RoomParticipant) => toRosterRow(p, space.host_id));

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

      // My own row is the authority on whether I hold the floor: an invited
      // speaker who reloads must land back on the stage, and anyone else must
      // stay in the audience with the microphone off.
      const mine = list.find((p) => p.id === currentUser.id)?.role;
      const micForRole = micStateAfterRoleChange(mine ?? (isCurrentUserHost ? "host" : "listener"));
      setIsMuted(micForRole.muted);
      for (const p of list) {
        if (p.id === currentUser.id) {
          p.isMuted = micForRole.muted;
          p.isSpeaking = micForRole.onStage;
        }
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
      // One room's celebration must not follow you into the next one.
      appliedEvents.clear();
      lastTapAtRef.current = 0;
      setReactionLayer(emptyReactionLayer());
      setTipAlerts([]);
      leaveSpace(space.id).catch(() => {});
    };
  }, [space.id]);

  // Roster rows arrive from the DB as an id plus a role; the name beside them
  // lives in the profile cache, which is empty on a cold open. Without this the
  // stage printed the raw UUID of everyone you had not already met, because
  // nothing ever asked for those rows. One read per missing member, then the
  // rows that gained a name are rewritten — and when nothing changed the array
  // identity is left alone, so this cannot spin itself into a loop.
  useEffect(() => {
    const waiting = participants.filter((p) => isProfilePending(getProfile(p.id)));
    if (waiting.length === 0) return undefined;
    let alive = true;
    void Promise.all(waiting.map((p) => fetchProfile(p.id).catch(() => null))).then(() => {
      if (!alive) return;
      setParticipants((prev) => {
        let changed = false;
        const next = prev.map((row) => {
          const fresh = findProfile(row.id);
          if (!fresh) return row;
          const avatar = fresh.avatar_url || undefined;
          if (row.display_name === fresh.display_name && row.username === fresh.username) {
            if (row.avatar_url === avatar) return row;
          }
          changed = true;
          return {
            ...row,
            display_name: fresh.display_name,
            username: fresh.username,
            avatar_url: avatar,
          };
        });
        return changed ? next : prev;
      });
    });
    return () => {
      alive = false;
    };
  }, [participants]);

  // Presence. The row this room opened is what grants the room its capacity,
  // its listener count and its place on the signalling channel — and none of
  // that is released by the cleanup above when the tab is closed rather than
  // left, because a closed tab runs no cleanup. So while the room is open this
  // device says "still here" every 25s, and the server uses the same call to
  // sweep the members who stopped saying it (see `space_heartbeat`).
  const listenerCountRef = useRef(0);
  useEffect(() => {
    listenerCountRef.current = participants.filter((p) => p.role === "listener").length;
  }, [participants]);

  useEffect(() => {
    if (isReplay) return undefined;
    let alive = true;
    const beat = () => {
      void spaceHeartbeat(space.id)
        .then((count) => {
          // The server's number only disagrees with ours when somebody arrived
          // or expired — which is precisely when the roster needs re-reading. A
          // steady room therefore costs nothing extra beyond the beat itself.
          if (alive && count !== null && count !== listenerCountRef.current) {
            void refreshRoster();
          }
        })
        .catch(() => undefined);
    };
    const iv = setInterval(beat, SPACE_HEARTBEAT_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
    // `refreshRoster` reads the current room through its own call; the effect is
    // keyed to the room, not to the roster, so a name arriving cannot restart a
    // timer that is already running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.id, isReplay]);

  /** Re-read who is in the room, keeping my own row's local microphone state. */
  async function refreshRoster() {
    try {
      const loaded = await getSpaceRoom(space.id);
      const rows: RoomRosterRow[] = [];
      for (const p of loaded.participants as RoomParticipant[]) {
        if (!p?.id || rows.some((row) => row.id === p.id)) continue;
        rows.push(toRosterRow(p, space.host_id));
      }
      if (rows.length === 0) return;
      setParticipants((prev) => {
        const mine = prev.find((row) => row.id === currentUser.id);
        const next = rows.map((row) =>
          mine && row.id === mine.id
            ? {
                ...row,
                isMuted: mine.isMuted,
                isSpeaking: mine.isSpeaking,
                handRaised: mine.handRaised,
              }
            : row,
        );
        if (mine && !next.some((row) => row.id === mine.id)) next.push(mine);
        return next;
      });
    } catch {
      /* keep the roster we have; the next beat tries again */
    }
  }

  /** Put floaters on this screen. Everything the room should see arrives as an event. */
  const showFloats = (floats: FloatingReaction[]) => {
    if (floats.length === 0) return;
    const at = Date.now();
    setReactionLayer((layer) => applyReactions(layer, eventIdsRef.current, floats, at));
  };

  /**
   * Tap a glyph: broadcast it, and let the broadcast render it.
   *
   * `emitRealtime` hands the sender their own event back, so this is the only
   * place a tap enters the layer — one path, and the person who tapped sees what
   * the room sees. Held-down buttons are throttled rather than queued; silence
   * is kinder here than a toast for every dropped tap.
   */
  const sendReaction = (emoji: string) => {
    const at = Date.now();
    if (!canTapReaction(lastTapAtRef.current, at)) return;
    lastTapAtRef.current = at;
    sendSpaceReaction(space.id, emoji, {
      id: reactionId(currentUser.id, at, Math.random().toString(36).slice(2, 8)),
    });
  };

  /** Best available name for a tip's sender, most trustworthy evidence first. */
  function tipSenderName(raw: unknown): string {
    const p = raw as { sender_name?: unknown; sender_id?: unknown } | null;
    const fromEvent = typeof p?.sender_name === "string" ? p.sender_name.trim() : "";
    if (fromEvent) return fromEvent;
    const id = typeof p?.sender_id === "string" ? p.sender_id : "";
    if (!id) return "";
    const name = getProfile(id).display_name?.trim() ?? "";
    // A cache miss carries no name at all — a UUID is not a name either.
    return name && name !== id ? name : "";
  }

  // Real-time events
  useRealtime(
    (event) => {
      // The bus is app-wide; ignore activity events that belong to a different
      // room so one Space's joins/mutes/hand-raises never mutate this roster.
      const evSpaceId = event.spaceId || event.data?.spaceId || event.message?.spaceId;
      if (
        evSpaceId &&
        evSpaceId !== space.id &&
        event.type !== "space:created" &&
        event.type !== "space:ended" &&
        event.type !== "space:terminated"
      ) {
        return;
      }
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
                    timestamp: new Date().toISOString(),
                  },
                ],
          );
        }
      } else if (event.type === "space:reaction") {
        // Someone in this room tapped a glyph. The payload came over the wire,
        // so it is validated before it is rendered and deduped by its id.
        const tap = readReactionPayload(event);
        if (tap) showFloats([reactionFor(tap.id, tap.emoji, Date.now())]);
      } else if (event.type === "space:tip" || event.type === "space_tip") {
        // A settled tip: the banner and a short burst of bags, and nothing
        // invented. The amount used to default to $5 when an event arrived
        // without one, which put money on the screen nobody had paid.
        //
        // There is no chat row here on purpose. The line the room keeps comes
        // from the database (`announceSpaceTip` writes an ordinary message), so
        // it survives a refresh, obeys access rules, and reaches members whose
        // broadcast socket missed this event. Adding one here drew the same tip
        // twice for everyone who was watching.
        const raw = event.tip || event.data;
        const at = Date.now();
        const alert = readTipAlert(raw, { at, senderName: tipSenderName(raw) });
        if (!alert) return;
        // The same tip reaching us twice must not ping twice.
        if (!isNewEvent(eventIdsRef.current, `tip_${alert.id}`, REACTION_MEMORY)) return;
        setTipAlerts((list) => pushTipAlert(list, alert));
        showFloats(tipSparkles(alert.id, at));
      } else if (event.type === "space:speaking" || event.type === "speaking_state") {
        const data = event.data || event;
        if (data && data.userId) {
          // The host muted (or unmuted) me: force my own mic so the mute is real,
          // not just a UI state on other people's screens.
          if (data.userId === currentUser.id) setIsMuted(!!(data.isMuted ?? data.muted));
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
          // The host handed over (or took back) the floor. The microphone
          // follows the role so an invited speaker is heard without hunting
          // for a button, and a demoted one stops transmitting immediately.
          const next = micStateAfterRoleChange(data.role);
          if (data.userId === currentUser.id) {
            setIsMuted(next.muted);
            setHandRaised(false);
            if (next.onStage) toast.success("You're on stage — your microphone is live");
            else toast.info("You're back in the audience");
          }
          setParticipants((prev) =>
            prev.map((p) =>
              p.id === data.userId
                ? {
                    ...p,
                    role: data.role,
                    handRaised: false,
                    isMuted: p.id === currentUser.id ? next.muted : p.isMuted,
                    isSpeaking: p.id === currentUser.id ? next.onStage : p.isSpeaking,
                  }
                : p,
            ),
          );
        }
      } else if (event.type === "space:joined") {
        const data = event.data || event;
        const uid = data?.userId;
        if (uid && uid !== currentUser.id) {
          setParticipants((prev) =>
            prev.some((p) => p.id === uid)
              ? prev
              : [
                  ...prev,
                  {
                    id: uid,
                    role: "listener" as const,
                    isSpeaking: false,
                    isMuted: true,
                    handRaised: false,
                    display_name: getProfile(uid).display_name,
                    username: getProfile(uid).username,
                    avatar_url: getProfile(uid).avatar_url || undefined,
                  },
                ],
          );
          // Resolve their real profile, then refresh the row (no reload needed).
          void fetchProfile(uid).then((p) => {
            if (!p) return;
            setParticipants((prev) =>
              prev.map((x) =>
                x.id === uid
                  ? {
                      ...x,
                      display_name: p.display_name,
                      username: p.username,
                      avatar_url: p.avatar_url || undefined,
                    }
                  : x,
              ),
            );
          });
        }
      } else if (event.type === "space:recording") {
        const data = event.data || event;
        if (typeof data.recording === "boolean") {
          setIsRecordingSpace(data.recording);
          if (!data.recording) {
            toast.info("Recording stopped");
          } else {
            toast.info("The host started recording this Space");
          }
        }
      } else if (event.type === "space:recording-deleted") {
        // The host wiped the replay (the room-scope guard above already matched
        // this room): anybody watching it right now has nothing left to play.
        toast.info("This recording was deleted");
        onClose();
      } else if (event.type === "space:left" || event.type === "participant_left") {
        const data = event.data || event;
        if (data && data.userId) {
          setParticipants((prev) => prev.filter((p) => p.id !== data.userId));
        }
      } else if (event.type === "space:removed") {
        const data = event.data || event;
        if (data && data.spaceId === space.id) {
          if (data.userId === currentUser.id) {
            toast.error("The host removed you from this Space");
            onClose();
            return;
          }
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
      "space:reaction",
      "space:recording",
      "space:recording-deleted",
      "space:removed",
    ],
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Floaters are animations with an end, not state that outlives them: once the
  // arc is over they leave the DOM. The interval exists only while something is
  // on screen, so an idle room costs nothing.
  useEffect(() => {
    if (reactionLayer.visible.length === 0) return;
    const timer = setInterval(() => {
      setReactionLayer((layer) => pruneReactionLayer(layer, Date.now()));
    }, 400);
    return () => clearInterval(timer);
  }, [reactionLayer.visible.length]);

  // One timer for the whole stack of tip banners, re-armed whenever the stack
  // changes. A timeout per tip is what used to dismiss a banner that had already
  // been replaced — and kept running after the room closed.
  useEffect(() => {
    const delay = nextTipAlertDelay(tipAlerts, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => {
      const at = Date.now();
      setTipAlerts((list) => pruneTipAlerts(list, at));
    }, delay);
    return () => clearTimeout(timer);
  }, [tipAlerts]);

  /** Host-only: wipe the saved replay (row fields + storage bytes). */
  async function handleDeleteRecording() {
    if (deletingRecording) return;
    setDeletingRecording(true);
    try {
      await deleteSpaceRecording(space.id);
      toast.success("Recording deleted");
      setShowDeleteRecording(false);
      onClose();
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't delete the recording. Please try again."));
    } finally {
      setDeletingRecording(false);
    }
  }

  async function handleToggleMic() {
    // The stage owns the microphone. A listener cannot broadcast, whatever their
    // own screen says — they raise a hand and the host brings them up.
    if (!canBroadcast(myRole)) {
      toast.info("Only the host and invited speakers can use the microphone here.");
      return;
    }
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);

    // Muting changes mic state only, never the role. The role used to be
    // rewritten to "speaker" here, which both promoted listeners locally (the
    // database still had them as listeners) and rebuilt the whole audio mesh,
    // so one person's tap dropped everyone else's connection for a moment.
    setParticipants((prev) =>
      prev.map((p) =>
        p.id === currentUser.id ? { ...p, isMuted: nextMuted, isSpeaking: !nextMuted } : p,
      ),
    );

    try {
      await toggleSpeaking(space.id, !nextMuted, nextMuted);
    } catch (err) {
      // The write failed: put the local view back. Silently keeping the optimistic
      // state told people their mic was live while the row still said listener, so
      // every other client kept them out of the mesh and the badge disagreed with
      // the database until the next reload.
      setIsMuted(!nextMuted);
      setParticipants((prev) =>
        prev.map((p) =>
          p.id === currentUser.id ? { ...p, isMuted: !nextMuted, isSpeaking: nextMuted } : p,
        ),
      );
      toast.error(friendlyError(err, "Couldn't change your microphone state. Please try again."));
      return;
    }

    toast(nextMuted ? "Microphone muted" : "You're on stage — your microphone is live");
  }

  async function handleToggleHand() {
    const nextRaised = !handRaised;
    setHandRaised(nextRaised);
    try {
      await toggleHandRaised(space.id, nextRaised);
    } catch (err) {
      setHandRaised(!nextRaised);
      toast.error(friendlyError(err, "Couldn't update your hand. Please try again."));
      return;
    }
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
    } catch (err) {
      // Undo the optimistic bubble and hand the text back to the composer: leaving
      // it on screen showed a message nobody else ever received.
      setMessages((prev) => prev.filter((m) => m.id !== newMsg.id));
      setChatDraft(text);
      toast.error(friendlyError(err, "Message not sent. Please try again."));
    }
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

  async function toggleAttendeeMute(userId: string, currentlyMuted: boolean) {
    const nextMuted = !currentlyMuted;
    setParticipants((prev) =>
      prev.map((p) =>
        p.id === userId
          ? { ...p, isMuted: nextMuted, isSpeaking: nextMuted ? false : p.isSpeaking }
          : p,
      ),
    );
    try {
      await setSpaceParticipantMute(space.id, userId, nextMuted);
    } catch {
      toast.error("Couldn't update their mic — try again.");
    }
  }

  async function removeAttendee(userId: string) {
    const target = getProfile(userId);
    setParticipants((prev) => prev.filter((p) => p.id !== userId));
    try {
      await removeSpaceParticipant(space.id, userId);
      toast.info(`Removed ${target.display_name} from the Space`);
    } catch {
      toast.error("Couldn't remove that person — try again.");
    }
  }

  /** The host's replay budget, read from the server. Best-effort: a failed
   * lookup leaves `storage` null and the room falls back to plan figures — it
   * must never be a reason a Space cannot be hosted. */
  async function refreshStorage() {
    if (!isCurrentUserHost || !canRecordSpace) return;
    try {
      const snap = await getSpaceStorageState();
      setStorage({
        usedBytes: snap.usedBytes,
        quotaBytes: snap.quotaBytes,
        replays: snap.replays,
      });
    } catch (err) {
      console.warn("Space storage read failed:", err);
    }
  }

  useEffect(() => {
    void refreshStorage();
    // A room's storage state is fetched once per open, for the host only.
  }, [isCurrentUserHost, canRecordSpace]);

  async function handleToggleRecording() {
    if (recordingBusy) return;
    setRecordingBusy(true);
    try {
      if (!isRecordingSpace) {
        // Warn before the take, not after: nothing is more frustrating than
        // losing a recording at the end of a room over budget spent months ago.
        if (storage && isSpaceStorageExhausted(storage.usedBytes, storage.quotaBytes)) {
          toast.error(spaceStorageFullMessage(storage.quotaBytes, storage.usedBytes));
          return;
        }
        const maxBytes = perRecordingCapBytes(currentPlan, appConfig.realtime.recordingMaxMb);
        const started = audio.startRecording(maxBytes, () => {
          toast.warning("Recording reached the size limit and was stopped automatically.");
        });
        if (!started) {
          toast.error("Couldn't start recording in this browser.");
          return;
        }
        await setSpaceRecording(space.id, true);
        setIsRecordingSpace(true);
        toast.success("Recording started — everyone in the room can see it's live.");
      } else {
        const blob = await audio.stopRecording();
        setIsRecordingSpace(false);
        if (blob.size > 0) {
          const file = new File([blob], `space-${space.id}-${Date.now()}.webm`, {
            type: blob.type || "audio/webm",
          });
          await reportSpaceRecordingBytes(space.id, blob.size).catch((err: any) => {
            // A failed byte-count update is non-fatal (the size cap is advisory);
            // surface it for debugging instead of swallowing it silently.
            console.warn("Recording size report failed:", err?.message ?? err);
          });
          const uploaded = await uploadMedia(file, "recordings");
          if (!uploaded?.url || uploaded.url.startsWith("data:")) {
            // A replay has to live in the media store: recording_url is what the
            // proxy ACL resolves against, and `spaces.recording_url` now has a
            // CHECK constraint rejecting anything but a /api/public/media/ path.
            // Treat a non-stored result as a genuine failure.
            throw new Error("The recording could not be uploaded to storage. Please try again.");
          }
          await finalizeSpaceRecording(space.id, uploaded.url);
          toast.success("Recording saved! It will be available as a replay once the Space ends.");
          void refreshStorage();
        } else {
          await setSpaceRecording(space.id, false);
          toast.info("Recording stopped");
        }
      }
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't update the recording — try again."));
    } finally {
      setRecordingBusy(false);
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
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't summarize this room right now."));
    } finally {
      setSummarizing(false);
    }
  }

  const speakers = participants.filter((p) => p.role === "host" || p.role === "speaker");
  const listeners = participants.filter((p) => p.role === "listener");
  // The current burst, busiest glyph first, so a room can see how it is going.
  const burst = sortedTally(reactionLayer.tally, Date.now());
  const myRole =
    participants.find((p) => p.id === currentUser.id)?.role ??
    (isCurrentUserHost ? "host" : "listener");
  const audio = useSpaceAudio({
    spaceId: space.id,
    userId: currentUser.id,
    // Only the stage publishes audio; listeners receive and stay silent.
    speaker: canBroadcast(myRole),
    muted: isMuted,
    // Replay viewers must not open WebRTC connections to a dead room.
    enabled: !isReplay,
  });
  useEffect(() => {
    if (audio.status === "mic-blocked")
      toast.error("Microphone access was blocked. Allow it in your browser to speak.");
  }, [audio.status]);
  useEffect(() => {
    if (audio.overCapacity)
      toast.warning(
        "This room is above the live-audio speaker limit; some speakers may not be heard.",
      );
  }, [audio.overCapacity]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-2 sm:p-4 animate-in fade-in duration-200">
        <div
          className="glass-panel relative flex flex-col h-[95dvh] sm:h-[90dvh] max-h-[750px] w-full max-w-2xl overflow-hidden rounded-2xl sm:rounded-3xl border border-border/80 bg-card/95 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/*
           * The celebration layer: reactions from everybody in the room, plus the
           * money bags a settled tip throws up. It spans the card rather than the
           * scroll area, so a tap is visible whatever tab you are on, and it is
           * `aria-hidden` because an emoji that floats past is not an announcement.
           */}
          <div aria-hidden className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
            {reactionLayer.visible.map((r) => (
              <span
                key={r.id}
                style={
                  {
                    left: `${r.left}%`,
                    animationDuration: `${r.duration}ms`,
                    "--reaction-rise": `${r.rise}px`,
                    "--reaction-sway": `${r.sway}px`,
                  } as CSSProperties
                }
                className="absolute bottom-3 select-none text-2xl sm:text-3xl animate-reaction-rise will-change-transform"
              >
                {r.emoji}
              </span>
            ))}
          </div>
          {/* Top Header */}
          <div className="flex items-center justify-between border-b border-border/60 p-3 sm:p-4 gap-2">
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              {isReplay ? (
                <span className="flex items-center gap-1.5 rounded-full bg-brand/15 px-2.5 sm:px-3 py-1 text-[11px] sm:text-xs font-bold text-brand shrink-0">
                  <Disc3 className="h-3 w-3" />
                  RECORDED REPLAY
                </span>
              ) : (
                <span className="flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 sm:px-3 py-1 text-[11px] sm:text-xs font-bold text-rose-500 shrink-0">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-70" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
                  </span>
                  LIVE STAGE
                </span>
              )}
              <span className="truncate rounded-full bg-brand/10 px-2.5 sm:px-3 py-1 text-[11px] sm:text-xs font-bold text-brand">
                {space.topic}
              </span>
              {isRecordingSpace && (
                <span className="flex items-center gap-1.5 rounded-full bg-red-600/15 px-2.5 sm:px-3 py-1 text-[11px] sm:text-xs font-bold text-red-600 shrink-0 animate-pulse">
                  <Circle className="h-2 w-2 fill-current" />
                  Recording
                </span>
              )}
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

              {aiEnabled && (
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
              )}
              <button
                onClick={onClose}
                className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/*
           * Settled tips. A stack, newest at the bottom, each with its own life:
           * one banner used to replace the one before it mid-announcement, so a
           * run of tips looked like a single larger one.
           */}
          {tipAlerts.length > 0 && (
            <div role="status" aria-live="polite" className="mx-4 sm:mx-6 mt-2 space-y-1.5">
              {tipAlerts.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded-2xl border border-amber-500/40 bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-amber-500/20 p-2.5 sm:p-3 text-xs text-foreground shadow-lg animate-tip-banner"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 rounded-full bg-amber-500 p-1.5 font-bold text-white">
                      <DollarSign className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-bold text-amber-600 dark:text-amber-400">
                        {t.senderName} tipped {usd(t.amount)}
                      </p>
                      {t.message && (
                        <p className="truncate text-[11px] italic text-muted-foreground">
                          “{t.message}”
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTipAlerts((list) => dismissTipAlert(list, t.id))}
                    aria-label="Dismiss this tip"
                    className="shrink-0 cursor-pointer p-1 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
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
              {isReplay ? (
                <span className="flex items-center gap-1">
                  <Disc3 className="h-3.5 w-3.5 text-brand" />
                  {shownReplays} {shownReplays === 1 ? "replay" : "replays"}
                  {space.duration ? ` · ${space.duration}` : ""}
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <Headphones className="h-3.5 w-3.5" /> {participants.length} in room
                </span>
              )}
            </div>
          </div>

          {/* Replay audio bar */}
          {isReplay && space.recording_url && (
            <ReplayPlayer src={space.recording_url} durationLabel={space.duration} />
          )}

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
                onClick={() => setActiveTab("manage")}
                className={cn(
                  "flex items-center gap-1.5 pb-2 text-xs sm:text-sm font-bold border-b-2 transition-all min-h-[36px] cursor-pointer",
                  activeTab === "manage"
                    ? "border-brand text-brand"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Hand className="h-4 w-4" />
                <span>Manage</span>
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
                                audio.speakingIds.has(speaker.id) || speaker.isSpeaking
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
                              <>
                                <button
                                  type="button"
                                  onClick={() => toggleAttendeeMute(speaker.id, !!speaker.isMuted)}
                                  title={speaker.isMuted ? "Unmute speaker" : "Mute speaker"}
                                  className="p-1 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
                                >
                                  {speaker.isMuted ? (
                                    <MicOff className="h-3 w-3" />
                                  ) : (
                                    <Mic className="h-3 w-3" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => demoteToListener(speaker.id)}
                                  title="Demote to listener"
                                  className="p-1 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-rose-500 transition-colors"
                                >
                                  <UserMinus className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeAttendee(speaker.id)}
                                  title="Remove from Space"
                                  className="p-1 rounded-full text-muted-foreground hover:bg-rose-500/15 hover:text-rose-500 transition-colors"
                                >
                                  <LogOut className="h-3 w-3" />
                                </button>
                              </>
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
                    Listeners ({listeners.length})
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
                          <div className="mt-1 flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => promoteToSpeaker(listener.id)}
                              className="px-2 py-0.5 rounded-full bg-brand/10 hover:bg-brand/20 text-[9px] font-bold text-brand flex items-center gap-0.5 transition-colors"
                            >
                              <UserPlus className="h-2.5 w-2.5" /> Invite
                            </button>
                            <button
                              type="button"
                              onClick={() => removeAttendee(listener.id)}
                              title="Remove from Space"
                              className="p-1 rounded-full text-muted-foreground hover:bg-rose-500/15 hover:text-rose-500 transition-colors"
                            >
                              <LogOut className="h-2.5 w-2.5" />
                            </button>
                          </div>
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
                    const profile = getProfile(m.userId);
                    return (
                      <div
                        key={m.id}
                        className="flex items-start gap-2.5 p-2 rounded-xl transition-all"
                      >
                        <Avatar
                          name={profile.display_name}
                          src={profile.avatar_url}
                          className="h-7 w-7 text-[0.6rem] shrink-0 mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-xs font-bold">{profile.display_name}</span>
                            {/* Chat rows store a real instant, loaded or live, so
                                one formatter covers both instead of a mix of raw
                                ISO strings and hand-written "Just now" text. */}
                            <span className="text-[10px] text-muted-foreground">
                              {timeAgo(m.timestamp)}
                            </span>
                          </div>
                          <div className="text-xs mt-0.5 leading-relaxed text-foreground/90 bg-foreground/5 p-2 rounded-xl">
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

          {/* Storage honesty, for the host who is about to be offered a Record
              button: a live broadcast writes no bytes at all — only a replay
              they choose to keep costs storage, and that has a plan budget. */}
          {!isReplay && isCurrentUserHost && (
            <div className="mx-3 sm:mx-4 mt-2 flex items-center justify-between gap-2 rounded-xl bg-foreground/5 px-3 py-2 text-[11px] font-semibold text-muted-foreground">
              <span className="flex min-w-0 items-center gap-1.5">
                <Disc3
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    isRecordingSpace ? "text-red-500" : "opacity-60",
                  )}
                />
                <span className="truncate">
                  {isRecordingSpace
                    ? `${formatBytes(audio.recordingBytes)} of ${formatBytes(recordingCapBytes)} this take`
                    : "Live only — broadcasting stores nothing"}
                </span>
              </span>
              {canRecordSpace && storage ? (
                <span className="shrink-0">
                  {storage.replays} {storage.replays === 1 ? "replay" : "replays"} ·{" "}
                  {formatBytes(storage.usedBytes)} of {formatBytes(storage.quotaBytes)}
                </span>
              ) : null}
              {!canRecordSpace && <span className="shrink-0">Replays need an upgrade</span>}
            </div>
          )}

          {/* The mesh's audience budget, said out loud. A speaker's browser pays
              one live encoder and one uplink *per listener*, so a room can grow
              past what any browser can broadcast — and the listeners past that
              point are connected to the room's text, not its audio. Silence with
              no explanation reads as a broken room and gets blamed on the host;
              the rule itself lives in lib/spaces-stage.ts. */}
          {!isReplay && (audio.unheard || audio.overFanOut) && (
            <div className="mx-3 sm:mx-4 mt-2 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              <VolumeX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {audio.unheard
                  ? `Live audio in this room reaches its first ${appConfig.realtime.maxMeshListeners} listeners, and you're past that — the conversation below is still live for you.`
                  : `This Space is past what a peer-to-peer room can broadcast (${appConfig.realtime.maxMeshListeners} listeners): the newest arrivals can read the chat but can't be fed audio. A room this size needs a server mixer.`}
              </span>
            </div>
          )}

          {/* The browser will not play sound until this page has been touched.
              A listener has nothing to tap and no mic to grant, so without this
              the room simply looks broken — one tap starts playback. */}
          {!isReplay && audio.needsGesture && (
            <button
              type="button"
              onClick={audio.unlock}
              className="mx-3 sm:mx-4 mt-2 flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2.5 text-xs font-bold text-white shadow-soft hover:bg-brand/90 transition-all active:scale-95 cursor-pointer"
            >
              <Volume2 className="h-4 w-4" />
              Tap to hear this Space
            </button>
          )}

          {/* Quick Emoji Reaction Toolbar: what your tap sends to the room, and
              the count the room has produced in this burst. */}
          <div className="flex items-center gap-2 border-t border-border/40 bg-foreground/[0.02] py-2 px-3 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 sm:gap-2 overflow-x-auto [scrollbar-width:none]">
              <span className="text-[10px] font-semibold text-muted-foreground mr-1 shrink-0">
                React:
              </span>
              {SPACE_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => sendReaction(emoji)}
                  title={`Send ${emoji} to everyone in the room`}
                  aria-label={`Send ${emoji} to everyone in the room`}
                  className="text-base sm:text-lg hover:scale-125 transition-transform active:scale-95 p-1.5 rounded-full hover:bg-foreground/5 min-h-[36px] min-w-[36px] flex items-center justify-center shrink-0 cursor-pointer"
                >
                  {emoji}
                </button>
              ))}
            </div>
            {burst.length > 0 && (
              <div className="flex shrink-0 items-center gap-1.5" aria-hidden>
                {burst.map((b) => (
                  <span
                    key={b.emoji}
                    className="flex items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground"
                  >
                    <span className="text-sm leading-none">{b.emoji}</span>
                    {b.count}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Bottom Action Bar */}
          <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 border-t border-border/60 p-3 sm:p-4 bg-card/60">
            {!isReplay && (
              <div className="flex items-center gap-2">
                {/* One control per station. The stage gets the microphone; the
                    audience gets a hand to raise. A listener is never offered a
                    microphone at all, so they cannot talk over the broadcast —
                    the host brings them up when they are ready to be heard. */}
                {canBroadcast(myRole) ? (
                  <button
                    onClick={handleToggleMic}
                    aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
                    className={cn(
                      "flex items-center gap-1.5 sm:gap-2 rounded-full px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs font-bold transition-all active:scale-95 shadow-soft min-h-[38px] sm:min-h-[40px] cursor-pointer",
                      isMuted
                        ? "bg-foreground/10 text-foreground hover:bg-foreground/15"
                        : "bg-emerald-500 text-white hover:bg-emerald-600 shadow-glow",
                    )}
                  >
                    {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    {isMuted ? "Unmute" : isCurrentUserHost ? "Live" : "Speaking"}
                  </button>
                ) : (
                  <button
                    onClick={handleToggleHand}
                    aria-label={handRaised ? "Lower hand" : "Raise hand to ask the host to speak"}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-3 sm:px-4 py-2 sm:py-2.5 text-xs font-bold transition-all active:scale-95 min-h-[38px] sm:min-h-[40px] cursor-pointer",
                      handRaised
                        ? "bg-amber-500 text-white"
                        : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
                    )}
                  >
                    <Hand className="h-4 w-4" />
                    <span>{handRaised ? "Waiting for the host" : "Raise hand to speak"}</span>
                  </button>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 ml-auto">
              {isCurrentUserHost && !isReplay ? (
                <>
                  {canRecordSpace ? (
                    <button
                      type="button"
                      onClick={handleToggleRecording}
                      disabled={recordingBusy}
                      aria-label={
                        isRecordingSpace ? "Stop recording this Space" : "Record this Space"
                      }
                      className={cn(
                        "rounded-full font-bold px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs transition-all active:scale-95 min-h-[38px] sm:min-h-[40px] flex items-center gap-1.5 shadow-soft cursor-pointer disabled:opacity-60",
                        isRecordingSpace
                          ? "bg-red-600 text-white hover:bg-red-700"
                          : "bg-foreground/10 text-foreground hover:bg-foreground/15",
                      )}
                    >
                      {recordingBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Disc3 className="h-3.5 w-3.5" />
                      )}
                      <span className="hidden xs:inline">
                        {isRecordingSpace ? "Stop Recording" : "Record"}
                      </span>
                    </button>
                  ) : (
                    // The room broadcasts for free whatever the plan; only saving
                    // it is paid. Offer the upgrade instead of starting a
                    // recording that would be refused when the host stops.
                    <button
                      type="button"
                      onClick={() =>
                        openUpgradeModal("Recording Spaces and keeping them as replays")
                      }
                      aria-label="Upgrade to record Spaces and keep them as replays"
                      className="rounded-full font-bold px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs transition-all active:scale-95 min-h-[38px] sm:min-h-[40px] flex items-center gap-1.5 bg-brand/10 text-brand hover:bg-brand/15 cursor-pointer"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span className="hidden xs:inline">Record · Upgrade</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowEndConfirmation(true)}
                    className="rounded-full bg-rose-600 hover:bg-rose-700 text-white font-bold px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs transition-all active:scale-95 min-h-[38px] sm:min-h-[40px] flex items-center gap-1.5 shadow-soft cursor-pointer"
                  >
                    <Radio className="h-3.5 w-3.5" />
                    <span>End Space</span>
                  </button>
                </>
              ) : (
                <div className="flex items-center gap-2 ml-auto">
                  {isCurrentUserHost && isReplay && (
                    <button
                      type="button"
                      onClick={() => setShowDeleteRecording(true)}
                      className="rounded-full border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 font-bold px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs transition-all active:scale-95 min-h-[38px] sm:min-h-[40px] flex items-center gap-1.5 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Delete Recording</span>
                    </button>
                  )}
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
                    className="rounded-full bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 font-bold px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs transition-all active:scale-95 min-h-[38px] sm:min-h-[40px] flex items-center cursor-pointer"
                  >
                    Leave Quietly
                  </button>
                </div>
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
                    if (isRecordingSpace) {
                      await handleToggleRecording();
                    }
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

      {/* Delete Recording Confirmation Dialog */}
      {showDeleteRecording && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in">
          <div
            className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 text-rose-500">
              <span className="p-2.5 rounded-2xl bg-rose-500/15">
                <Trash2 className="h-6 w-6" />
              </span>
              <div>
                <h3 className="text-base font-black">Delete this recording?</h3>
                <p className="text-xs text-muted-foreground">This can't be undone.</p>
              </div>
            </div>
            <p className="text-xs text-foreground/80 leading-relaxed">
              The replay disappears for every listener too, and its audio is permanently removed
              from storage. The room's chat transcript stays as it is.
            </p>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowDeleteRecording(false)}
                className="flex-1 rounded-2xl border border-border py-2.5 text-xs font-bold hover:bg-muted cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteRecording}
                disabled={deletingRecording}
                className="flex-1 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white py-2.5 text-xs font-bold shadow-soft cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1.5"
              >
                {deletingRecording && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete Recording
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
    </>,
    document.body,
  );
}

/* ---------------------------------------------------------------- replayer */

function fmtReplayTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Audio bar for recorded Spaces. The stored URL points at the authenticated
 * /api/public/media proxy (range-request capable, so seeking works), but an
 * <audio> subresource load cannot carry a bearer header - the browser would
 * just get a 404. So resolve the src through /api/media/token first, which
 * mints a short-lived signed URL after the same host/participant/staff ACL.
 */
function ReplayPlayer({ src, durationLabel }: { src: string; durationLabel?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const { src: playable, loading, error, refresh } = useAuthorizedMediaUrl(src);
  const retriedRef = useRef(false);

  /** Save the recording locally. `playable` is the minted signed URL, so the
   * fetch rides the same host-only ACL as streaming — no extra grant needed. */
  async function handleDownload() {
    if (!playable || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(playable);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `space-recording-${new Date().toISOString().slice(0, 10)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    } catch {
      toast.error("Couldn't download the recording. Please try again.");
    } finally {
      setDownloading(false);
    }
  }

  // An expired token mid-playback looks like a plain media error: re-mint once
  // automatically before falling back to the visible retry message.
  function handleMediaError() {
    const el = audioRef.current;
    if (!retriedRef.current && el) {
      retriedRef.current = true;
      void refresh().then(() => {
        if (el.src) void el.play().catch(() => setFailed(true));
      });
      return;
    }
    setFailed(true);
  }

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  async function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    try {
      if (el.paused) await el.play();
      else el.pause();
    } catch {
      setFailed(true);
    }
  }

  // MediaRecorder WebM has no duration cue, so the browser reports Infinity and
  // the seek bar can't show progress toward the end. Nudge the element to
  // compute its true length by seeking past the end once, then reset to start.
  function resolveDuration(el: HTMLAudioElement) {
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setDuration(el.duration);
      return;
    }
    const onTime = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration);
        el.removeEventListener("timeupdate", onTime);
        try {
          el.currentTime = 0;
          setTime(0);
        } catch {
          /* ignore */
        }
      }
    };
    el.addEventListener("timeupdate", onTime);
    try {
      el.currentTime = 1e101;
    } catch {
      el.removeEventListener("timeupdate", onTime);
    }
  }

  const seekable = Number.isFinite(duration) && duration > 0;

  return (
    <div className="mx-4 sm:mx-6 mt-3 rounded-2xl border border-brand/25 bg-gradient-to-r from-brand/10 via-brand-pink/10 to-brand/10 p-3 sm:p-4 space-y-2">
      <audio
        ref={audioRef}
        src={playable ?? undefined}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => resolveDuration(e.currentTarget)}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onError={handleMediaError}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          disabled={loading && !playable}
          aria-label={playing ? "Pause replay" : "Play replay"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-brand to-brand-pink text-white shadow-glow transition-all hover:brightness-105 active:scale-95 cursor-pointer"
        >
          {playing ? (
            <Pause className="h-5 w-5 fill-current" />
          ) : (
            <Play className="h-5 w-5 translate-x-0.5 fill-current" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={seekable ? duration : 0}
            step={1}
            value={seekable ? Math.min(time, duration) : 0}
            disabled={!seekable}
            onChange={(e) => {
              const el = audioRef.current;
              const v = Number(e.target.value);
              if (el && Number.isFinite(v)) {
                el.currentTime = v;
                setTime(v);
              }
            }}
            aria-label="Seek replay"
            className="w-full accent-brand cursor-pointer disabled:cursor-default"
          />
          <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground tabular-nums">
            <span>{fmtReplayTime(time)}</span>
            <span>{seekable ? fmtReplayTime(duration) : durationLabel || "—"}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setRate(rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1)}
          aria-label="Cycle playback speed"
          className="shrink-0 rounded-full border border-border bg-card px-2.5 py-1.5 text-[11px] font-bold text-foreground hover:bg-muted transition-colors cursor-pointer tabular-nums"
        >
          {rate}×
        </button>
        <button
          type="button"
          onClick={handleDownload}
          disabled={!playable || downloading}
          aria-label="Download recording"
          title="Download recording"
          className="shrink-0 rounded-full border border-border bg-card p-2 text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
        >
          {downloading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </button>
      </div>
      {(failed || error) && (
        <p className="text-[11px] font-semibold text-rose-500">
          This recording could not be streamed. It may have been removed, or your session expired.{" "}
          <button
            type="button"
            onClick={() => {
              retriedRef.current = false;
              setFailed(false);
              void refresh();
            }}
            className="underline font-bold cursor-pointer"
          >
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
