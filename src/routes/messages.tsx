import { createFileRoute, Link } from "@tanstack/react-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Send,
  Phone,
  Video,
  Info,
  Smile,
  SmilePlus,
  Paperclip,
  ArrowLeft,
  Loader2,
  DollarSign,
  Plus,
  Mic,
  Square,
  Sparkles,
  X,
  CheckCheck,
  Edit2,
  Trash2,
  Check,
  MoreVertical,
  Play,
  ExternalLink,
  Globe,
  FileText,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  File,
  Eye,
  Film,
  Image as ImageIcon,
  Music,
} from "lucide-react";
import { AppShell } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeAgo, useLiveNow } from "@/components/social/TimeAgo";
import { useCallDialer } from "@/components/calls/IncomingCallProvider";
import { usePresenceMap } from "@/lib/presence";
import { InfoModal } from "@/components/social/InfoModal";
import { TipModal } from "@/components/social/TipModal";
import { timeAgo } from "@/lib/formatters";
import { currentUserId, currentUser, getProfile, profileRegistry } from "@/lib/profile-service";
import type { Conversation, Message, Profile } from "@/lib/types";
import {
  getConversations,
  getMessages,
  sendMessage,
  uploadMedia,
  getUserProfile,
  getUsers,
  getMessageReactions,
  toggleMessageReaction,
  editMessage,
  deleteMessage,
} from "@/lib/api-client";
import { decrementUnreadMessages } from "@/lib/unread-state";
import { useAuth } from "@/lib/auth-state";
import { useRealtime, emitRealtime } from "@/lib/realtime";
import { cn, optimizeImageUrl } from "@/lib/utils";
import { useAuthorizedMediaUrl } from "@/lib/media-access";
import { MediaDownloadButton } from "@/components/social/MediaDownloadButton";
import { fileNameFromUrl, extensionOf } from "@/lib/media-download";
import { EmojiPicker } from "@/components/social/EmojiPicker";
import { QUICK_REACTIONS, sanitizeReactionEmoji } from "@/lib/emojis";
import {
  MAX_MESSAGE_CHARS,
  isMessageWithinLimit,
  messageCharsOver,
  messageCounterLabel,
  messageLength,
  messageLengthError,
  shouldShowMessageCounter,
} from "@/lib/message-length";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";

