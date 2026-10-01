import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { downloadMediaFile } from "@/lib/media-access";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface MediaDownloadButtonProps {
  /** The stored media URL — private paths are authorised on click. */
  url: string;
  /** The name the file is saved as. */
  name: string;
  className?: string;
  iconClassName?: string;
  label?: string;
  title?: string;
  /**
   * Where the click came from. Inside a chat bubble the whole row can be
   * clickable (open the lightbox), so a save must not also count as an open.
   */
  stopPropagation?: boolean;
}

/**
 * Saves a chat attachment.
 *
 * This used to be a plain `<a href={storedPath} download>`, which failed in two
 * ways: DM media is private, so the navigation carried no token and the read
 * proxy answered its fail-closed 404 ("download fails"), and `download` is
 * ignored for cross-origin URLs and on iOS Safari, so even a readable image just
 * opened in a tab. The work now happens in `downloadMediaFile`, which mints the
 * capability, fetches the bytes and hands the browser a blob — with a server
 * stamped `Content-Disposition: attachment` as the fallback.
 */
export function MediaDownloadButton({
  url,
  name,
  className,
  iconClassName,
  label,
  title = "Download",
  stopPropagation = true,
}: MediaDownloadButtonProps) {
  const [busy, setBusy] = useState(false);

  async function handleClick(event: React.MouseEvent) {
    if (stopPropagation) event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await downloadMediaFile(url, name);
      toast.success(`Saved ${name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The download couldn't start.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => void handleClick(e)}
      disabled={busy || !url}
      title={busy ? "Saving…" : title}
      aria-label={title}
      className={cn(
        "inline-flex items-center gap-2 font-bold transition-all active:scale-95 cursor-pointer disabled:cursor-default disabled:opacity-60",
        className,
      )}
    >
      {busy ? (
        <Loader2 className={cn("h-4 w-4 animate-spin", iconClassName)} />
      ) : (
        <Download className={cn("h-4 w-4", iconClassName)} />
      )}
      {label && <span>{label}</span>}
    </button>
  );
}
