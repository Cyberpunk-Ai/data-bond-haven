import { ArrowLeft, DollarSign, Info, Phone, Video } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { Profile } from "@/lib/types";
import { Avatar } from "@/components/social/Avatar";

/**
 * The thread's top bar. Presence reads from the live presence map — "Online now"
 * when the partner is up, otherwise the supplied `lastActiveLabel`. It no longer
 * reuses `conversation.updated_at` as if that were a last-seen timestamp, which
 * told you someone was "active" minutes ago purely because a message arrived.
 */
export function ThreadHeader({
  partner,
  isOnline,
  lastActiveLabel,
  onBack,
  onTip,
  onVoice,
  onVideo,
  onInfo,
}: {
  partner: Profile;
  isOnline: boolean;
  lastActiveLabel: string;
  onBack: () => void;
  onTip: () => void;
  onVoice: () => void;
  onVideo: () => void;
  onInfo: () => void;
}) {
  const iconBtn =
    "flex min-h-[40px] min-w-[40px] cursor-pointer items-center justify-center rounded-full p-2 transition-all duration-300 hover:bg-foreground/5 hover:text-foreground";

  return (
    <div className="flex items-center gap-2 border-b border-border/60 p-3 sm:gap-3 sm:p-4">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to conversations"
        className="cursor-pointer rounded-full p-2 transition-colors hover:bg-foreground/5 lg:hidden"
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
          className="block truncate text-sm font-bold transition-colors hover:text-brand hover:underline"
        >
          {partner.display_name}
        </Link>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {isOnline ? (
            <>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                Online now
              </span>
            </>
          ) : (
            lastActiveLabel
          )}
        </p>
      </div>
      <div className="flex items-center gap-1 text-muted-foreground">
        <button
          type="button"
          onClick={onTip}
          title={`Send a tip to ${partner.display_name}`}
          className="flex min-h-[40px] cursor-pointer items-center gap-1 rounded-full bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-600 transition-all hover:bg-amber-500/25 dark:text-amber-400"
        >
          <DollarSign className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Tip</span>
        </button>
        <button type="button" onClick={onVoice} aria-label="Start Voice Call" className={iconBtn}>
          <Phone className="h-4 w-4" />
        </button>
        <button type="button" onClick={onVideo} aria-label="Start Video Call" className={iconBtn}>
          <Video className="h-4 w-4" />
        </button>
        <button type="button" onClick={onInfo} aria-label="Conversation info" className={iconBtn}>
          <Info className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