export const Route = createFileRoute("/messages")({
  validateSearch: (search: Record<string, unknown>): { user?: string; id?: string } => ({
    user: search.user ? String(search.user) : undefined,
    id: search.id ? String(search.id) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Messages — Spaces1" },
      {
        name: "description",
        content:
          "Private, fast conversations on Spaces1. Catch up with collaborators, share frames, and keep every thread in one calm inbox.",
      },
      { property: "og:title", content: "Messages — Spaces1" },
      {
        property: "og:description",
        content: "Private, fast conversations with the people you create with on Spaces1.",
      },
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

/** Calendar day of a message, used to break the thread into dated sections. */
function dayKey(iso: string) {
  return new Date(iso).toDateString();
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** A file queued in the composer, uploaded only when the user presses Send. */
interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  sizeLabel: string;
  isMedia: boolean;
  previewUrl: string;
}

/** Attachments read as a friendly label in the chat list, never a raw link. */
function previewLabel(preview: string) {
  // Voice notes never render as "🎙️ Voice Note (7s) [/api/public/media/...]" —
  // collapse the stored markup to a short, human label so the conversation rail
  // shows an icon + text instead of leaking the raw media path.
  if (isVoiceNoteBody(preview)) return "🎙️ Voice message";
  const kind = attachmentKind(preview);
  if (kind === "image") return "📷 Photo";
  if (kind === "video") return "🎬 Video";
  if (kind === "audio") return "🎧 Audio";
  if (kind === "pdf") return "📄 PDF Document";
  if (kind === "document") return documentLabelName(preview);
  if (preview.startsWith("📄") || preview.startsWith("📎")) return "📎 Document";
  if (/^https?:\/\/|^\/api\/public\/media\//.test(preview)) return "📎 Attachment";
  return preview;
}

/** Voice-note bodies are stored as `🎙️ Voice Note (Ns) [url]`. */
function isVoiceNoteBody(body: string) {
  const value = (body || "").trim();
  return value.startsWith("🎙️") || /\bVoice Note\b/i.test(value);
}

/** Recover the sender's filename from a tagged document body, else a generic label. */
function documentLabelName(preview: string) {
  const tagged = (preview || "").trim().match(/^(?:📄|📎)\s*(.*?):\s*\[(.*?)\]/);
  const name = tagged?.[2]?.trim();
  return name ? `📎 ${name}` : "📎 File Attachment";
}

const URL_REGEX = /(https?:\/\/[^\s]+)/g;
// Non-global, anchored: safe to call repeatedly. Reusing the /g regex with
// .test() carries lastIndex state between calls and mis-detects links.
const URL_TEST_REGEX = /^https?:\/\/[^\s]+$/;

/** Modern clean message text with full unshortened links and clean link preview cards */
function MessageText({ body, isMine }: { body: string; isMine: boolean }) {
  const links = useMemo(() => {
    const matches = body.match(URL_REGEX);
    return matches ? Array.from(new Set(matches)) : [];
  }, [body]);

  const parts = useMemo(() => {
    return body.split(URL_REGEX);
  }, [body]);

  return (
    <div className="space-y-2">
      <div className="whitespace-pre-wrap break-words text-[13px] sm:text-sm leading-relaxed">
        {parts.map((part, idx) => {
          if (URL_TEST_REGEX.test(part)) {
            return (
              <a
                key={idx}
                href={part}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "inline-flex items-center gap-1 font-semibold underline underline-offset-3 transition-opacity hover:opacity-80 break-all",
                  isMine
                    ? "text-white underline decoration-white/70 hover:text-white/90"
                    : "text-brand underline decoration-brand/60 hover:text-brand-dark",
                )}
                title={part}
              >
                <span>{part}</span>
                <ExternalLink className="inline h-3.5 w-3.5 shrink-0 opacity-80" />
              </a>
            );
          }
          return <span key={idx}>{part}</span>;
        })}
      </div>

      {/* Clean Link Preview Card (No large bulky bezels) */}
      {links.length > 0 && (
        <div className="mt-2 space-y-1.5 pt-1">
          {links.slice(0, 2).map((link, lIdx) => {
            let host = link;
            try {
              host = new URL(link).hostname.replace(/^www\./, "");
            } catch {
              // Not an absolute URL (or malformed): show the text as typed rather
              // than refuse to render the preview.
            }

            return (
              <a
                key={lIdx}
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "group/link flex items-center gap-2.5 rounded-xl p-2.5 transition-all text-left",
                  isMine
                    ? "bg-black/20 hover:bg-black/30 border border-white/20 text-white"
                    : "bg-background/90 hover:bg-background border border-border/60 text-foreground shadow-xs",
                )}
              >
                <div
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold",
                    isMine ? "bg-white/20 text-white" : "bg-brand/10 text-brand",
                  )}
                >
                  <Globe className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-xs font-bold">{host}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 opacity-60 group-hover/link:opacity-100" />
                  </div>
                  <p
                    className={cn(
                      "truncate text-[11px] font-mono",
                      isMine ? "text-white/80" : "text-muted-foreground",
                    )}
                  >
                    {link}
                  </p>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Detects whether a message body is a media link or document we should render inline. */
function attachmentKind(body: string): "image" | "video" | "audio" | "pdf" | "document" | null {
  const value = (body || "").trim();
  if (!value) return null;
  if (value.startsWith("data:image")) return "image";
  if (value.startsWith("data:video")) return "video";
  if (value.startsWith("data:audio")) return "audio";
  if (value.startsWith("data:application/pdf")) return "pdf";
  if (value.startsWith("data:application")) return "document";
  if (value.startsWith("🎙️") || /\bVoice Note\b/i.test(value)) return "audio";
  if (value.startsWith("📄") || value.startsWith("📎")) return "document";

  if (!value.startsWith("http") && !value.startsWith("/")) return null;
  const path = value.split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|avif|svg)$/.test(path)) return "image";
  if (/\.(mp4|webm|mov|m4v|mkv)$/.test(path)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(path)) return "audio";
  if (/\.pdf$/.test(path)) return "pdf";
  if (
    /\.(doc|docx|txt|csv|xlsx|xls|pptx|ppt|zip|rar|7z|tar|gz|json|js|ts|py|md|css|html)$/.test(path)
  )
    return "document";

  if (path.includes("/messages/") || path.includes("/media/") || path.includes("/attachments/")) {
    return "document";
  }
  return null;
}

function SafeVideoAttachment({ src }: { src: string }) {
  const [hasError, setHasError] = useState(false);
  // Private (messages/) media cannot carry a bearer header on a subresource
  // load, so play through the signed media-token URL, not the raw path.
  const { src: playable, error } = useAuthorizedMediaUrl(src);

  if (hasError || error || !playable) {
    return (
      <div className="flex h-32 w-56 flex-col items-center justify-center bg-neutral-950/60 p-4 text-center text-xs text-white/70 font-medium rounded-lg border border-white/5 gap-1.5 select-none">
        <span className="text-[10px] uppercase font-bold text-rose-400 tracking-wider">
          Video Unavailable
        </span>
        <span className="text-[11px] leading-relaxed text-white/40">
          Format unsupported or offline
        </span>
      </div>
    );
  }

  return (
    <div className="relative">
      <video
        src={playable}
        controls
        playsInline
        preload="metadata"
        onError={() => setHasError(true)}
        className="max-h-72 w-full bg-black object-cover"
      />
      {/* Native video controls have no save button, and a long-press on a
          private object cannot authorise itself, so offer the download here. */}
      <MediaDownloadButton
        url={src}
        name={fileNameFromUrl(src) ?? "video.mp4"}
        title="Download video"
        className="absolute right-2 top-2 h-8 w-8 items-center justify-center rounded-lg bg-black/60 text-white hover:bg-black/80"
      />
    </div>
  );
}

/** <img> that can render private media: resolves a signed URL first. */
function AuthorizedImg({
  src,
  alt,
  className,
  loading,
  onClick,
}: {
  src: string;
  alt?: string;
  className?: string;
  loading?: "lazy" | "eager";
  onClick?: React.MouseEventHandler<HTMLImageElement>;
}) {
  const { src: resolved, error, loading: authorizing } = useAuthorizedMediaUrl(src);

  // Returning null while the token was still being minted left a hole exactly
  // the size of the photo, so a chat with pictures in it collapsed and then
  // jumped. A placeholder keeps the bubble the right shape while it resolves.
  if (authorizing) {
    return (
      <div
        className={cn("min-h-[8rem] min-w-[12rem] animate-pulse bg-muted-foreground/15", className)}
        role="status"
        aria-label="Loading image"
      />
    );
  }

  if (error || !resolved) {
    return (
      <div className="flex h-32 w-56 flex-col items-center justify-center gap-1.5 rounded-lg border border-white/5 bg-neutral-950/60 p-4 text-center text-xs font-medium text-white/70 select-none">
        <span className="text-[10px] uppercase tracking-wider font-bold text-rose-400">
          Image Unavailable
        </span>
        <span className="text-[11px] leading-relaxed text-white/40">
          {error ?? "This picture could not be loaded."}
        </span>
      </div>
    );
  }

  return <img src={resolved} alt={alt} loading={loading} className={className} onClick={onClick} />;
}

function SafeAudioAttachment({ src }: { src: string }) {
  const [hasError, setHasError] = useState(false);
  const { src: playable, error } = useAuthorizedMediaUrl(src);

  if (hasError || error || !playable) {
    return (
      <div className="flex items-center gap-2 bg-neutral-950/60 py-2 px-3 text-xs text-white/70 rounded-lg border border-white/5 select-none w-56">
        <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse shrink-0" />
        <span className="font-mono text-[10px] text-rose-300 font-bold tracking-tight uppercase">
          Audio Offline
        </span>
      </div>
    );
  }

  return (
    <div className="my-1 flex w-56 max-w-full items-center gap-1">
      <audio
        src={playable}
        controls
        preload="metadata"
        onError={() => setHasError(true)}
        className="min-w-0 flex-1"
      />
      <MediaDownloadButton
        url={src}
        name={fileNameFromUrl(src) ?? "audio"}
        title="Download audio"
        className="h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-foreground hover:bg-foreground/10"
      />
    </div>
  );
}

function DocumentCardAttachment({ body, isMine }: { body: string; isMine: boolean }) {
  const value = body.trim();
  let fileUrl = value;
  let fileName = "Attached Document";
  let ext = "file";

  // Check for tagged format: 📄 Document: [filename] [url] or 📎 File: [filename] [url]
  const matchTagged = value.match(/^(?:📄|📎)\s*(.*?):\s*\[(.*?)\]\s*\[(.*?)\]/);
  if (matchTagged) {
    fileName = matchTagged[2] || matchTagged[1] || "Document";
    fileUrl = matchTagged[3] || value;
  } else {
    try {
      const parsedUrl = new URL(value, window.location.origin);
      const pathname = parsedUrl.pathname;
      const parts = pathname.split("/");
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.includes(".")) {
        fileName = decodeURIComponent(lastPart);
      }
    } catch {
      // Unparseable URL — the defaults above (no extension) already handle it.
    }
  }

  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx > 0) {
    ext = fileName.slice(dotIdx + 1).toLowerCase();
  }

  // Downloads used to be a bare <a href={fileUrl} download>: the stored path is
  // private, so the navigation reached the read proxy with no capability and got
  // its fail-closed 404. Saving now mints access first (see MediaDownloadButton).
  const isPdf = ext === "pdf" || value.toLowerCase().includes(".pdf");
  const isCode = ["js", "ts", "py", "json", "html", "css", "cpp", "java", "sh", "md"].includes(ext);
  const isZip = ["zip", "rar", "7z", "tar", "gz"].includes(ext);
  const isSheet = ["csv", "xlsx", "xls"].includes(ext);

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[20px] p-3 max-w-[300px] sm:max-w-[340px] border transition-all shadow-xs",
        isMine
          ? "bg-black/15 border-white/10 text-white"
          : "bg-background/80 dark:bg-neutral-900/60 border-border/40 text-foreground",
      )}
    >
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-bold uppercase text-xs shadow-xs",
          isPdf
            ? "bg-rose-500 text-white"
            : isZip
              ? "bg-amber-500 text-white"
              : isCode
                ? "bg-emerald-500 text-white"
                : isSheet
                  ? "bg-teal-500 text-white"
                  : isMine
                    ? "bg-white/20 text-white"
                    : "bg-brand/15 text-brand",
        )}
      >
        {isPdf ? (
          <FileText className="h-5 w-5" />
        ) : isZip ? (
          <FileArchive className="h-5 w-5" />
        ) : isCode ? (
          <FileCode className="h-5 w-5" />
        ) : isSheet ? (
          <FileSpreadsheet className="h-5 w-5" />
        ) : (
          <File className="h-5 w-5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold leading-tight">{fileName}</p>
        <p
          className={cn(
            "text-[10px] font-mono mt-0.5 uppercase tracking-wider",
            isMine ? "text-white/80" : "text-muted-foreground",
          )}
        >
          {ext} document
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <MediaDownloadButton
          url={fileUrl}
          name={fileName}
          title="Download File"
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg transition-transform hover:scale-105 active:scale-95",
            isMine
              ? "bg-white/20 hover:bg-white/30 text-white"
              : "bg-muted hover:bg-muted/80 text-foreground",
          )}
        />
      </div>
    </div>
  );
}

