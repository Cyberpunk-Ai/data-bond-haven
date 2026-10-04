import { DollarSign, EyeOff, Flag, Phone, Video, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { Profile } from "@/lib/types";
import { Avatar } from "@/components/social/Avatar";
import { DialogShell } from "./DialogShell";

const TITLE_ID = "conversation-info-title";

/**
 * The sheet behind the thread's ⓘ — a real conversation summary, not the generic
 * Privacy policy it used to open. Shows the person you're chatting with and the
 * actions that belong to the thread itself (tip, call, hide, report).
 */
export function ConversationInfoSheet({
  open,
  onClose,
  partner,
  isOnline,
  onTip,
  onVoice,
  onVideo,
  onHide,
  onReport,
}: {
  open: boolean;
  onClose: () => void;
  partner: Profile | null;
  isOnline: boolean;
  onTip: () => void;
  onVoice: () => void;
  onVideo: () => void;
  onHide: () => void;
  onReport: () => void;
}) {
  if (!partner) return null;

  const action =
    "flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-border/60 bg-muted/30 px-3 py-2.5 text-left text-sm font-semibold transition-colors hover:bg-muted/70";

  return (
    <DialogShell open={open} onClose={onClose} labelledBy={TITLE_ID} variant="sheet">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 id={TITLE_ID} className="text-lg font-black tracking-tight">
            Conversation
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded-full p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <Avatar
            name={partner.display_name}
            src={partner.avatar_url}
            className="h-20 w-20 text-lg"
          />
          <div>
            <p className="text-base font-black">{partner.display_name}</p>
            <p className="text-sm text-muted-foreground">@{partner.username}</p>
          </div>
          <p className="flex items-center gap-1.5 text-xs font-semibold">
            <span
              className={`h-2 w-2 rounded-full ${isOnline ? "bg-emerald-500" : "bg-muted-foreground"}`}
            />
            <span
              className={
                isOnline ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
              }
            >
              {isOnline ? "Online now" : "Offline"}
            </span>
          </p>
          {partner.bio ? (
            <p className="max-w-xs text-sm text-muted-foreground">{partner.bio}</p>
          ) : null}
        </div>

        <Link
          to="/profile"
          search={{ id: partner.id, user: partner.username }}
          onClick={onClose}
          className="block rounded-2xl bg-brand px-4 py-2.5 text-center text-sm font-bold text-white transition-colors hover:bg-brand/90"
        >
          View full profile
        </Link>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              onClose();
              onTip();
            }}
            className={action}
          >
            <DollarSign className="h-4 w-4 text-amber-500" /> Send a tip
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onVoice();
              }}
              className={action}
            >
              <Phone className="h-4 w-4 text-sky-500" /> Voice
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onVideo();
              }}
              className={action}
            >
              <Video className="h-4 w-4 text-emerald-500" /> Video
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              onClose();
              onHide();
            }}
            className={action}
          >
            <EyeOff className="h-4 w-4 text-muted-foreground" /> Hide chat
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onReport();
            }}
            className={`${action} text-rose-600 hover:bg-rose-500/10 dark:text-rose-400`}
          >
            <Flag className="h-4 w-4" /> Report conversation
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
