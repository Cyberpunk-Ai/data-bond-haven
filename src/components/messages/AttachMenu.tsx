import { FileText, ImageIcon, Mic, Music } from "lucide-react";
import { ACCEPT_AUDIO, ACCEPT_DOCUMENTS, ACCEPT_MEDIA } from "@/lib/message-constants";

/**
 * The paperclip popover: four staging entry points. Each only opens the file
 * picker with the right `accept` filter (or starts a recording) — nothing uploads
 * until Send, matching the composer's "stage then send" model.
 */
export function AttachMenu({
  onPick,
  onVoice,
}: {
  onPick: (accept: string) => void;
  onVoice: () => void;
}) {
  const base =
    "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold transition-colors hover:bg-muted/80";
  return (
    <div
      role="menu"
      aria-label="Send attachment"
      className="absolute bottom-full left-4 z-40 mb-2 w-56 rounded-2xl border border-border bg-card/95 p-1.5 shadow-xl backdrop-blur-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2"
    >
      <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        Send Attachment
      </div>
      <button type="button" role="menuitem" onClick={() => onPick(ACCEPT_MEDIA)} className={base}>
        <ImageIcon className="h-4 w-4 text-sky-500" />
        <span>Photos & Videos</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onPick(ACCEPT_DOCUMENTS)}
        className={base}
      >
        <FileText className="h-4 w-4 text-rose-500" />
        <span>Documents & PDFs</span>
      </button>
      <button type="button" role="menuitem" onClick={() => onPick(ACCEPT_AUDIO)} className={base}>
        <Music className="h-4 w-4 text-emerald-500" />
        <span>Audio Files</span>
      </button>
      <button type="button" role="menuitem" onClick={onVoice} className={base}>
        <Mic className="h-4 w-4 text-amber-500" />
        <span>Voice Note</span>
      </button>
    </div>
  );
}
