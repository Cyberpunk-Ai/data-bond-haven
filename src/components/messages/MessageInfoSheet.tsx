import { X } from "lucide-react";
import type { Message } from "@/lib/types";
import { DialogShell } from "./DialogShell";

const TITLE_ID = "message-info-title";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium">{value}</span>
    </div>
  );
}

/** Per-message details: who sent it, when, and its delivery/read state. */
export function MessageInfoSheet({
  open,
  onClose,
  message,
  senderName,
  isMine,
  isAttachment,
}: {
  open: boolean;
  onClose: () => void;
  message: Message | null;
  senderName: string;
  isMine: boolean;
  isAttachment: boolean;
}) {
  if (!message) return null;
  const status = message.read_at ? "Read" : message.delivered_at ? "Delivered" : "Sent";

  return (
    <DialogShell open={open} onClose={onClose} labelledBy={TITLE_ID}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id={TITLE_ID} className="text-base font-black tracking-tight">
            Message details
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

        <div className="space-y-2.5 text-xs">
          <Row label="From" value={isMine ? "You" : senderName} />
          <Row label="Sent" value={new Date(message.created_at).toLocaleString()} />
          {isMine && <Row label="Status" value={status} />}
          {isMine && message.delivered_at && (
            <Row label="Delivered" value={new Date(message.delivered_at).toLocaleString()} />
          )}
          {isMine && message.read_at && (
            <Row label="Read" value={new Date(message.read_at).toLocaleString()} />
          )}
          {message.is_edited && (
            <Row
              label="Edited"
              value={message.edited_at ? new Date(message.edited_at).toLocaleString() : "Yes"}
            />
          )}
        </div>

        <div className="line-clamp-4 rounded-2xl border border-border/70 bg-muted/30 px-3 py-2 text-xs [overflow-wrap:anywhere]">
          {isAttachment ? (
            <span className="text-muted-foreground">Attachment · {message.body}</span>
          ) : (
            message.body
          )}
        </div>
      </div>
    </DialogShell>
  );
}
