import { cn, optimizeImageUrl } from "@/lib/utils";
import { attachmentKind, isVoiceNoteBody } from "@/lib/message-helpers";
import { AuthorizedImg, SafeAudioAttachment, SafeVideoAttachment } from "./AuthorizedMedia";
import { DocumentCard } from "./DocumentCard";
import { VoiceNotePlayer } from "./VoiceNotePlayer";

/**
 * Renders a message body that `attachmentKind` recognises as media or a file,
 * sharing one rounded "inset media" frame so an image/video/document reads with
 * the same corner language as a text bubble. Text messages fall through to
 * `MessageText` at the bubble level — this component only handles attachments.
 */
export function AttachmentBubble({
  body,
  isMine,
  endsGroup,
  onImageOpen,
}: {
  body: string;
  isMine: boolean;
  endsGroup: boolean;
  onImageOpen: (src: string) => void;
}) {
  const kind = attachmentKind(body);
  const isVoice = isVoiceNoteBody(body);

  // The tail corner rounds off only at the end of a run of the same sender's
  // messages, matching the text bubble so a multi-item burst looks connected.
  const tail = endsGroup ? (isMine ? "rounded-br-[4px]" : "rounded-bl-[4px]") : "";

  if (isVoice) return <VoiceNotePlayer body={body} isMine={isMine} />;

  if (kind === "image") {
    return (
      <div
        className={cn(
          "relative my-0.5 max-w-[260px] cursor-zoom-in overflow-hidden rounded-[20px] bg-neutral-950/20 shadow-xs sm:max-w-[320px] dark:bg-black/30",
          tail,
        )}
      >
        <AuthorizedImg
          src={optimizeImageUrl(body, 600)}
          alt="Attachment"
          loading="lazy"
          className="max-h-72 w-full cursor-zoom-in object-cover transition-transform duration-500 hover:scale-[1.03] motion-reduce:transition-none motion-reduce:hover:scale-100"
          onClick={() => onImageOpen(body)}
        />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div
        className={cn(
          "relative max-w-[280px] overflow-hidden rounded-[20px] bg-black/40 shadow-xs sm:max-w-[340px]",
          tail,
        )}
      >
        <SafeVideoAttachment src={body} />
      </div>
    );
  }

  if (kind === "audio") return <SafeAudioAttachment src={body} />;

  // pdf / document, and any tagged 📄 / 📎 body the kind check missed.
  return <DocumentCard body={body} isMine={isMine} />;
}
