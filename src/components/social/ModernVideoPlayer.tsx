import { useState, useRef, useEffect } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Loader2,
  PictureInPicture,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ModernVideoPlayerProps {
  src: string;
  poster?: string;
  className?: string;
  autoPlayOnScroll?: boolean;
}

export function ModernVideoPlayer({
  src,
  poster,
  className,
  autoPlayOnScroll = true,
}: ModernVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [progress, setProgress] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [playFeedback, setPlayFeedback] = useState<"play" | "pause" | null>(null);
  const [hasError, setHasError] = useState(false);

  const hideControlsTimeout = useRef<NodeJS.Timeout | null>(null);
  const feedbackTimeout = useRef<NodeJS.Timeout | null>(null);

  // Auto-play / auto-pause when video enters or exits the viewport
  useEffect(() => {
    if (!autoPlayOnScroll || !containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!videoRef.current) return;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            videoRef.current.play().catch(() => {
              // Browser autoplay policy might block unmuted autoplay
              videoRef.current!.muted = true;
              setIsMuted(true);
              videoRef.current!.play().catch(() => {});
            });
          } else {
            videoRef.current.pause();
          }
        });
      },
      { threshold: 0.6 },
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [autoPlayOnScroll]);

  // Handle controls fadeout after inactivity
  const triggerControlsActivity = () => {
    setShowControls(true);
    if (hideControlsTimeout.current) clearTimeout(hideControlsTimeout.current);
    hideControlsTimeout.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 2500);
  };

  const togglePlay = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!videoRef.current) return;

    if (feedbackTimeout.current) clearTimeout(feedbackTimeout.current);

    if (isPlaying) {
      videoRef.current.pause();
      setPlayFeedback("pause");
    } else {
      videoRef.current.play().catch(console.error);
      setPlayFeedback("play");
    }

    feedbackTimeout.current = setTimeout(() => {
      setPlayFeedback(null);
    }, 650);

    triggerControlsActivity();
  };

  const toggleMute = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!videoRef.current) return;
    const newMuted = !isMuted;
    videoRef.current.muted = newMuted;
    setIsMuted(newMuted);
    if (!newMuted && volume === 0) {
      setVolume(0.8);
      videoRef.current.volume = 0.8;
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const seekTime = (parseFloat(e.target.value) / 100) * duration;
    setCurrentTime(seekTime);
    setProgress(parseFloat(e.target.value));
    if (videoRef.current) {
      videoRef.current.currentTime = seekTime;
    }
  };

  const toggleFullscreen = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current
        .requestFullscreen()
        .then(() => setIsFullscreen(true))
        .catch(() => {});
    } else {
      document
        .exitFullscreen()
        .then(() => setIsFullscreen(false))
        .catch(() => {});
    }
  };

  const togglePiP = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.warn("PiP error:", err);
    }
  };

  function formatTime(seconds: number) {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  }

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => {
        setIsHovered(true);
        triggerControlsActivity();
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        if (isPlaying) setShowControls(false);
      }}
      onMouseMove={triggerControlsActivity}
      onClick={togglePlay}
      className={cn(
        "relative overflow-hidden rounded-2xl bg-black shadow-md border border-border/60 group select-none cursor-pointer",
        className,
      )}
    >
      {src && !hasError ? (
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          playsInline
          muted={isMuted}
          loop
          onError={() => setHasError(true)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onWaiting={() => setIsLoading(true)}
          onPlaying={() => setIsLoading(false)}
          onCanPlay={() => setIsLoading(false)}
          onLoadedMetadata={() => {
            if (videoRef.current) {
              setDuration(videoRef.current.duration);
            }
          }}
          onTimeUpdate={() => {
            if (videoRef.current) {
              const cur = videoRef.current.currentTime;
              const dur = videoRef.current.duration || 1;
              setCurrentTime(cur);
              setProgress((cur / dur) * 100);

              if (videoRef.current.buffered.length > 0) {
                const bufEnd = videoRef.current.buffered.end(videoRef.current.buffered.length - 1);
                setBuffered((bufEnd / dur) * 100);
              }
            }
          }}
          className="w-full h-auto block max-h-[560px] object-cover mx-auto"
        />
      ) : (
        <div className="flex h-56 w-full items-center justify-center bg-neutral-900 text-muted-foreground text-xs p-4 text-center">
          Video unavailable or format unsupported
        </div>
      )}

      {/* Loading Spinner */}
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 backdrop-blur-xs">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white shadow-lg border border-white/20">
            <Loader2 className="h-6 w-6 animate-spin text-brand" />
          </div>
        </div>
      )}

      {/* Central Play/Pause Bubble Feedback Overlay */}
      {playFeedback && (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white shadow-lg animate-ping scale-75 opacity-90 transition-all">
            {playFeedback === "play" ? (
              <Play className="h-8 w-8 fill-white text-white ml-1" />
            ) : (
              <Pause className="h-8 w-8 fill-white text-white" />
            )}
          </div>
        </div>
      )}

      {/* Center Play/Pause Floating Overlay */}
      {!isPlaying && !isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 transition-opacity">
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-brand/90 text-white shadow-glow backdrop-blur-md transition-transform duration-300 hover:scale-110 active:scale-95 cursor-pointer z-20"
          >
            <Play className="h-7 w-7 ml-1 fill-white text-white" />
          </button>
        </div>
      )}

      {/* Floating Bottom Control Bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "absolute bottom-0 left-0 right-0 z-20 flex flex-col gap-2.5 p-3.5 bg-gradient-to-t from-black/95 via-black/70 to-transparent transition-all duration-300",
          showControls || !isPlaying || isHovered
            ? "opacity-100 translate-y-0"
            : "opacity-0 translate-y-3 pointer-events-none",
        )}
      >
        {/* Timeline Seek Bar */}
        <div className="relative flex items-center group/timeline h-3.5 cursor-pointer w-full">
          {/* Buffered track */}
          <div
            className="absolute h-1 rounded-full bg-white/20 w-full transition-all group-hover/timeline:h-1.5"
            style={{ width: "100%" }}
          >
            <div
              className="h-full rounded-full bg-white/35 transition-all duration-150"
              style={{ width: `${buffered}%` }}
            />
          </div>

          {/* Active progress track */}
          <div
            className="absolute h-1 rounded-full bg-gradient-to-r from-brand to-brand-pink transition-all group-hover/timeline:h-1.5"
            style={{ width: `${progress}%` }}
          />

          {/* Slider Thumb Handle */}
          <div
            className="absolute h-3 w-3 rounded-full bg-white border-2 border-brand shadow-md transition-transform duration-150 scale-0 group-hover/timeline:scale-100 pointer-events-none -translate-x-1/2 z-20"
            style={{ left: `${progress}%` }}
          />

          {/* Range Slider Input */}
          <input
            type="range"
            min="0"
            max="100"
            step="0.1"
            value={progress}
            onChange={handleSeek}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
          />
        </div>

        {/* Action Controls */}
        <div className="flex items-center justify-between text-white text-xs font-semibold">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/20 transition-all duration-200 active:scale-90 cursor-pointer"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="h-4.5 w-4.5 fill-white" />
              ) : (
                <Play className="h-4.5 w-4.5 fill-white ml-0.5" />
              )}
            </button>

            {/* Time display */}
            <span className="text-[11px] font-mono tracking-tight text-white/90">
              {formatTime(currentTime)} <span className="text-white/40">/</span>{" "}
              {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Volume control */}
            <div className="flex items-center gap-1 group/vol">
              <button
                type="button"
                onClick={toggleMute}
                className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/20 transition-all duration-200 active:scale-90 cursor-pointer"
                title={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="h-4.5 w-4.5 text-rose-400" />
                ) : (
                  <Volume2 className="h-4.5 w-4.5" />
                )}
              </button>
              <div className="w-0 group-hover/vol:w-16 group-hover/vol:mr-1 overflow-hidden transition-all duration-300 ease-out hidden sm:block">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-16 h-1 accent-brand bg-white/30 rounded-lg cursor-pointer transition-opacity opacity-0 group-hover/vol:opacity-100"
                />
              </div>
            </div>

            {/* Picture in Picture */}
            <button
              type="button"
              onClick={togglePiP}
              className="hidden sm:flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/20 transition-all duration-200 active:scale-90 cursor-pointer"
              title="Picture in Picture"
            >
              <PictureInPicture className="h-4 w-4" />
            </button>

            {/* Fullscreen */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/20 transition-all duration-200 active:scale-90 cursor-pointer"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
