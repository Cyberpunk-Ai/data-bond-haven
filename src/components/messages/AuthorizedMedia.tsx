import { useState } from "react";
import { cn } from "@/lib/utils";
import { useAuthorizedMediaUrl } from "@/lib/media-access";
import { MediaDownloadButton } from "@/components/social/MediaDownloadButton";
import { fileNameFromUrl } from "@/lib/media-download";

/**
 * <img> that can render private media: resolves a signed URL first.
 *
 * A DM's pictures live in a private bucket a bare <img> cannot authenticate
 * against, so we mint a short-lived media token and load through it. Returning
 * null while the token is being minted left a hole exactly the size of the photo
 * — a chat with pictures collapsed then jumped — so a placeholder keeps the
 * bubble the right shape while it resolves.
 */
export function AuthorizedImg({
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

export function SafeVideoAttachment({ src }: { src: string }) {
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

export function SafeAudioAttachment({ src }: { src: string }) {
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
    <div className="my-1 flex w-full max-w-[260px] items-center gap-1">
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
