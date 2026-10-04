import { createFileRoute } from "@tanstack/react-router";
import { NOINDEX_META, ORG_NAME, brandedTitle } from "@/lib/seo";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { AppShell } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { TimeAgo, useLiveNow } from "@/components/social/TimeAgo";
import { useCallDialer } from "@/components/calls/IncomingCallProvider";
import { usePresenceMap } from "@/lib/presence";
import { TipModal } from "@/components/social/TipModal";
import { ReportModal } from "@/components/social/ReportModal";
import { EmojiPicker } from "@/components/social/EmojiPicker";
import { sanitizeReactionEmoji } from "@/lib/emojis";
import { MediaDownloadButton } from "@/components/social/MediaDownloadButton";
import { fileNameFromUrl } from "@/lib/media-download";
import { buildThreadTimeline, type CallCard, type CallKind } from "@/lib/call-cards";
import { currentUserId, getProfile, profileRegistry } from "@/lib/profile-service";
import type { Conversation, Message, Profile } from "@/lib/types";
import {
  getConversations,
  getCallHistory,
  sendMessage,
  uploadMedia,
  getUsers,
  editMessage,
  deleteMessage,
  hideConversationForMe,
  hideCallForMe,
  deleteCallForEveryone,
} from "@/lib/api-client";
import { decrementUnreadMessages } from "@/lib/unread-state";
import { useAuth } from "@/lib/auth-state";
import { useRealtime } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { attachmentKind } from "@/lib/message-helpers";
import { isMessageWithinLimit, messageLengthError } from "@/lib/message-length";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";
import { appConfig } from "@/lib/config";

import { useThread } from "@/hooks/use-messages/useThread";
import { useReactions } from "@/hooks/use-messages/useReactions";
import { useTyping } from "@/hooks/use-messages/useTyping";
import { useVoiceRecorder } from "@/hooks/use-messages/useVoiceRecorder";
import { usePendingAttachments } from "@/hooks/use-messages/usePendingAttachments";

import { ConversationList } from "@/components/messages/ConversationList";
import { ThreadHeader } from "@/components/messages/ThreadHeader";
import { MessageThread } from "@/components/messages/MessageThread";
import { Composer } from "@/components/messages/Composer";
import { ConversationInfoSheet } from "@/components/messages/ConversationInfoSheet";
import { ForwardSheet } from "@/components/messages/ForwardSheet";
import { MessageInfoSheet } from "@/components/messages/MessageInfoSheet";
import { DialogShell } from "@/components/messages/DialogShell";
import { AuthorizedImg } from "@/components/messages/AuthorizedMedia";

export const Route = createFileRoute("/messages")({
  validateSearch: (search: Record<string, unknown>): { user?: string; id?: string } => ({
    user: search.user ? String(search.user) : undefined,
    id: search.id ? String(search.id) : undefined,
  }),
  head: () => ({
    meta: [
      { title: brandedTitle("Messages") },
      {
        name: "description",
        content: `Private, fast conversations on ${ORG_NAME}. Catch up with collaborators, share frames, and keep every thread in one calm inbox.`,
      },
      { property: "og:title", content: brandedTitle("Messages") },
      {
        property: "og:description",
        content: `Private, fast conversations with the people you create with on ${ORG_NAME}.`,
      },
      // Private thread store — must never reach an index.
      ...NOINDEX_META,
    ],
  }),
  component: MessagesPage,
});

const DEFAULT_USERS_TO_START = [
  { id: "u_sora", username: "sora", display_name: "Sora Takahashi", bio: "Kinetic UI & WebGL" },
  {
    id: "u_elena",
    username: "elena",
    display_name: "Elena Rostova",
    bio: "Generative soundscapes",
  },
  { id: "u_kai", username: "kai", display_name: "Kai Vance", bio: "Building micro-tools" },
  { id: "u_maya", username: "maya", display_name: "Maya Lin", bio: "Product architect" },
  { id: "u_zane", username: "zane", display_name: "Zane Sterling", bio: "Motion designer" },
];

