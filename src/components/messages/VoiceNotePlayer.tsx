import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthorizedMediaUrl } from "@/lib/media-access";
import { MediaDownloadButton } from "@/components/social/MediaDownloadButton";
import { extensionOf, fileNameFromUrl } from "@/lib/media-download";
import { toast } from "sonner";

/**
 * A compact audio player for a voice note whose body is `🎙️ Voice Note (Ns) [url]`.
 *
 * When a real recording url is present we drive playback (and the progress bar)
 * from the <audio> element's own clock. When it isn't — a placeholder or an old
 * row with no media — we fall back to a timer so the bubble still animates for
 * the stated duration instead of showing a dead control.
 */
export function VoiceNotePlayer({ body, isMine }: { body: string; isMine: boolean }) {
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
    if (!playableUrl) return undefined;
    const audio = new Audio(playableUrl);
    audioRef.current = audio;
    audio.onended = () => {
      setIsPlaying(false);
      setProgress(0);
    };
    audio.ontimeupdate = () => {
      if (audio.duration) setProgress((audio.currentTime / audio.duration) * 100);
    };
    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, [playableUrl]);

  // No real audio element (placeholder / no media): animate on a timer.
  useEffect(() => {
    if (audioUrl) return; // Managed by audioRef timeupdate
    if (!isPlaying) return undefined;
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          setIsPlaying(false);
          return 0;
        }
        return prev + 100 / (duration * 10);
      });
    }, 100);
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
    <div className="flex min-w-[210px] items-center gap-3 px-1 py-1 sm:min-w-[240px]">
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause voice note" : "Play voice note"}
        className={cn(
          "flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full shadow-sm transition-transform active:scale-90",
          isMine
            ? "bg-white text-brand hover:bg-white/95"
            : "bg-brand text-white hover:bg-brand/90",
        )}
      >
        {isPlaying ? (
          <span className="flex items-center gap-0.5">
            <span className="h-3 w-1 animate-pulse rounded-full bg-current" />
            <span className="h-3 w-1 animate-pulse rounded-full bg-current delay-75" />
          </span>
        ) : (
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        )}
      </button>

      <div className="flex-1 space-y-1">
        <div className="flex h-6 items-center gap-0.5">
          {bars.map((height, i) => {
            const barProgress = (i / bars.length) * 100;
            const isActive = progress >= barProgress;
            return (
              <span
                key={i}
                aria-hidden
                style={{
                  height: `${isPlaying ? Math.max(20, Math.min(100, height * (0.7 + (i % 3) * 0.2))) : height}%`,
                }}
                className={cn(
                  "w-1 rounded-full transition-all duration-150 motion-reduce:transition-none",
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
          animated bars alone give no way to save it. */}
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