function VoiceNotePlayer({ body, isMine }: { body: string; isMine: boolean }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const match = body.match(/\((\d+)s\)/);
  const duration = match ? parseInt(match[1], 10) : 5;

  // Extract optional recorded audio url: [url]
  const matchUrl = body.match(/\[(.*?)\]/);
  const audioUrl = matchUrl ? matchUrl[1] : null;
  const { src: playableUrl } = useAuthorizedMediaUrl(audioUrl);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (playableUrl) {
      const audio = new Audio(playableUrl);
      audioRef.current = audio;

      audio.onended = () => {
        setIsPlaying(false);
        setProgress(0);
      };

      audio.ontimeupdate = () => {
        if (audio.duration) {
          setProgress((audio.currentTime / audio.duration) * 100);
        }
      };

      return () => {
        audio.pause();
        audioRef.current = null;
      };
    }
    return undefined;
  }, [playableUrl]);

  useEffect(() => {
    if (audioUrl) return; // Managed by audioRef timeupdate

    let interval: any;
    if (isPlaying) {
      interval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 100) {
            setIsPlaying(false);
            return 0;
          }
          return prev + 100 / (duration * 10);
        });
      }, 100);
    } else {
      clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [isPlaying, duration, audioUrl]);

  const togglePlay = () => {
    if (audioUrl) {
      if (!audioRef.current) return;
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        if (progress >= 100) {
          audioRef.current.currentTime = 0;
          setProgress(0);
        }
        audioRef.current.play().catch((err) => {
          console.warn("Audio playback issue:", err);
          toast.error("Audio playback blocked or unavailable");
        });
        setIsPlaying(true);
      }
    } else {
      if (progress >= 100) setProgress(0);
      setIsPlaying(!isPlaying);
    }
  };

  const bars = [40, 70, 30, 85, 50, 95, 60, 40, 80, 100, 65, 45, 90, 75, 35, 80, 50, 30];

  return (
    <div className="flex items-center gap-3 py-1 px-1 min-w-[210px] sm:min-w-[240px]">
      <button
        type="button"
        onClick={togglePlay}
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90 cursor-pointer shadow-sm",
          isMine
            ? "bg-white text-brand hover:bg-white/95"
            : "bg-brand text-white hover:bg-brand/90",
        )}
      >
        {isPlaying ? (
          <span className="flex items-center gap-0.5">
            <span className="h-3 w-1 rounded-full bg-current animate-pulse" />
            <span className="h-3 w-1 rounded-full bg-current animate-pulse delay-75" />
          </span>
        ) : (
          <Play className="h-4 w-4 fill-current ml-0.5" />
        )}
      </button>

      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-0.5 h-6">
          {bars.map((height, i) => {
            const barProgress = (i / bars.length) * 100;
            const isActive = progress >= barProgress;
            return (
              <span
                key={i}
                style={{
                  height: `${isPlaying ? Math.max(20, Math.min(100, height * (0.7 + (i % 3) * 0.2))) : height}%`,
                }}
                className={cn(
                  "w-1 rounded-full transition-all duration-150",
                  isActive
                    ? isMine
                      ? "bg-white"
                      : "bg-brand"
                    : isMine
                      ? "bg-white/40"
                      : "bg-muted-foreground/30",
                )}
              />
            );
          })}
        </div>
        <div
          className={cn(
            "flex justify-between text-[10px] font-semibold",
            isMine ? "text-white/80" : "text-muted-foreground",
          )}
        >
          <span>{isPlaying ? `${Math.floor((progress / 100) * duration)}s` : "Voice Note"}</span>
          <span>{duration}s</span>
        </div>
      </div>

      {/* A recording is the one attachment type people most want to keep, and the
          fake animated bars give no way to save it. */}
      {audioUrl && (
        <MediaDownloadButton
          url={audioUrl}
          name={`voice-note.${extensionOf(fileNameFromUrl(audioUrl) ?? "") || "webm"}`}
          title="Download voice note"
          className={cn(
            "h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            isMine
              ? "bg-white/20 text-white hover:bg-white/30"
              : "bg-foreground/5 hover:bg-foreground/10",
          )}
        />
      )}
    </div>
  );
}

