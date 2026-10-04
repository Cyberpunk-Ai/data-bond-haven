import { useState } from "react";
import { EyeOff, Film, ImageIcon, MoreVertical, Music, FileText, Phone, Video } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { Conversation, Profile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TimeAgo } from "@/components/social/TimeAgo";
import { Avatar } from "@/components/social/Avatar";
import {
  attachmentKind,
  callPreviewLabel,
  isCallActivity,
  previewLabel,
} from "@/lib/message-helpers";

/**
 * One inbox row.
 *
 * The old row was a `role="button"` div with a nested hide button — invalid
 * nesting that made the hide control hard to reach with a keyboard and easy to
 * misclick on touch. This is a plain container whose whole clickable surface is a
 * real <button> (open), with the destructive action moved out into a small kebab
 * menu so the two never fight for the same tap.
 */
export function ConversationRow({
  conversation,
  profile,
  isActive,
  isOnline,
  onOpen,
  onHide,
}: {
  conversation: Conversation;
  profile: Profile;
  isActive: boolean;
  isOnline: boolean;
  onOpen: (id: string) => void;
  onHide: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const kind = attachmentKind(conversation.preview);
  // A call that beat the last message takes over the preview line — the same
  // glyph treatment photos/videos/files get, sourced from `calls` instead of
  // the (untouched) message preview.
  const lastWasCall = isCallActivity(conversation.last_call_at, conversation.updated_at);
  const PreviewIcon = lastWasCall
    ? conversation.last_call_kind === "video"
      ? Video
      : Phone
    : kind === "image"
      ? ImageIcon
      : kind === "video"
        ? Film
        : kind === "audio"
          ? Music
          : kind
            ? FileText
            : null;

  return (
    <div
      className={cn(
        "group/row relative flex items-center gap-3 rounded-xl border px-1 transition-all duration-200",
        isActive
          ? "border-brand/25 bg-brand/10 text-foreground shadow-xs"
          : "border-transparent hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(conversation.id)}
        aria-current={isActive ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <span className="relative shrink-0">
          <Avatar
            name={profile.display_name}
            src={profile.avatar_url}
            className="h-11 w-11 text-xs"
          />
          {isOnline && (
            <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-card" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-bold">{profile.display_name}</span>
            <TimeAgo
              iso={conversation.updated_at}
              className="shrink-0 text-[0.7rem] text-muted-foreground"
            />
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className="line-clamp-1 flex-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {PreviewIcon && <PreviewIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />}
              <span className="truncate">
                {lastWasCall
                  ? callPreviewLabel(conversation.last_call_kind)
                  : previewLabel(conversation.preview)}
              </span>
            </span>
            {conversation.unread > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-gradient-to-r from-brand to-brand-pink px-1.5 text-[0.65rem] font-bold text-white">
                {conversation.unread}
              </span>
            )}
          </span>
        </span>
      </button>

      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Options for ${profile.display_name}`}
          className={cn(
            "grid h-8 w-8 cursor-pointer place-items-center rounded-full text-muted-foreground transition-all hover:bg-foreground/5 hover:text-foreground focus:opacity-100",
            menuOpen ? "opacity-100" : "opacity-60 md:opacity-0 md:group-hover/row:opacity-100",
          )}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} aria-hidden />
            <div
              role="menu"
              className="absolute right-0 top-full z-40 mt-1 w-44 rounded-2xl border border-border/80 bg-card p-1 shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150"
            >
              <Link
                to="/profile"
                search={{ id: profile.id, user: profile.username }}
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs transition-colors hover:bg-foreground/5"
              >
                View profile
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onHide(conversation.id);
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs text-rose-600 transition-colors hover:bg-rose-500/10 dark:text-rose-400"
              >
                <EyeOff className="h-3.5 w-3.5" />
                Hide chat
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
