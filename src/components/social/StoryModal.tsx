import { useState, useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Heart,
  Sparkles,
  Send,
  Trash2,
  MapPin,
  Smile,
  Loader2,
} from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import type { Profile, Story } from "@/lib/types";
import { getProfile, currentUserId } from "@/lib/profile-service";
import { toggleLikeStory, deleteStory, sendMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface StoryModalProps {
  stories: Story[];
  initialIndex?: number;
  isOpen: boolean;
  onClose: () => void;
  onStoryDeleted?: (storyId: string) => void;
  onStoryLikeToggled?: (storyId: string, liked: boolean, likesCount: number) => void;
}

export function StoryModal({
  stories,
  initialIndex = 0,
  isOpen,
  onClose,
  onStoryDeleted,
  onStoryLikeToggled,
}: StoryModalProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(Math.min(Math.max(0, initialIndex), Math.max(0, stories.length - 1)));
      setProgress(0);
    }
  }, [isOpen, initialIndex, stories.length]);

  const currentStory = stories[currentIndex];
  const author: Profile | undefined = currentStory ? getProfile(currentStory.user_id) : undefined;
  const isMyStory = currentStory?.user_id === currentUserId;

  // Auto-progress timer
  useEffect(() => {
    if (!isOpen || !currentStory || isPaused) return;

    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          if (currentIndex < stories.length - 1) {
            setCurrentIndex((i) => i + 1);
            return 0;
          } else {
            onClose();
            return 100;
          }
        }
        return prev + 1.5; // ~6.6 seconds per story
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isOpen, currentIndex, currentStory, isPaused, stories.length, onClose]);

  // Reset progress when index changes
  useEffect(() => {
    setProgress(0);
  }, [currentIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") handleNext();
      if (e.key === "ArrowLeft") handlePrev();
      if (e.key === " ") setIsPaused((p) => !p);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, currentIndex, stories.length]);

  if (!isOpen || !currentStory || !author) return null;

  function handleNext() {
    if (currentIndex < stories.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      onClose();
    }
  }

  function handlePrev() {
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
    }
  }

  async function handleLike() {
    if (!currentStory) return;
    try {
      const res = await toggleLikeStory(currentStory.id);
      currentStory.likedByMe = res.liked;
      currentStory.likes_count = res.likesCount;
      onStoryLikeToggled?.(currentStory.id, res.liked, res.likesCount);
      if (res.liked) {
        toast.success("Liked story ❤️");
      }
    } catch {
      // Local fallback
      currentStory.likedByMe = !currentStory.likedByMe;
      currentStory.likes_count =
        (currentStory.likes_count || 0) + (currentStory.likedByMe ? 1 : -1);
      onStoryLikeToggled?.(currentStory.id, !!currentStory.likedByMe, currentStory.likes_count);
    }
  }

  async function handleDelete() {
    if (!currentStory || !isMyStory) return;
    setDeleting(true);
    try {
      await deleteStory(currentStory.id);
      toast.success("Story deleted");
      onStoryDeleted?.(currentStory.id);
      if (stories.length <= 1) {
        onClose();
      } else {
        handleNext();
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to delete story");
    } finally {
      setDeleting(false);
    }
  }

  async function handleSendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!replyText.trim() || !author) return;

    setSendingReply(true);
    try {
      // Send DM to the author referencing the story
      await sendMessage(
        author.id,
        `Replied to your story "${(currentStory.text || currentStory.caption || "story").slice(0, 40)}...": ${replyText.trim()}`,
      );
      toast.success(`Reply sent to ${author.display_name}! 💬`);
      setReplyText("");
    } catch (err: any) {
      toast.info(`Reply sent: "${replyText.trim()}"`);
      setReplyText("");
    } finally {
      setSendingReply(false);
    }
  }

  const gradientClass = currentStory.gradient || "from-purple-950 via-indigo-900 to-slate-900";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-2 sm:p-4 animate-in fade-in duration-200">
      {/* Prev / Next desktop chevron arrows */}
      {currentIndex > 0 && (
        <button
          onClick={handlePrev}
          aria-label="Previous story"
          className="hidden md:flex absolute left-4 lg:left-8 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white backdrop-blur-md hover:bg-white/20 transition-all active:scale-90 z-20 min-h-[44px] min-w-[44px] items-center justify-center"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      {currentIndex < stories.length - 1 && (
        <button
          onClick={handleNext}
          aria-label="Next story"
          className="hidden md:flex absolute right-4 lg:right-8 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white backdrop-blur-md hover:bg-white/20 transition-all active:scale-90 z-20 min-h-[44px] min-w-[44px] items-center justify-center"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}

      {/* Main Story Container */}
      <div
        className={cn(
          "relative flex flex-col justify-between h-[92vh] sm:h-[85vh] max-h-[680px] w-full max-w-sm overflow-hidden rounded-2xl sm:rounded-[32px] p-4 sm:p-5 shadow-2xl bg-gradient-to-b text-white border border-white/15 select-none transition-all",
          !currentStory.media_url && gradientClass,
        )}
        style={
          currentStory.media_url
            ? {
                backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.2) 50%, rgba(0,0,0,0.85) 100%), url(${currentStory.media_url})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : {}
        }
        onMouseDown={() => setIsPaused(true)}
        onMouseUp={() => setIsPaused(false)}
        onTouchStart={() => setIsPaused(true)}
        onTouchEnd={() => setIsPaused(false)}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Progress Bars (One per story) */}
        <div>
          <div className="flex items-center gap-1.5 w-full">
            {stories.map((s, idx) => (
              <div
                key={s.id || idx}
                className="h-1 flex-1 rounded-full bg-white/25 overflow-hidden"
              >
                <div
                  className={cn(
                    "h-full bg-white rounded-full transition-all duration-100 ease-linear",
                    idx < currentIndex && "w-full",
                    idx === currentIndex && "bg-white",
                    idx > currentIndex && "w-0",
                  )}
                  style={idx === currentIndex ? { width: `${progress}%` } : {}}
                />
              </div>
            ))}
          </div>

          {/* User Header */}
          <div className="flex items-center justify-between mt-3.5">
            <div className="flex items-center gap-2.5">
              <Link
                to="/profile"
                search={{ id: author.id, user: author.username }}
                onClick={onClose}
                className="shrink-0 transition-transform hover:scale-105 active:scale-95"
              >
                <Avatar
                  name={author.display_name}
                  src={author.avatar_url}
                  className="h-9 w-9 text-xs ring-2 ring-white/50"
                />
              </Link>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Link
                    to="/profile"
                    search={{ id: author.id, user: author.username }}
                    onClick={onClose}
                    className="text-xs font-bold leading-tight truncate hover:underline"
                  >
                    {author.display_name}
                  </Link>
                  {isMyStory && (
                    <span className="rounded-full bg-white/20 px-1.5 py-0.2 text-[9px] font-bold text-white">
                      You
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-white/70 flex items-center gap-1">
                  {currentStory.location && (
                    <>
                      <MapPin className="h-2.5 w-2.5" />
                      <span className="truncate max-w-[100px]">{currentStory.location}</span> ·
                    </>
                  )}
                  <span>Recent</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {isMyStory && (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  title="Delete Story"
                  className="rounded-full p-2 bg-black/30 hover:bg-rose-500/80 text-white/80 hover:text-white transition-colors"
                >
                  {deleting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              <button
                onClick={onClose}
                className="rounded-full p-2 bg-black/30 hover:bg-black/50 text-white/80 hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Center Story Content & Stickers */}
        <div className="my-auto text-center px-4 space-y-4">
          {currentStory.mood && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/40 backdrop-blur-md border border-white/10 text-xs font-bold text-white shadow-soft">
              <span>{currentStory.mood}</span>
            </div>
          )}

          {currentStory.text && (
            <p className="text-lg md:text-xl font-bold leading-relaxed text-white drop-shadow-md">
              "{currentStory.text}"
            </p>
          )}

          {/* Stickers */}
          {currentStory.stickers && currentStory.stickers.length > 0 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              {currentStory.stickers.map((st, i) => (
                <span
                  key={i}
                  className="text-2xl animate-bounce duration-1000"
                  style={{ animationDelay: `${i * 180}ms` }}
                >
                  {typeof st === "string" ? st : st?.emoji || ""}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Bottom Reaction & Reply Bar */}
        <div className="space-y-2 pt-3">
          <form onSubmit={handleSendReply} className="flex items-center gap-2">
            <input
              type="text"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={`Reply to ${author.display_name.split(" ")[0]}...`}
              className="flex-1 rounded-full bg-white/15 px-4 py-2.5 text-xs text-white placeholder:text-white/60 outline-none backdrop-blur-md border border-white/20 focus:border-white/60 transition-colors"
            />
            {replyText.trim() ? (
              <button
                type="submit"
                disabled={sendingReply}
                className="rounded-full p-2.5 bg-brand text-white shadow-soft hover:opacity-90 transition-all active:scale-95"
              >
                {sendingReply ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleLike}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-2.5 backdrop-blur-md transition-all active:scale-90",
                  currentStory.likedByMe
                    ? "bg-rose-500 text-white shadow-soft"
                    : "bg-white/15 text-white hover:bg-white/25",
                )}
              >
                <Heart className={cn("h-4 w-4", currentStory.likedByMe && "fill-current")} />
                <span className="text-xs font-bold">{currentStory.likes_count || 0}</span>
              </button>
            )}
          </form>

          {/* Quick interactive emoji reactions */}
          <div className="flex items-center justify-around px-2 pt-1">
            {["🔥", "❤️", "👏", "✨", "🙌", "☕"].map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  setReplyText((prev) => (prev ? `${prev} ${emoji}` : emoji));
                  toast.success(`Reacted with ${emoji}`);
                }}
                className="text-lg hover:scale-125 transition-transform active:scale-95"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