/**
 * The messages surface, decomposed. This component is a thin orchestrator: it
 * owns the inbox (conversations + the placeholder-thread bootstrap from a `?user`
 * link), the signed-in identity, presence, calls, the page-level sheets and
 * modals, and the single realtime dispatcher. Everything that used to be inline —
 * the message list + pagination + scroll (useThread), reactions (useReactions),
 * typing (useTyping), the voice recorder, staged attachments, and every bubble —
 * now lives in `@/components/messages` and `@/hooks/use-messages`.
 */
function MessagesPage() {
  const search = Route.useSearch();
  const targetUserParam = search.user || search.id;

  const { user: authUser, loading: authLoading } = useAuth();
  const { startCall } = useCallDialer();
  const presence = usePresenceMap();
  const now = useLiveNow();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [convsError, setConvsError] = useState(false);
  const [activeId, setActiveId] = useState<string>("");
  const [reloadTick, setReloadTick] = useState(0);

  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // Page-level sheets & modals.
  const [showInfo, setShowInfo] = useState(false);
  const [showTipModal, setShowTipModal] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showNewMsgModal, setShowNewMsgModal] = useState(false);
  const [newMsgQuery, setNewMsgQuery] = useState("");
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [reactionFor, setReactionFor] = useState<string | null>(null);

  // Per-message interactions that live outside the thread (they open sheets).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [forwardFor, setForwardFor] = useState<Message | null>(null);
  const [forwardQuery, setForwardQuery] = useState("");
  const [msgInfoFor, setMsgInfoFor] = useState<Message | null>(null);

  const [candidateUsers, setCandidateUsers] = useState<Profile[]>([]);

  // The thread: pages of history, scroll behaviour, read receipts.
  const thread = useThread({ conversationId: activeId, currentUserId });
  const reactions = useReactions({ conversationId: activeId, currentUserId });
  const typing = useTyping({ currentUserId });
  const pending = usePendingAttachments();

  // A finished recording is uploaded and sent as a voice note.
  const handleVoiceRecorded = async (file: File, duration: number) => {
    const tempId = crypto.randomUUID();
    const localUrl = URL.createObjectURL(file);
    const tempBody = `🎙️ Voice Note (${duration}s) [${localUrl}]`;
    thread.addOptimistic({
      id: tempId,
      conversation_id: activeId,
      sender_id: currentUserId,
      body: tempBody,
      created_at: new Date().toISOString(),
    });
    try {
      toast.loading("Uploading voice note...", { id: "voice-upload" });
      const res = await uploadMedia(file, "messages");
      toast.success("Voice note uploaded", { id: "voice-upload" });
      const realBody = `🎙️ Voice Note (${duration}s) [${res.url}]`;
      await persistMessage(realBody, tempId, res.url);
    } catch {
      thread.removeMessage(tempId);
      toast.error("Failed to upload voice note", { id: "voice-upload" });
    } finally {
      URL.revokeObjectURL(localUrl);
    }
  };
  const voice = useVoiceRecorder(handleVoiceRecorded);

  useEffect(() => {
    getUsers()
      .then((res) => {
        const list = res?.profiles || [];
        if (list.length > 0) setCandidateUsers(list.filter((u) => u.id !== currentUserId));
      })
      .catch(() => {});
  }, []);

  const loadConversations = useCallback(() => {
    if (authLoading) return;
    if (!authUser?.id) {
      setConvsLoading(false);
      return;
    }
    setConvsLoading(true);
    setConvsError(false);
    getConversations()
      .then((data) => {
        if (data && data.length > 0) {
          let targetConvId = activeId || data[0].id;
          if (targetUserParam) {
            const cleanTarget = targetUserParam.replace(/^@/, "");
            const found = data.find(
              (c) => c.participant_id === targetUserParam || c.participant_id === cleanTarget,
            );
            if (found) {
              targetConvId = found.id;
            } else {
              const resolved = getProfile(targetUserParam);
              const newConvId = `c_${resolved.id}_${Date.now()}`;
              data.unshift({
                id: newConvId,
                participant_id: resolved.id,
                preview: "Direct message thread",
                updated_at: new Date().toISOString(),
                unread: 0,
                online: true,
              });
              targetConvId = newConvId;
            }
            setMobileOpen(true);
          }
          const targetConv = data.find((c) => c.id === targetConvId);
          if (targetConv && targetConv.unread > 0) decrementUnreadMessages(targetConv.unread);
          setConversations(data.map((c) => (c.id === targetConvId ? { ...c, unread: 0 } : c)));
          setActiveId(targetConvId);
        } else if (targetUserParam) {
          const resolved = getProfile(targetUserParam);
          const newConvId = `c_${resolved.id}_${Date.now()}`;
          setConversations([
            {
              id: newConvId,
              participant_id: resolved.id,
              preview: "Direct message thread",
              updated_at: new Date().toISOString(),
              unread: 0,
              online: true,
            },
          ]);
          setActiveId(newConvId);
          setMobileOpen(true);
        }
      })
      .catch((err) => {
        console.warn("Conversations load:", err);
        setConvsError(true);
      })
      .finally(() => setConvsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserParam, authLoading, authUser?.id, reloadTick]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const active =
    (activeId ? conversations.find((c) => c.id === activeId) : conversations[0]) || null;
  const partner = active ? getProfile(active.participant_id) : null;
  const partnerId = active?.participant_id ?? "";
  const isOnline = !!partner && !!presence[partner.id]?.online;

  function selectConversation(id: string) {
    const conv = conversations.find((c) => c.id === id);
    if (conv && conv.unread > 0) {
      decrementUnreadMessages(conv.unread);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
    }
    setActiveId(id);
    setMobileOpen(true);
  }

  // Call history belongs to the *relationship*, so it reads by participant id —
  // it survives a placeholder thread that hasn't been saved yet.
  const [callCards, setCallCards] = useState<CallCard[]>([]);
  const [callRefresh, setCallRefresh] = useState(0);
  useEffect(() => {
    if (!partnerId) {
      setCallCards([]);
      return undefined;
    }
    let alive = true;
    void getCallHistory(partnerId)
      .then((cards) => {
        if (alive) setCallCards(cards);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [partnerId, callRefresh]);

  const timeline = useMemo(
    () => buildThreadTimeline(thread.messages, callCards),
    [thread.messages, callCards],
  );

  // One inbox rail row per participant; rows need a Profile, resolved here.
  const profiles = useMemo(() => {
    const map: Record<string, Profile> = {};
    for (const c of conversations) map[c.participant_id] = getProfile(c.participant_id);
    return map;
  }, [conversations]);

  // ── Realtime: one dispatcher, delegating to the owning hooks ────────────
  useRealtime((event) => {
    if (event.type === "call:resolved") {
      setCallRefresh((n) => n + 1);
      return;
    }

    const isNewMessage =
      event.type === "message" || event.type === "new_message" || event.type === "message:created";
    if (isNewMessage) {
      const msg = event.message || event;
      const msgBody = msg.body || msg.content || "";
      const msgSender = msg.sender_id || (partner ? partner.id : "");
      const msgConvId = msg.conversation_id || activeId;

      // Id-based de-dupe: every send is keyed by the UUID that becomes the row
      // id, so we only merge into the thread that owns the conversation.
      if (msg.id && msgConvId === activeId) {
        thread.ingest({
          id: msg.id,
          conversation_id: msgConvId,
          sender_id: msgSender,
          body: msgBody,
          created_at: msg.created_at || new Date().toISOString(),
          media_url: msg.media_url,
        });
      }

      setConversations((prev) => {
        if (!prev.some((c) => c.id === msgConvId)) {
          void getConversations()
            .then((fresh) => setConversations(fresh))
            .catch(() => {});
          return prev;
        }
        return prev.map((c) =>
          c.id === msgConvId
            ? {
                ...c,
                preview: msgBody || "Media attachment",
                updated_at: new Date().toISOString(),
                unread:
                  msgSender !== currentUserId && msgConvId !== activeId
                    ? (c.unread ?? 0) + 1
                    : c.unread,
              }
            : c,
        );
      });
      return;
    }

    if (event.type === "message:reaction" && event.messageId && event.emoji) {
      reactions.applyRemote(event.messageId, event.emoji, !!event.on, event.userId);
      return;
    }
    if (event.type === "message:edited" && event.id) {
      thread.applyEdit(event.id, event.body);
      return;
    }
    if (event.type === "message:deleted" && event.id) {
      thread.applyDelete(event.id);
      return;
    }
    // "Hidden for me" is viewer-scoped: only the caller's device drops the bubble.
    if (event.type === "message:hidden" && event.id && event.userId === currentUserId) {
      thread.applyDelete(event.id);
      return;
    }
    if (event.type === "message:read" && event.conversationId && event.readerId !== currentUserId) {
      thread.applyMarkRead(event.conversationId, event.at);
      return;
    }
    if (event.type === "message:delivered" && event.conversationId) {
      thread.applyMarkDelivered(event.conversationId, event.at);
      return;
    }
    if (event.type === "message:typing" && event.userId && event.userId !== currentUserId) {
      typing.applyRemote(event.conversationId, event.userId);
    }
  });

  function notifyTyping() {
    typing.notify(activeId);
  }

  /**
   * Saves a message to the backend. Threads started in the UI only exist locally
   * until the first message, so we send to the person and adopt the real thread
   * id the backend hands back — rewriting the conversation, the active id, and
   * every optimistic bubble that still points at the placeholder.
   */
  async function persistMessage(body: string, tempId: string, mediaUrl?: string | null) {
    const conv = conversations.find((c) => c.id === activeId);
    const target = activeId.startsWith("c_") && conv ? conv.participant_id : activeId;
    const res = await sendMessage(target, body, mediaUrl ?? null, tempId);
    const serverMsg = res.message;
    const realId: string = res.conversationId ?? activeId;
    const stale = activeId;

    if (realId && realId !== stale) {
      setConversations((prev) => prev.map((c) => (c.id === stale ? { ...c, id: realId } : c)));
      setActiveId(realId);
      thread.retargetConversation(stale, realId);
    }
    thread.replaceOptimistic(tempId, {
      id: serverMsg?.id ?? tempId,
      conversation_id: realId,
      body: serverMsg?.body ?? body,
    });
    setConversations((prev) =>
      prev.map((c) =>
        c.id === realId ? { ...c, preview: body, updated_at: new Date().toISOString() } : c,
      ),
    );
    return serverMsg;
  }

  async function send() {
    if (sending) return;
    const body = draft.trim();
    const staged = pending.attachments;
    if (!body && staged.length === 0) return;
    if (!isMessageWithinLimit(body)) {
      toast.error(messageLengthError(body) ?? "That message is too long.");
      return;
    }

    setSending(true);
    pending.clearAttachments();
    if (body) setDraft("");

    try {
      if (body) {
        const tempId = crypto.randomUUID();
        thread.addOptimistic({
          id: tempId,
          conversation_id: activeId,
          sender_id: currentUserId,
          body,
          created_at: new Date().toISOString(),
        });
        try {
          await persistMessage(body, tempId);
        } catch (err: unknown) {
          thread.removeMessage(tempId);
          setDraft(body);
          toast.error(friendlyError(err, "Message could not be sent"));
        }
      }

      // Each staged file uploads on demand and sends in order: media renders
      // inline, anything else becomes a download card.
      for (const att of staged) {
        const tempId = crypto.randomUUID();
        try {
          toast.loading(`Uploading ${att.name} (${att.sizeLabel})…`, { id: att.id });
          const res = await uploadMedia(att.file, "messages");
          toast.success(`Sent ${att.name}`, { id: att.id });
          const bodyString = att.isMedia ? res.url : `📄 Document: [${att.name}] [${res.url}]`;
          thread.addOptimistic({
            id: tempId,
            conversation_id: activeId,
            sender_id: currentUserId,
            body: bodyString,
            created_at: new Date().toISOString(),
          });
          await persistMessage(bodyString, tempId, res.url);
        } catch (err: unknown) {
          toast.error(friendlyError(err, `Could not send ${att.name}`), { id: att.id });
          thread.removeMessage(tempId);
        }
      }
    } finally {
      setSending(false);
    }
  }

  const handleStartEdit = (msg: Message) => {
    setEditingId(msg.id);
    setEditDraft(msg.body);
  };

  const handleSaveEdit = (msgId: string) => {
    const body = editDraft.trim();
    if (!body) return;
    const original = thread.messages.find((m) => m.id === msgId);
    thread.applyEdit(msgId, body);
    setEditingId(null);
    setEditDraft("");
    void editMessage(msgId, body)
      .then(() => toast.success("Message edited"))
      .catch(() => {
        if (original) thread.applyEdit(msgId, original.body);
        toast.error(friendlyError("Couldn't edit that message"));
      });
  };

  const handleDeleteMessage = (msgId: string, scope: "me" | "everyone" = "everyone") => {
    const targetMsg = thread.messages.find((m) => m.id === msgId);
    setMenuOpenFor(null);
    thread.applyDelete(msgId);
    void deleteMessage(msgId, scope)
      .then(() => toast.success(scope === "me" ? "Hidden for you" : "Message deleted"))
      .catch(() => {
        if (targetMsg) thread.restoreMessage(targetMsg);
        toast.error(friendlyError("Couldn't delete that message"));
      });
  };

  const handleHideConversation = (conversationId: string) => {
    const snapshot = conversations;
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
    if (activeId === conversationId) setActiveId("");
    void hideConversationForMe(conversationId)
      .then(() => toast.success("Chat hidden — it returns when a new message arrives"))
      .catch(() => {
        setConversations(snapshot);
        toast.error(friendlyError("Couldn't hide that chat"));
      });
  };

  // Remove a finished call from just this thread (soft hide) or from both people
  // (hard delete of the shared row). The card drops optimistically; a failed
  // write bumps the call refresh so the row reappears from the source of truth.
  const handleHideCall = (callId: string) => {
    const snapshot = callCards;
    setCallCards((prev) => prev.filter((c) => c.id !== callId));
    void hideCallForMe(callId)
      .then(() => toast.success("Call removed"))
      .catch(() => {
        setCallCards(snapshot);
        toast.error(friendlyError("Couldn't remove that call"));
      });
  };

  const handleDeleteCall = (callId: string) => {
    const snapshot = callCards;
    setCallCards((prev) => prev.filter((c) => c.id !== callId));
    void deleteCallForEveryone(callId)
      .then(() => toast.success("Call deleted for everyone"))
      .catch(() => {
        setCallCards(snapshot);
        toast.error(friendlyError("Couldn't delete that call"));
      });
  };

  const handleCopyMessage = (m: Message) => {
    setMenuOpenFor(null);
    void navigator.clipboard
      .writeText(m.body)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error(friendlyError("Couldn't copy that message")));
  };

  const handleShareMessage = async (m: Message) => {
    setMenuOpenFor(null);
    // A DM's media lives in a private bucket a share sheet cannot fetch without
    // the conversation capability, so we only ever share the text.
    const isMedia = attachmentKind(m.body) !== null;
    const text = isMedia ? "" : m.body;
    if (navigator.share) {
      try {
        await navigator.share({ title: appConfig.brand.name, text });
      } catch {
        // The user dismissed the native sheet — nothing to report.
      }
    } else {
      void navigator.clipboard
        .writeText(m.body)
        .then(() => toast.success("Copied to clipboard"))
        .catch(() => toast.error(friendlyError("Couldn't share that message")));
    }
  };

  const handleForwardMessage = (m: Message) => {
    setMenuOpenFor(null);
    setForwardQuery("");
    setForwardFor(m);
  };

  const handleForwardTo = (participantId: string) => {
    const m = forwardFor;
    if (!m) return;
    setForwardFor(null);
    const conv = conversations.find((c) => c.participant_id === participantId);
    const target = conv
      ? conv.id.startsWith("c_")
        ? conv.participant_id
        : conv.id
      : participantId;
    const name = getProfile(participantId)?.display_name ?? "chat";
    void sendMessage(target, m.body, m.media_url ?? null)
      .then(() => {
        toast.success(`Forwarded to ${name}`);
        if (conv) selectConversation(conv.id);
      })
      .catch(() => toast.error(friendlyError("Couldn't forward that message")));
  };

  const handleMessageInfo = (m: Message) => {
    setMenuOpenFor(null);
    setMsgInfoFor(m);
  };

  function startChatWithUser(user: { id: string; username: string; display_name: string }) {
    setShowNewMsgModal(false);
    const existing = conversations.find((c) => c.participant_id === user.id);
    if (existing) {
      selectConversation(existing.id);
      return;
    }
    const newConvId = `c_${user.id}_${Date.now()}`;
    setConversations([
      {
        id: newConvId,
        participant_id: user.id,
        preview: "Started a conversation",
        updated_at: new Date().toISOString(),
        unread: 0,
        online: true,
      },
      ...conversations,
    ]);
    setActiveId(newConvId);
    setMobileOpen(true);
    toast.success(`Direct message started with ${user.display_name}`);
  }

  const availableCandidates = useMemo(() => {
    let list: Profile[] = [];
    if (candidateUsers.length > 0) {
      list = candidateUsers;
    } else {
      const registryList = Object.values(profileRegistry).filter((p) => p.id !== currentUserId);
      if (registryList.length > 0) list = registryList;
      else list = DEFAULT_USERS_TO_START as Profile[];
    }
    const seen = new Set<string>();
    return list.filter((u) => {
      if (!u?.id || u.id === currentUserId || seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });
  }, [candidateUsers]);

  const filteredStartUsers = availableCandidates.filter(
    (u) =>
      !newMsgQuery ||
      u.display_name.toLowerCase().includes(newMsgQuery.toLowerCase()) ||
      u.username.toLowerCase().includes(newMsgQuery.toLowerCase()),
  );

  // Forward destinations: only the people you already have a conversation with,
  // deduped and search-filtered. Forwarding re-sends into an *existing* thread,
  // so the wider candidate pool (people you've never messaged) is deliberately
  // excluded here — starting a new chat is the New Message sheet's job.
  const forwardTargets = useMemo(() => {
    const byId = new Map<string, Profile>();
    for (const c of conversations) {
      const p = getProfile(c.participant_id);
      if (p?.id && p.id !== currentUserId) byId.set(p.id, p);
    }
    const q = forwardQuery.trim().toLowerCase();
    return Array.from(byId.values())
      .filter(
        (p) =>
          !q || p.display_name?.toLowerCase().includes(q) || p.username?.toLowerCase().includes(q),
      )
      .sort((a, b) => (a.display_name || "").localeCompare(b.display_name || ""));
  }, [conversations, forwardQuery]);

  const isTyping = !!activeId && !!typing.typingIn[activeId];

  return (
    <AppShell title="Messages">
      <div className="glass-panel grid h-[calc(100dvh-8.5rem)] grid-cols-1 overflow-hidden rounded-3xl shadow-soft lg:h-[calc(100dvh-3rem)] lg:grid-cols-[20rem_1fr]">
        <ConversationList
          className={cn("flex-col", mobileOpen ? "hidden lg:flex" : "flex")}
          conversations={conversations}
          profiles={profiles}
          presence={presence}
          activeId={activeId}
          loading={convsLoading}
          error={convsError}
          query={query}
          onQueryChange={setQuery}
          onOpen={selectConversation}
          onHide={handleHideConversation}
          onNew={() => setShowNewMsgModal(true)}
          onRetry={() => setReloadTick((n) => n + 1)}
        />

        <div className={cn("flex min-h-0 flex-col", mobileOpen ? "flex" : "hidden lg:flex")}>
          {!active || !partner ? (
            <div className="flex flex-1 flex-col items-center justify-center space-y-3 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Select a conversation or start a new message to begin.
              </p>
              <button
                type="button"
                onClick={() => setShowNewMsgModal(true)}
                className="cursor-pointer rounded-full bg-brand px-4 py-2 text-xs font-bold text-white transition-all hover:bg-brand/90"
              >
                Send a Direct Message
              </button>
            </div>
          ) : (
            <>
              <ThreadHeader
                partner={partner}
                isOnline={isOnline}
                lastActiveLabel="Active recently"
                onBack={() => setMobileOpen(false)}
                onTip={() => setShowTipModal(true)}
                onVoice={() => startCall(partner, "audio")}
                onVideo={() => startCall(partner, "video")}
                onInfo={() => setShowInfo(true)}
              />

              <MessageThread
                timeline={timeline}
                now={now}
                currentUserId={currentUserId}
                reactionCounts={reactions.counts}
                reactionMine={reactions.mine}
                partner={partner}
                isTyping={isTyping}
                scrollRef={thread.scrollRef}
                bottomRef={thread.bottomRef}
                onScroll={thread.onScroll}
                hasMore={thread.hasMore}
                loadingOlder={thread.loadingOlder}
                atEnd={thread.atEnd}
                pendingCount={thread.pendingCount}
                scrollToLatest={thread.scrollToLatest}
                menuOpenFor={menuOpenFor}
                setMenuOpenFor={setMenuOpenFor}
                editingId={editingId}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => {
                  setEditingId(null);
                  setEditDraft("");
                }}
                onStartEdit={handleStartEdit}
                onToggleReaction={reactions.toggle}
                onOpenCustomReaction={setReactionFor}
                onImageOpen={setLightboxImage}
                onCopy={handleCopyMessage}
                onForward={handleForwardMessage}
                onShare={handleShareMessage}
                onInfo={handleMessageInfo}
                onDeleteMe={(id) => handleDeleteMessage(id, "me")}
                onDeleteEveryone={(id) => handleDeleteMessage(id, "everyone")}
                onCallReDial={(kind: CallKind) => startCall(partner, kind)}
                onCallHide={handleHideCall}
                onCallDelete={handleDeleteCall}
              />

              <Composer
                partnerName={partner.display_name}
                draft={draft}
                onDraftChange={setDraft}
                notifyTyping={notifyTyping}
                onSend={send}
                sending={sending}
                pendingAttachments={pending.attachments}
                onDropAttachment={pending.dropAttachment}
                onStageFiles={pending.stageFiles}
                recording={{
                  isRecording: voice.isRecording,
                  duration: voice.duration,
                  onStart: voice.start,
                  onCancel: voice.cancel,
                  onSend: voice.send,
                }}
              />
            </>
          )}
        </div>
      </div>

      {/* New Direct Message sheet — a real dialog, not a bare overlay. */}
      <DialogShell
        open={showNewMsgModal}
        onClose={() => setShowNewMsgModal(false)}
        labelledBy="new-msg-title"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 id="new-msg-title" className="text-lg font-black tracking-tight">
              New Message
            </h2>
            <button
              type="button"
              onClick={() => setShowNewMsgModal(false)}
              aria-label="Close"
              className="cursor-pointer rounded-full p-1 text-muted-foreground hover:bg-muted"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={newMsgQuery}
              onChange={(e) => setNewMsgQuery(e.target.value)}
              placeholder="Search creators & collaborators..."
              aria-label="Search people"
              className="w-full rounded-2xl border border-border bg-muted/40 py-2.5 pl-9 pr-4 text-sm outline-none focus:border-brand"
            />
          </div>
          <div className="max-h-60 space-y-1 overflow-y-auto [scrollbar-width:thin]">
            <p className="px-1 text-[11px] font-bold uppercase text-muted-foreground">
              Suggested Creators
            </p>
            {filteredStartUsers.map((user) => (
              <button
                key={`start-chat-${user.id}`}
                type="button"
                onClick={() => startChatWithUser(user)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-2xl p-2.5 text-left transition-colors hover:bg-muted/50"
              >
                <Avatar name={user.display_name} className="h-10 w-10 text-xs" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{user.display_name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    @{user.username} • {user.bio}
                  </p>
                </div>
                <span className="rounded-full bg-brand/10 px-3 py-1 text-[11px] font-bold text-brand">
                  Chat
                </span>
              </button>
            ))}
            {filteredStartUsers.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                No one matches that search.
              </p>
            )}
          </div>
        </div>
      </DialogShell>

      {/* Conversation info — a real summary of who you're chatting with, with
          the thread's actions. Replaces the old generic Privacy policy modal. */}
      <ConversationInfoSheet
        open={showInfo}
        onClose={() => setShowInfo(false)}
        partner={partner}
        isOnline={isOnline}
        onTip={() => setShowTipModal(true)}
        onVoice={() => partner && startCall(partner, "audio")}
        onVideo={() => partner && startCall(partner, "video")}
        onHide={() => active && handleHideConversation(active.id)}
        onReport={() => setShowReport(true)}
      />

      {/* Forward-to sheet. */}
      <ForwardSheet
        open={!!forwardFor}
        onClose={() => setForwardFor(null)}
        message={forwardFor}
        targets={forwardTargets}
        query={forwardQuery}
        onQueryChange={setForwardQuery}
        onForwardTo={handleForwardTo}
      />

      {/* Per-message details. */}
      <MessageInfoSheet
        open={!!msgInfoFor}
        onClose={() => setMsgInfoFor(null)}
        message={msgInfoFor}
        senderName={msgInfoFor ? (getProfile(msgInfoFor.sender_id)?.display_name ?? "Unknown") : ""}
        isMine={!!msgInfoFor && msgInfoFor.sender_id === currentUserId}
        isAttachment={!!msgInfoFor && attachmentKind(msgInfoFor.body) !== null}
      />

      {/* Custom reaction picker, page-level so it isn't clipped by the scroll. */}
      <DialogShell
        open={!!reactionFor}
        onClose={() => setReactionFor(null)}
        labelledBy="reaction-title"
      >
        <h2 id="reaction-title" className="sr-only">
          Add a reaction
        </h2>
        <EmojiPicker
          label="Add a reaction"
          className="relative"
          onClose={() => setReactionFor(null)}
          onPick={(emoji) => {
            const target = reactionFor;
            setReactionFor(null);
            if (target) reactions.toggle(target, sanitizeReactionEmoji(emoji));
          }}
        />
      </DialogShell>

      {showTipModal && partner && (
        <TipModal
          isOpen={showTipModal}
          onClose={() => setShowTipModal(false)}
          recipient={partner}
        />
      )}

      {showReport && partner && (
        <ReportModal
          isOpen={showReport}
          onClose={() => setShowReport(false)}
          targetType="user"
          targetId={partner.id}
          authorId={partner.id}
          authorName={partner.username}
        />
      )}

      {/* Full-resolution attachment lightbox. */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-md motion-safe:animate-in motion-safe:fade-in"
          onClick={() => setLightboxImage(null)}
        >
          <div className="relative flex max-h-[90dvh] max-w-4xl flex-col items-center">
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              aria-label="Close"
              className="absolute -top-12 right-0 cursor-pointer rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
            >
              <X className="h-6 w-6" />
            </button>
            <AuthorizedImg
              src={lightboxImage}
              alt="Full Preview"
              className="max-h-[80dvh] w-auto max-w-full rounded-2xl object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <div className="mt-4 flex items-center gap-3">
              <MediaDownloadButton
                url={lightboxImage}
                name={fileNameFromUrl(lightboxImage) ?? "photo.jpg"}
                label="Download Full Resolution"
                title="Download full resolution"
                className="rounded-full bg-white/20 px-5 py-2 text-xs text-white hover:bg-white/30 sm:text-sm"
              />
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