function ConvsSkeleton() {
  return (
    <div className="space-y-2 p-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl p-3">
          <Skeleton className="h-11 w-11 rounded-full shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex justify-between items-center">
              <Skeleton className="h-4 w-28 rounded-md" />
              <Skeleton className="h-3 w-10 rounded-md" />
            </div>
            <Skeleton className="h-3 w-40 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

function MessagesPage() {
  const search = Route.useSearch();
  const targetUserParam = search.user || search.id;

  const { user: authUser, loading: authLoading } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [activeId, setActiveId] = useState<string>("");
  const [all, setAll] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [typingIn, setTypingIn] = useState<Record<string, number>>({});
  const lastTypingSentRef = useRef(0);

  const [query, setQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  // Calls are handled by the single global CallModal rendered inside
  // <IncomingCallProvider> (mounted at the app root). This page only dials; the
  // second, page-local copy of the ring/accept/modal UI here is what produced
  // the duplicate call screen and shadowed the app-wide presence channel.
  const { startCall } = useCallDialer();
  const presence = usePresenceMap();
  const [showInfo, setShowInfo] = useState(false);
  const [showTipModal, setShowTipModal] = useState(false);
  const [showNewMsgModal, setShowNewMsgModal] = useState(false);
  const [newMsgQuery, setNewMsgQuery] = useState("");
  const [sending, setSending] = useState(false);

  // Edit message state
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // Voice note simulation state
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const recordTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Message reactions loaded from the backend: Record<msgId, Record<emoji, count>>
  const [reactions, setReactions] = useState<Record<string, Record<string, number>>>({});
  const [myReactions, setMyReactions] = useState<Record<string, string[]>>({});

  // Attachment Popover and Lightbox state
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  // The composer's emoji panel, and the message id whose reaction is being
  // chosen when the custom picker is open.
  const [showEmoji, setShowEmoji] = useState(false);
  const [reactionFor, setReactionFor] = useState<string | null>(null);

  // Staged attachments: selecting a file ONLY queues it here with a local
  // preview; nothing is uploaded or sent until the user presses Send. This
  // replaces the old behaviour where picking a media file dispatched it
  // immediately (and where documents silently failed against the upload
  // allowlist).
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  function stageFiles(files: File[]) {
    if (files.length === 0) return;
    const next: PendingAttachment[] = files.map((file, i) => {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const isMedia =
        /^(image|video|audio)\//.test(file.type) ||
        [
          "png",
          "jpg",
          "jpeg",
          "webp",
          "gif",
          "avif",
          "mp4",
          "webm",
          "mov",
          "mp3",
          "wav",
          "ogg",
          "m4a",
        ].includes(ext);
      const previewUrl = /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : "";
      return {
        id: `att_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`,
        file,
        name: file.name,
        sizeLabel: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        isMedia,
        previewUrl,
      };
    });
    setPendingAttachments((prev) => [...prev, ...next]);
  }
  function dropAttachment(id: string) {
    setPendingAttachments((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  const [candidateUsers, setCandidateUsers] = useState<Profile[]>([]);

  useEffect(() => {
    getUsers()
      .then((res) => {
        const list = res?.profiles || [];
        if (list.length > 0) {
          setCandidateUsers(list.filter((u) => u.id !== currentUserId));
        }
      })
      .catch(() => {});
  }, []);

  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const now = useLiveNow();

  // Load conversations from backend (only once we know who is signed in)
  useEffect(() => {
    if (authLoading) return;
    if (!authUser?.id) {
      // Signed out: stop the skeleton so the empty state is reachable.
      setConvsLoading(false);
      return;
    }
    setConvsLoading(true);
    getConversations()
      .then((data) => {
        if (data && data.length > 0) {
          let targetConvId = activeId || data[0].id;

          // If target user was passed in URL query param
          if (targetUserParam) {
            const cleanTarget = targetUserParam.replace(/^@/, "");
            const found = data.find(
              (c) => c.participant_id === targetUserParam || c.participant_id === cleanTarget,
            );
            if (found) {
              targetConvId = found.id;
            } else {
              // Create temporary conversation for this participant
              const resolved = getProfile(targetUserParam);
              const newConvId = `c_${resolved.id}_${Date.now()}`;
              const newConv: Conversation = {
                id: newConvId,
                participant_id: resolved.id,
                preview: "Direct message thread",
                updated_at: new Date().toISOString(),
                unread: 0,
                online: true,
              };
              data.unshift(newConv);
              targetConvId = newConvId;
            }
            setMobileOpen(true);
          }

          const targetConv = data.find((c) => c.id === targetConvId);
          if (targetConv && targetConv.unread > 0) {
            decrementUnreadMessages(targetConv.unread);
          }
          const initialData = data.map((c) => (c.id === targetConvId ? { ...c, unread: 0 } : c));
          setConversations(initialData);
          setActiveId(targetConvId);
        } else if (targetUserParam) {
          // If no conversations existed yet, start one with target
          const resolved = getProfile(targetUserParam);
          const newConvId = `c_${resolved.id}_${Date.now()}`;
          const newConv: Conversation = {
            id: newConvId,
            participant_id: resolved.id,
            preview: "Direct message thread",
            updated_at: new Date().toISOString(),
            unread: 0,
            online: true,
          };
          setConversations([newConv]);
          setActiveId(newConvId);
          setMobileOpen(true);
        }
      })
      .catch((err) => console.warn("Conversations load:", err))
      .finally(() => setConvsLoading(false));
  }, [targetUserParam, authLoading, authUser?.id]);

  function selectConversation(id: string) {
    const conv = conversations.find((c) => c.id === id);
    if (conv && conv.unread > 0) {
      decrementUnreadMessages(conv.unread);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
    }
    setActiveId(id);
    setMobileOpen(true);
  }

  // Load messages for the active conversation
  useEffect(() => {
    // Placeholder threads (not yet saved) have nothing to fetch.
    if (!activeId || activeId.startsWith("c_")) return;
    getMessages(activeId)
      .then((msgs) => {
        setAll((prev) => {
          const others = prev.filter((m) => m.conversation_id !== activeId);
          return [...others, ...(msgs ?? [])];
        });
      })
      .catch((err) => console.warn("Messages load:", err));
    getMessageReactions(activeId)
      .then(({ counts, mine }) => {
        setReactions(counts);
        setMyReactions(mine);
      })
      .catch(() => {});
  }, [activeId]);

  const active =
    (activeId ? conversations.find((c) => c.id === activeId) : conversations[0]) || null;
  const partner = active ? getProfile(active.participant_id) : null;
  const thread = useMemo(() => all.filter((m) => m.conversation_id === activeId), [all, activeId]);

  const list = conversations.filter((c) => {
    const p = getProfile(c.participant_id);
    const q = query.toLowerCase();
    return !q || p.display_name.toLowerCase().includes(q) || p.username.includes(q);
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread.length]);

  // Realtime hook for incoming messages
  useRealtime(
    (event) => {
      const isNewMessage =
        event.type === "message" ||
        event.type === "new_message" ||
        event.type === "message:created";
      const msg = event.message || event.data || (isNewMessage && event.id ? event : null);
      if (isNewMessage && msg) {
        const msgBody = msg.body || msg.content || "";
        const msgSender = msg.sender_id || (partner ? partner.id : "");
        const msgConvId = msg.conversation_id || activeId;

        setAll((prev) => {
          // If already in thread by ID, skip
          if (prev.some((m) => m.id === msg.id)) return prev;

          // Client-generated ids mean our own optimistic bubble already has the
          // real message id — this is a metadata refresh (media url, delivered/read).
          if (msgSender === currentUserId) {
            const matchIndex = prev.findIndex((m) => {
              if (m.sender_id !== currentUserId || m.conversation_id !== msgConvId) return false;
              if (m.id === msg.id) return true;
              if (m.body === msgBody) return true;
              if (m.body.includes("Voice Note") && msgBody.includes("Voice Note")) {
                return m.body.split(" [")[0] === msgBody.split(" [")[0];
              }
              return false;
            });
            if (matchIndex !== -1) {
              const updated = [...prev];
              updated[matchIndex] = {
                ...updated[matchIndex],
                id: msg.id || updated[matchIndex].id,
                body: msgBody, // Sync with final uploaded media URL
              };
              const seen = new Set<string>();
              return updated.filter((item) => {
                if (seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
              });
            }
          }

          const newList = [
            ...prev,
            {
              id: msg.id || `m_${Date.now()}`,
              conversation_id: msgConvId,
              sender_id: msgSender,
              body: msgBody,
              created_at: msg.created_at || new Date().toISOString(),
              media_url: msg.media_url,
            },
          ];
          const seen = new Set<string>();
          return newList.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
        });

        setConversations((prev) => {
          const known = prev.some((c) => c.id === msgConvId);
          if (!known) {
            // A brand-new thread from someone else: pull it from the backend.
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
      }

      if (event.type === "message:reaction" && event.messageId && event.emoji) {
        if (event.userId === currentUserId) return;
        setReactions((prev) => {
          const msgMap = { ...(prev[event.messageId] || {}) };
          const next = (msgMap[event.emoji] ?? 0) + (event.on ? 1 : -1);
          if (next <= 0) delete msgMap[event.emoji];
          else msgMap[event.emoji] = next;
          return { ...prev, [event.messageId]: msgMap };
        });
      }

      if (event.type === "message:edited" && event.id) {
        setAll((prev) =>
          prev.map((m) => (m.id === event.id ? { ...m, body: event.body, is_edited: true } : m)),
        );
      }

      if (event.type === "message:deleted" && event.id) {
        setAll((prev) => prev.filter((m) => m.id !== event.id));
      }

      if (
        event.type === "message:read" &&
        event.conversationId &&
        event.readerId !== currentUserId
      ) {
        setAll((prev) =>
          prev.map((m) =>
            m.conversation_id === event.conversationId &&
            m.sender_id === currentUserId &&
            !m.read_at
              ? {
                  ...m,
                  read_at: event.at || new Date().toISOString(),
                  delivered_at: m.delivered_at || event.at,
                }
              : m,
          ),
        );
      }

      if (event.type === "message:delivered" && event.conversationId) {
        setAll((prev) =>
          prev.map((m) =>
            m.conversation_id === event.conversationId &&
            m.sender_id === currentUserId &&
            !m.delivered_at
              ? { ...m, delivered_at: event.at || new Date().toISOString() }
              : m,
          ),
        );
      }

      if (event.type === "message:typing" && event.userId && event.userId !== currentUserId) {
        setTypingIn((prev) => ({ ...prev, [event.conversationId]: Date.now() }));
      }
    },
    [
      "message",
      "new_message",
      "message:reaction",
      "message:edited",
      "message:deleted",
      "message:read",
      "message:delivered",
      "message:typing",
    ],
  );

  // Expire typing indicators a few seconds after the last keystroke.
  useEffect(() => {
    const timer = setInterval(() => {
      setTypingIn((prev) => {
        const cutoff = Date.now() - 4000;
        let changed = false;
        const next: Record<string, number> = {};
        for (const [key, at] of Object.entries(prev)) {
          const atNum = Number(at);
          if (atNum > cutoff) next[key] = atNum;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  function notifyTyping() {
    if (!activeId) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2000) return;
    lastTypingSentRef.current = now;
    emitRealtime("message:typing", { conversationId: activeId, userId: currentUserId });
  }

  /**
   * Puts an emoji where the caret is, not at the end of the line.
   *
   * Appending is what people notice: type "see you ", pick 🙏, and the glyph
   * lands after the next word you wrote instead of where you left off.
   */
  function insertDraftEmoji(emoji: string) {
    const el = draftInputRef.current;
    const before = draft;
    const start = el?.selectionStart ?? before.length;
    const end = el?.selectionEnd ?? before.length;
    const next = `${before.slice(0, start)}${emoji}${before.slice(end)}`;
    // The composer caps what you can type; a picker writing straight into state
    // bypasses that, so it has to respect the same ceiling.
    if (messageLength(next) > MAX_MESSAGE_CHARS) return;
    setDraft(next);
    notifyTyping();
    const caret = start + emoji.length;
    requestAnimationFrame(() => {
      const input = draftInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  }

  /**
   * Saves a message to the backend. Threads started in the UI only exist
   * locally until the first message, so send to the person and adopt the real
   * thread id the backend hands back.
   */
  async function persistMessage(body: string, tempId: string, mediaUrl?: string | null) {
    const conv = conversations.find((c) => c.id === activeId);
    const target = activeId.startsWith("c_") && conv ? conv.participant_id : activeId;
    const res: any = await sendMessage(target, body, mediaUrl ?? null, tempId);
    const serverMsg = res?.message ?? res;
    const realId: string = res?.conversationId ?? activeId;
    const stale = activeId;

    if (realId && realId !== stale) {
      setConversations((prev) => prev.map((c) => (c.id === stale ? { ...c, id: realId } : c)));
      setActiveId(realId);
    }
    setAll((prev) => {
      const updated = prev.map((m) =>
        m.id === tempId
          ? {
              ...m,
              id: serverMsg?.id ?? m.id,
              conversation_id: realId,
              body: serverMsg?.body ?? m.body,
            }
          : m.conversation_id === stale
            ? { ...m, conversation_id: realId }
            : m,
      );
      const seen = new Set<string>();
      return updated.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
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
    const staged = pendingAttachments;
    if (!body && staged.length === 0) return;
    // Enter in the text field reaches here without the button's `disabled`, and
    // the optimistic bubble would have been rendered before the write refused it.
    if (!isMessageWithinLimit(body)) {
      toast.error(messageLengthError(body) ?? "That message is too long.");
      return;
    }

    setSending(true);
    // Clear the composer up front so a second press can never double-send the
    // same queue; on failure we roll back only the text draft, never uploads.
    setPendingAttachments([]);
    if (body) setDraft("");

    try {
      // 1. The caption / text message first, if there is one.
      if (body) {
        const tempId = crypto.randomUUID();
        const newMsg: Message = {
          id: tempId,
          conversation_id: activeId,
          sender_id: currentUserId,
          body,
          created_at: new Date().toISOString(),
        };
        setAll((prev) => [...prev, newMsg]);
        try {
          await persistMessage(body, tempId);
        } catch (err: any) {
          // Never pretend an unsent message was delivered.
          setAll((prev) => prev.filter((m) => m.id !== tempId));
          setDraft(body);
          toast.error(friendlyError(err, "Message could not be sent"));
        }
      }

      // 2. Then each staged file — uploaded on demand and sent in order, so a
      //    photo/video renders inline and any other file becomes a download card.
      for (const att of staged) {
        // messages.id is a UUID column and sendMessage writes this client id
        // straight into it, so the optimistic id must be a real UUID (a
        // `temp_file_…` string previously failed with `invalid input syntax for
        // type uuid`). att.id stays the toast/handle id.
        const tempId = crypto.randomUUID();
        try {
          toast.loading(`Uploading ${att.name} (${att.sizeLabel})…`, { id: att.id });
          const res = await uploadMedia(att.file, "messages");
          toast.success(`Sent ${att.name}`, { id: att.id });
          const bodyString = att.isMedia ? res.url : `📄 Document: [${att.name}] [${res.url}]`;
          const newMsg: Message = {
            id: tempId,
            conversation_id: activeId,
            sender_id: currentUserId,
            body: bodyString,
            created_at: new Date().toISOString(),
          };
          setAll((prev) => [...prev, newMsg]);
          await persistMessage(bodyString, tempId, res.url);
        } catch (err: any) {
          toast.error(friendlyError(err, `Could not send ${att.name}`), { id: att.id });
          setAll((prev) => prev.filter((m) => m.id !== tempId));
        } finally {
          if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
        }
      }
    } finally {
      setSending(false);
    }
  }

  const handleToggleReaction = (msgId: string, emoji: string) => {
    const alreadyMine = (myReactions[msgId] || []).includes(emoji);
    const turnOn = !alreadyMine;

    // Optimistic update
    setReactions((prev) => {
      const msgMap = { ...(prev[msgId] || {}) };
      const next = (msgMap[emoji] ?? 0) + (turnOn ? 1 : -1);
      if (next <= 0) delete msgMap[emoji];
      else msgMap[emoji] = next;
      return { ...prev, [msgId]: msgMap };
    });
    setMyReactions((prev) => {
      const list = prev[msgId] || [];
      return {
        ...prev,
        [msgId]: turnOn ? [...list, emoji] : list.filter((e) => e !== emoji),
      };
    });

    void toggleMessageReaction(msgId, emoji, turnOn).catch(() => {
      // Roll back on failure
      setReactions((prev) => {
        const msgMap = { ...(prev[msgId] || {}) };
        const next = (msgMap[emoji] ?? 0) + (turnOn ? -1 : 1);
        if (next <= 0) delete msgMap[emoji];
        else msgMap[emoji] = next;
        return { ...prev, [msgId]: msgMap };
      });
      setMyReactions((prev) => {
        const list = prev[msgId] || [];
        return {
          ...prev,
          [msgId]: turnOn ? list.filter((e) => e !== emoji) : [...list, emoji],
        };
      });
      toast.error("Couldn't save that reaction");
    });
  };

  const handleStartEdit = (msg: Message) => {
    setEditingMsgId(msg.id);
    setEditDraft(msg.body);
  };

  const handleSaveEdit = (msgId: string) => {
    const body = editDraft.trim();
    if (!body) return;
    const original = all.find((m) => m.id === msgId);
    setAll((prev) => prev.map((m) => (m.id === msgId ? { ...m, body, is_edited: true } : m)));
    setEditingMsgId(null);
    setEditDraft("");
    void editMessage(msgId, body)
      .then(() => toast.success("Message edited"))
      .catch(() => {
        if (original) setAll((prev) => prev.map((m) => (m.id === msgId ? original : m)));
        toast.error("Couldn't edit that message");
      });
  };

  const handleDeleteMessage = (msgId: string) => {
    const targetMsg = all.find((m) => m.id === msgId);
    setAll((prev) => prev.filter((m) => m.id !== msgId));
    void deleteMessage(msgId)
      .then(() => toast.success("Message deleted"))
      .catch(() => {
        if (targetMsg) setAll((prev) => [...prev, targetMsg]);
        toast.error("Couldn't delete that message");
      });
  };

  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start();

      setIsRecording(true);
      setRecordDuration(0);
      recordTimerRef.current = setInterval(() => {
        setRecordDuration((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Failed to start voice recording:", err);
      toast.error("Microphone access denied or error starting recording");
    }
  };

  const cancelVoiceRecording = () => {
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Already stopped or disposed; the tracks below still need releasing.
      }
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
    }
    setIsRecording(false);
    setRecordDuration(0);
  };

  const sendVoiceNote = async () => {
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    setIsRecording(false);
    const duration = recordDuration || 1;
    setRecordDuration(0);

    const mediaRecorder = mediaRecorderRef.current;
    if (!mediaRecorder) {
      toast.error("No active recording found");
      return;
    }

    return new Promise<void>((resolve) => {
      mediaRecorder.onstop = async () => {
        mediaRecorder.stream.getTracks().forEach((track) => track.stop());

        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const audioFile = new (window.File || Blob)([audioBlob], `voice_note_${Date.now()}.webm`, {
          type: "audio/webm",
        }) as File;

        // Must be a real UUID: sendMessage writes this optimistic id straight
        // into the messages.id (uuid) column, so `temp_voice_…` used to fail the
        // same way file attachments did.
        const tempId = crypto.randomUUID();
        const tempLocalUrl = URL.createObjectURL(audioBlob);
        const tempBody = `🎙️ Voice Note (${duration}s) [${tempLocalUrl}]`;

        const newMsg: Message = {
          id: tempId,
          conversation_id: activeId,
          sender_id: currentUserId,
          body: tempBody,
          created_at: new Date().toISOString(),
        };

        setAll((prev) => [...prev, newMsg]);

        try {
          toast.loading("Uploading voice note...", { id: "voice-upload" });
          const res = await uploadMedia(audioFile, "messages");
          toast.success("Voice note uploaded", { id: "voice-upload" });

          const realBody = `🎙️ Voice Note (${duration}s) [${res.url}]`;
          await persistMessage(realBody, tempId, res.url);
        } catch (err) {
          console.error("Voice note upload failed:", err);
          setAll((prev) => prev.filter((m) => m.id !== tempId));
          toast.error("Failed to upload voice note", { id: "voice-upload" });
        }
        resolve();
      };

      mediaRecorder.stop();
    });
  };

  // Selecting a file only STAGES it in the composer (preview + name); the
  // bytes are uploaded and the message sent when the user presses Send.
  function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    stageFiles(Array.from(e.target.files || []));
    e.target.value = "";
  }

  function startChatWithUser(user: { id: string; username: string; display_name: string }) {
    setShowNewMsgModal(false);
    const existing = conversations.find((c) => c.participant_id === user.id);
    if (existing) {
      selectConversation(existing.id);
      return;
    }
    const newConvId = `c_${user.id}_${Date.now()}`;
    const newConv: Conversation = {
      id: newConvId,
      participant_id: user.id,
      preview: "Started a conversation",
      updated_at: new Date().toISOString(),
      unread: 0,
      online: true,
    };
    setConversations([newConv, ...conversations]);
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

  return (
    <AppShell title="Messages">
      <div className="glass-panel grid h-[calc(100dvh-8.5rem)] grid-cols-1 overflow-hidden rounded-3xl shadow-soft lg:h-[calc(100dvh-3rem)] lg:grid-cols-[20rem_1fr]">
        {/* conversation list */}
        <div
          className={cn(
            "flex min-h-0 flex-col border-border/60 lg:flex lg:border-r",
            mobileOpen ? "hidden" : "flex",
          )}
        >
          <div className="border-b border-border/60 p-4">
            <div className="flex items-center justify-between mb-3">
              <h1 className="text-xl font-extrabold tracking-tight">Messages</h1>
              <button
                type="button"
                onClick={() => setShowNewMsgModal(true)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-brand/10 hover:bg-brand/20 text-brand text-xs font-bold transition-all active:scale-95 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New</span>
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-full bg-foreground/5 px-4 py-2.5">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search conversations"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-width:thin]">
            {convsLoading ? (
              <ConvsSkeleton />
            ) : (
              <>
                {list.map((c) => {
                  const p = getProfile(c.participant_id);
                  const isActive = c.id === activeId;
                  const kind = attachmentKind(c.preview);
                  const PreviewIcon =
                    kind === "image"
                      ? ImageIcon
                      : kind === "video"
                        ? Film
                        : kind === "audio"
                          ? Music
                          : kind
                            ? FileText
                            : null;
                  return (
                    <button
                      key={c.id}
                      onClick={() => selectConversation(c.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all duration-200 cursor-pointer border",
                        isActive
                          ? "bg-brand/10 text-foreground border-brand/25 shadow-xs"
                          : "hover:bg-muted/40 border-transparent",
                      )}
                    >
                      <span className="relative">
                        <Avatar
                          name={p.display_name}
                          src={p.avatar_url}
                          className="h-11 w-11 text-xs"
                        />
                        {presence[c.participant_id]?.online && (
                          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-card" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-bold">{p.display_name}</span>
                          <TimeAgo
                            iso={c.updated_at}
                            className="shrink-0 text-[0.7rem] text-muted-foreground"
                          />
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <span className="line-clamp-1 flex-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                            {PreviewIcon && (
                              <PreviewIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                            )}
                            <span className="truncate">{previewLabel(c.preview)}</span>
                          </span>
                          {c.unread > 0 && (
                            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-gradient-to-r from-brand to-brand-pink px-1.5 text-[0.65rem] font-bold text-white">
                              {c.unread}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {list.length === 0 && (
                  <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
                    <p>No conversations found.</p>
                    <button
                      onClick={() => setShowNewMsgModal(true)}
                      className="px-4 py-2 rounded-full bg-brand text-white text-xs font-bold hover:bg-brand/90 transition-all cursor-pointer"
                    >
                      Start a conversation
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* thread */}
        <div className={cn("flex min-h-0 flex-col", mobileOpen ? "flex" : "hidden lg:flex")}>
          {!active || !partner ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                Select a conversation or start a new message to begin.
              </p>
              <button
                onClick={() => setShowNewMsgModal(true)}
                className="px-4 py-2 rounded-full bg-brand text-white text-xs font-bold hover:bg-brand/90 transition-all cursor-pointer"
              >
                Send a Direct Message
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border/60 p-3 sm:gap-3 sm:p-4">
                <button
                  onClick={() => setMobileOpen(false)}
                  aria-label="Back to conversations"
                  className="rounded-full p-2 transition-colors hover:bg-foreground/5 lg:hidden cursor-pointer"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <Link
                  to="/profile"
                  search={{ id: partner.id, user: partner.username }}
                  className="shrink-0 transition-transform hover:scale-105 active:scale-95"
                >
                  <Avatar
                    name={partner.display_name}
                    src={partner.avatar_url}
                    className="h-10 w-10 text-xs"
                  />
                </Link>
                <div className="min-w-0 flex-1">
                  <Link
                    to="/profile"
                    search={{ id: partner.id, user: partner.username }}
                    className="truncate block text-sm font-bold hover:text-brand hover:underline transition-colors"
                  >
                    {partner.display_name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground flex items-center gap-1.5">
                    {presence[partner.id]?.online ? (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                          Online now
                        </span>
                      </>
                    ) : (
                      `Active ${timeAgo(active.updated_at, now)} ago`
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  {/* Tip Button */}
                  <button
                    onClick={() => setShowTipModal(true)}
                    title={`Send a tip to ${partner.display_name}`}
                    className="flex items-center gap-1 rounded-full bg-amber-500/15 hover:bg-amber-500/25 text-amber-600 dark:text-amber-400 px-3 py-1.5 text-xs font-bold transition-all min-h-[36px] cursor-pointer"
                  >
                    <DollarSign className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Tip</span>
                  </button>

                  <button
                    onClick={() => startCall(partner, "audio")}
                    aria-label="Start Voice Call"
                    className="rounded-full p-2 transition-all duration-300 hover:bg-foreground/5 hover:text-foreground min-h-[38px] min-w-[38px] flex items-center justify-center cursor-pointer"
                  >
                    <Phone className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => startCall(partner, "video")}
                    aria-label="Start Video Call"
                    className="rounded-full p-2 transition-all duration-300 hover:bg-foreground/5 hover:text-foreground min-h-[38px] min-w-[38px] flex items-center justify-center cursor-pointer"
                  >
                    <Video className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setShowInfo(true)}
                    aria-label="Conversation Info"
                    className="rounded-full p-2 transition-all duration-300 hover:bg-foreground/5 hover:text-foreground min-h-[38px] min-w-[38px] flex items-center justify-center cursor-pointer"
                  >
                    <Info className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 sm:p-4 [scrollbar-width:thin]">
                {thread.map((m, idx) => {
                  const mine = m.sender_id === currentUserId;
                  const isLatestMine = mine && idx === thread.length - 1;
                  const msgReactions = reactions[m.id] || {};
                  const isEditingThis = editingMsgId === m.id;
                  const prev = idx > 0 ? thread[idx - 1] : null;
                  const next = idx < thread.length - 1 ? thread[idx + 1] : null;
                  const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
                  // Group runs from the same person so only the last one is timestamped.
                  const startsGroup = newDay || prev?.sender_id !== m.sender_id;
                  const endsGroup =
                    !next ||
                    next.sender_id !== m.sender_id ||
                    dayKey(next.created_at) !== dayKey(m.created_at);

                  // Attachment Type Detection for sleek media frames
                  const kind = attachmentKind(m.body);
                  const isImage = kind === "image";
                  const isVideo = kind === "video";
                  const isAudio = kind === "audio";
                  const isDoc =
                    kind === "pdf" ||
                    kind === "document" ||
                    m.body.startsWith("📄") ||
                    m.body.startsWith("📎");
                  const isVoice = m.body.includes("Voice Note") || m.body.includes("🎙️");
                  const isAttachment = isImage || isVideo || isAudio || isDoc || isVoice;

                  return (
                    <div key={m.id}>
                      {newDay && (
                        <div className="my-4 flex items-center gap-3">
                          <span className="h-px flex-1 bg-border/60" />
                          <span className="rounded-full bg-foreground/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                            {dayLabel(m.created_at)}
                          </span>
                          <span className="h-px flex-1 bg-border/60" />
                        </div>
                      )}
                      <div
                        className={cn(
                          "group relative flex items-end gap-1.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200",
                          startsGroup ? "mt-3" : "mt-0.5",
                          mine ? "justify-end" : "justify-start",
                        )}
                      >
                        <div
                          className={cn(
                            "relative max-w-[88%] rounded-3xl text-xs leading-relaxed shadow-soft transition-all sm:max-w-[72%] sm:text-sm border",
                            // Beautiful frames
                            mine
                              ? "bg-gradient-to-br from-brand to-brand-pink border-white/10 text-white"
                              : "bg-foreground/5 border-black/5 dark:border-white/5",
                            // Compact frames for attachments vs text messages
                            isAttachment
                              ? isImage || isVideo || isDoc
                                ? "p-1" // Very small frame border distance (4px)
                                : "p-1.5 sm:p-2" // Compact cozy framing for voice/audio
                              : "px-3.5 py-2 sm:px-4 sm:py-2.5",
                            mine
                              ? endsGroup
                                ? "rounded-br-lg"
                                : "rounded-br-3xl"
                              : endsGroup
                                ? "rounded-bl-lg"
                                : "rounded-bl-3xl",
                          )}
                        >
                          {isEditingThis ? (
                            /* Inline Edit Mode */
                            <div className="space-y-2 min-w-[200px] text-foreground">
                              <input
                                type="text"
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleSaveEdit(m.id)}
                                className="w-full rounded-xl bg-card border border-border px-3 py-1.5 text-xs sm:text-sm outline-none text-foreground"
                                autoFocus
                              />
                              <div className="flex items-center justify-end gap-2 text-xs">
                                <button
                                  type="button"
                                  onClick={() => setEditingMsgId(null)}
                                  className="px-2 py-1 rounded-lg bg-white/20 text-white hover:bg-white/30 transition-colors"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSaveEdit(m.id)}
                                  className="px-2.5 py-1 rounded-lg bg-emerald-500 text-white font-bold hover:bg-emerald-600 transition-colors flex items-center gap-1"
                                >
                                  <Check className="h-3 w-3" /> Save
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {isVoice ? (
                                <VoiceNotePlayer body={m.body} isMine={mine} />
                              ) : isImage ? (
                                <div
                                  className={cn(
                                    "my-0.5 overflow-hidden max-w-[260px] sm:max-w-[320px] shadow-xs cursor-zoom-in relative bg-neutral-950/20 dark:bg-black/30",
                                    mine
                                      ? endsGroup
                                        ? "rounded-[20px] rounded-br-[4px]"
                                        : "rounded-[20px]"
                                      : endsGroup
                                        ? "rounded-[20px] rounded-bl-[4px]"
                                        : "rounded-[20px]",
                                  )}
                                >
                                  <AuthorizedImg
                                    src={optimizeImageUrl(m.body, 600)}
                                    alt="Attachment"
                                    loading="lazy"
                                    className="max-h-72 w-full cursor-zoom-in object-cover transition-transform duration-500 hover:scale-[1.03]"
                                    onClick={() => setLightboxImage(m.body)}
                                  />
                                </div>
                              ) : isVideo ? (
                                <div
                                  className={cn(
                                    "overflow-hidden max-w-[280px] sm:max-w-[340px] shadow-xs relative bg-black/40",
                                    mine
                                      ? endsGroup
                                        ? "rounded-[20px] rounded-br-[4px]"
                                        : "rounded-[20px]"
                                      : endsGroup
                                        ? "rounded-[20px] rounded-bl-[4px]"
                                        : "rounded-[20px]",
                                  )}
                                >
                                  {m.body ? <SafeVideoAttachment src={m.body} /> : null}
                                </div>
                              ) : isAudio ? (
                                m.body ? (
                                  <SafeAudioAttachment src={m.body} />
                                ) : null
                              ) : isDoc ? (
                                <DocumentCardAttachment body={m.body} isMine={mine} />
                              ) : (
                                <MessageText body={m.body} isMine={mine} />
                              )}

                              {/* Timestamp & Status footer — only on the last of a run */}
                              <div
                                className={cn(
                                  "mt-1 flex items-center gap-1.5 text-[0.65rem]",
                                  mine ? "text-white/80 justify-end" : "text-muted-foreground",
                                  endsGroup ? "" : "hidden",
                                )}
                              >
                                <span>{timeAgo(m.created_at, now)}</span>
                                {(m as any).is_edited && (
                                  <span className="italic opacity-80">(edited)</span>
                                )}
                                {mine && (
                                  <span
                                    className="flex items-center gap-0.5 ml-1"
                                    title={
                                      m.read_at ? "Seen" : m.delivered_at ? "Delivered" : "Sent"
                                    }
                                  >
                                    {m.read_at ? (
                                      <CheckCheck className="h-3.5 w-3.5 text-sky-300" />
                                    ) : m.delivered_at ? (
                                      <CheckCheck className="h-3.5 w-3.5 text-white/70" />
                                    ) : (
                                      <Check className="h-3.5 w-3.5 text-white/70" />
                                    )}
                                  </span>
                                )}
                              </div>
                            </>
                          )}

                          {/* Display Reactions */}
                          {Object.keys(msgReactions).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {Object.entries(msgReactions).map(([emoji, count]) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={() => handleToggleReaction(m.id, emoji)}
                                  className={cn(
                                    "cursor-pointer text-[11px] backdrop-blur-xs px-2 py-0.5 rounded-full shadow-xs border hover:scale-105 transition-transform flex items-center gap-1 text-foreground",
                                    (myReactions[m.id] || []).includes(emoji)
                                      ? "bg-brand/15 border-brand/50"
                                      : "bg-background/80 dark:bg-card/90 border-border/40",
                                  )}
                                >
                                  <span>{emoji}</span>
                                  {Number(count) > 1 && (
                                    <span className="font-bold text-[10px] text-muted-foreground">
                                      {String(count)}
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Message Actions Hover Menu (Reactions, Edit, Delete) */}
                        {!isEditingThis && (
                          <div
                            className={cn(
                              "opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 bg-card/95 backdrop-blur-md border border-border/80 rounded-full px-1.5 py-1 shadow-md text-xs shrink-0",
                              mine ? "order-first" : "order-last",
                            )}
                          >
                            {QUICK_REACTIONS.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => handleToggleReaction(m.id, emoji)}
                                className="hover:scale-125 transition-transform p-0.5"
                                title={`React with ${emoji}`}
                              >
                                {emoji}
                              </button>
                            ))}

                            {/* The row cannot hold the whole set, but the database
                                stores any emoji, so it should not be limited to ten. */}
                            <button
                              type="button"
                              onClick={() => setReactionFor(m.id)}
                              className="p-0.5 text-muted-foreground transition-colors hover:text-brand"
                              title="Add a custom reaction"
                              aria-label="Add a custom reaction"
                            >
                              <SmilePlus className="h-3.5 w-3.5" />
                            </button>

                            {mine && (
                              <>
                                <span className="w-px h-3 bg-border/60 mx-0.5" />
                                <button
                                  type="button"
                                  onClick={() => handleStartEdit(m)}
                                  title="Edit message"
                                  className="p-1 text-muted-foreground hover:text-foreground rounded-full hover:bg-foreground/5 transition-colors"
                                >
                                  <Edit2 className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteMessage(m.id)}
                                  title="Delete message"
                                  className="p-1 text-muted-foreground hover:text-rose-500 rounded-full hover:bg-foreground/5 transition-colors"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Live typing indicator from the other person */}
                {typingIn[activeId] && (
                  <div className="flex items-center gap-2 pl-1 animate-in fade-in">
                    <Avatar
                      name={partner.display_name}
                      src={partner.avatar_url}
                      className="h-6 w-6 text-[10px]"
                    />
                    <span className="flex items-center gap-1 rounded-full bg-foreground/5 px-3 py-2">
                      {[0, 150, 300].map((delay) => (
                        <span
                          key={delay}
                          className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce"
                          style={{ animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </span>
                  </div>
                )}

                {/* Read status under the last message you sent */}
                {thread.length > 0 &&
                  thread[thread.length - 1].sender_id === currentUserId &&
                  thread[thread.length - 1].read_at && (
                    <div className="text-right pr-2">
                      <span className="text-[10px] text-muted-foreground font-semibold flex items-center justify-end gap-1">
                        <CheckCheck className="h-3 w-3 text-brand" /> Seen
                      </span>
                    </div>
                  )}

                <div ref={endRef} />
              </div>

              {/* Bottom Message Input bar */}
              <div className="border-t border-border/60 p-2.5 sm:p-3 relative">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileAttach}
                  multiple
                  accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar,.7z,.tar,.gz,.csv,.xlsx,.pptx,.json,.js,.ts,.py,.md"
                  className="hidden"
                />

                {/* Staged attachments preview strip — files wait here until Send */}
                {pendingAttachments.length > 0 && !isRecording && (
                  <div className="mb-2 flex gap-2 overflow-x-auto px-0.5 pb-1 pt-1 animate-in fade-in slide-in-from-bottom-2 [scrollbar-width:thin]">
                    {pendingAttachments.map((att) => (
                      <div key={att.id} className="relative shrink-0">
                        <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/40 shadow-xs">
                          {att.isMedia && att.previewUrl ? (
                            <img
                              src={att.previewUrl}
                              alt={att.name}
                              className="h-16 w-16 object-cover"
                            />
                          ) : (
                            <div className="flex h-16 w-40 items-center gap-2 px-2.5">
                              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
                                {att.isMedia ? (
                                  <Music className="h-4 w-4" />
                                ) : (
                                  <FileText className="h-4 w-4" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-[11px] font-bold leading-tight">
                                  {att.name}
                                </p>
                                <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                                  {att.sizeLabel}
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => dropAttachment(att.id)}
                          aria-label={`Remove ${att.name}`}
                          className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white shadow-sm ring-1 ring-white/30 backdrop-blur-sm transition-colors hover:bg-rose-600 cursor-pointer"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Attachment Menu Quick Popover */}
                {showAttachMenu && (
                  <div className="absolute bottom-full left-4 mb-2 z-40 w-56 rounded-2xl border border-border bg-card/95 backdrop-blur-md p-1.5 shadow-xl animate-in fade-in slide-in-from-bottom-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 py-1.5">
                      Send Attachment
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        if (fileInputRef.current) {
                          fileInputRef.current.accept = "image/*,video/*";
                          fileInputRef.current.click();
                        }
                      }}
                      className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold hover:bg-muted/80 transition-colors text-left cursor-pointer"
                    >
                      <ImageIcon className="h-4 w-4 text-sky-500" />
                      <span>Photos & Videos</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        if (fileInputRef.current) {
                          fileInputRef.current.accept =
                            ".pdf,.doc,.docx,.txt,.zip,.rar,.7z,.csv,.xlsx,.pptx,.json,.js,.ts,.py,.md";
                          fileInputRef.current.click();
                        }
                      }}
                      className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold hover:bg-muted/80 transition-colors text-left cursor-pointer"
                    >
                      <FileText className="h-4 w-4 text-rose-500" />
                      <span>Documents & PDFs</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        if (fileInputRef.current) {
                          fileInputRef.current.accept = "audio/*";
                          fileInputRef.current.click();
                        }
                      }}
                      className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold hover:bg-muted/80 transition-colors text-left cursor-pointer"
                    >
                      <Music className="h-4 w-4 text-emerald-500" />
                      <span>Audio Files</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        startVoiceRecording();
                      }}
                      className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold hover:bg-muted/80 transition-colors text-left cursor-pointer"
                    >
                      <Mic className="h-4 w-4 text-amber-500" />
                      <span>Voice Note</span>
                    </button>
                  </div>
                )}

                {isRecording ? (
                  /* Live voice recording state */
                  <div className="flex items-center justify-between rounded-full bg-rose-500/10 border border-rose-500/30 px-4 py-2 animate-in fade-in">
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500" />
                      </span>
                      <span className="text-xs font-bold text-rose-600 dark:text-rose-400">
                        Recording audio... {recordDuration}s
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={cancelVoiceRecording}
                        className="px-3 py-1 rounded-full bg-foreground/10 hover:bg-foreground/20 text-xs font-semibold text-muted-foreground transition-all cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={sendVoiceNote}
                        className="px-3 py-1 rounded-full bg-rose-500 text-white text-xs font-bold hover:bg-rose-600 transition-all flex items-center gap-1 cursor-pointer"
                      >
                        <Send className="h-3 w-3" /> Send
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 sm:gap-2 rounded-full bg-foreground/5 px-2.5 sm:px-3 py-1.5 sm:py-2">
                    <button
                      type="button"
                      onClick={() => setShowAttachMenu((prev) => !prev)}
                      title="Attach file, photo or document"
                      className={cn(
                        "rounded-full p-2 transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center shrink-0 cursor-pointer",
                        showAttachMenu
                          ? "bg-brand/20 text-brand"
                          : "text-muted-foreground hover:text-brand",
                      )}
                    >
                      <Paperclip className="h-4 w-4" />
                    </button>
                    <input
                      ref={draftInputRef}
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        notifyTyping();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      placeholder={`Message ${partner.display_name.split(" ")[0]}...`}
                      className="min-w-0 flex-1 bg-transparent text-xs sm:text-sm outline-none placeholder:text-muted-foreground"
                    />
                    {/* Only appears as you run out of room. Typing past the cap is
                        allowed on purpose — a hard maxLength silently eats a paste,
                        and the number goes negative so the reason is visible. */}
                    {shouldShowMessageCounter(draft) && (
                      <span
                        aria-label={`${messageCounterLabel(draft)} characters left in this message`}
                        className={cn(
                          "shrink-0 text-[10px] font-bold tabular-nums",
                          messageCharsOver(draft) > 0 ? "text-rose-500" : "text-muted-foreground",
                        )}
                      >
                        {messageCounterLabel(draft)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => startVoiceRecording()}
                      title="Record voice note"
                      className="rounded-full p-2 text-muted-foreground transition-colors hover:text-rose-500 min-h-[36px] min-w-[36px] flex items-center justify-center shrink-0 cursor-pointer"
                    >
                      <Mic className="h-4 w-4" />
                    </button>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setShowEmoji((open) => !open);
                          setShowAttachMenu(false);
                        }}
                        aria-expanded={showEmoji}
                        title="Pick an emoji"
                        className={cn(
                          "rounded-full p-2 transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center shrink-0 cursor-pointer",
                          showEmoji
                            ? "bg-brand/20 text-brand"
                            : "text-muted-foreground hover:text-brand",
                        )}
                      >
                        <Smile className="h-4 w-4" />
                      </button>
                      {showEmoji && (
                        <EmojiPicker
                          multiple
                          label="Emoji"
                          className="bottom-full right-0 mb-2"
                          onPick={insertDraftEmoji}
                          onClose={() => setShowEmoji(false)}
                        />
                      )}
                    </div>
                    <button
                      onClick={send}
                      disabled={
                        (!draft.trim() && pendingAttachments.length === 0) ||
                        sending ||
                        !isMessageWithinLimit(draft)
                      }
                      title={
                        isMessageWithinLimit(draft)
                          ? "Send message"
                          : `A message can be up to ${MAX_MESSAGE_CHARS} characters`
                      }
                      aria-label="Send message"
                      className="grid h-9 w-9 min-w-[36px] place-items-center rounded-full bg-gradient-to-r from-brand to-brand-pink text-white transition-all duration-300 hover:shadow-glow disabled:opacity-40 active:scale-95 shrink-0 cursor-pointer"
                    >
                      {sending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* New Direct Message Modal */}
      {showNewMsgModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div
            className="w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto custom-scrollbar rounded-3xl border border-border bg-card p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black tracking-tight">New Message</h3>
              <button
                onClick={() => setShowNewMsgModal(false)}
                className="rounded-full p-1 text-muted-foreground hover:bg-muted cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={newMsgQuery}
                onChange={(e) => setNewMsgQuery(e.target.value)}
                placeholder="Search creators & collaborators..."
                className="w-full rounded-2xl bg-muted/40 border border-border pl-9 pr-4 py-2.5 text-xs sm:text-sm outline-none focus:border-brand"
                autoFocus
              />
            </div>

            <div className="space-y-2 max-h-60 overflow-y-auto [scrollbar-width:thin]">
              <p className="text-[11px] font-bold uppercase text-muted-foreground px-1">
                Suggested Creators
              </p>
              {filteredStartUsers.map((user, idx) => (
                <button
                  key={`start-chat-${user.id}-${idx}`}
                  onClick={() => startChatWithUser(user)}
                  className="w-full flex items-center gap-3 p-2.5 rounded-2xl hover:bg-muted/50 transition-colors text-left cursor-pointer"
                >
                  <Avatar name={user.display_name} className="h-10 w-10 text-xs" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs sm:text-sm font-bold truncate">{user.display_name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      @{user.username} • {user.bio}
                    </p>
                  </div>
                  <span className="px-3 py-1 rounded-full bg-brand/10 text-brand text-[11px] font-bold">
                    Chat
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Active + incoming calls render through the single global CallModal in
          <IncomingCallProvider>; a page-local copy here caused the duplicate
          call screen. */}

      {/* Tip Modal */}
      {showTipModal && partner && (
        <TipModal
          isOpen={showTipModal}
          onClose={() => setShowTipModal(false)}
          recipient={partner}
        />
      )}

      {/* Image Attachment Lightbox Modal */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-4 animate-in fade-in"
          onClick={() => setLightboxImage(null)}
        >
          <div className="relative max-w-4xl max-h-[90dvh] flex flex-col items-center">
            <button
              onClick={() => setLightboxImage(null)}
              className="absolute -top-12 right-0 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 transition-colors cursor-pointer"
              title="Close"
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
                className="rounded-full bg-white/20 px-5 py-2 text-xs sm:text-sm text-white hover:bg-white/30"
              />
            </div>
          </div>
        </div>
      )}

      {/* Conversation Info Modal */}
      <InfoModal isOpen={showInfo} onClose={() => setShowInfo(false)} type="Privacy" />

      {/* Custom reaction picker. It lives at page level rather than inside the
          bubble because the message list is its own scroll container, and a panel
          anchored to a chat row gets clipped by it the moment you scroll. */}
      {reactionFor && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setReactionFor(null)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <EmojiPicker
              label="Add a reaction"
              className="relative bottom-0 m-3 w-[20rem]"
              onClose={() => setReactionFor(null)}
              onPick={(emoji) => {
                const target = reactionFor;
                setReactionFor(null);
                if (target) handleToggleReaction(target, sanitizeReactionEmoji(emoji));
              }}
            />
          </div>
        </div>
      )}
    </AppShell>
  );
}
