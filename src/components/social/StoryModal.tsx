import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Heart,
  Send,
  Trash2,
  MapPin,
  Smile,
  Loader2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import { EmojiPicker } from "@/components/social/EmojiPicker";
import { useEmojiInsert } from "@/hooks/useEmojiInsert";
import type { Profile, Story } from "@/lib/types";
import { getProfile, isProfilePending, currentUserId } from "@/lib/profile-service";
import { toggleLikeStory, deleteStory, sendMessage } from "@/lib/api-client";
import { storyReplyBody } from "@/lib/formatters";
import { MAX_MESSAGE_CHARS } from "@/lib/message-length";
import { authorizedMediaUrl } from "@/lib/media-access";
import {
  storyLayer,
  storyPreloadIndices,
  storyProgressStep,
  storyShouldHoldClock,
} from "@/lib/story-viewer";
import type { StoryLayer } from "@/lib/story-viewer";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";

interface StoryModalProps {
  stories: Story[];
  initialIndex?: number;
  isOpen: boolean;
  onClose: () => void;
  onStoryDeleted?: (storyId: string) => void;
  onStoryLikeToggled?: (storyId: string, liked: boolean, likesCount: number) => void;
}

/** One story's on-screen budget, and how often the clock ticks toward it. */
const STORY_DURATION_MS = 6600;
const STORY_TICK_MS = 100;

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
  // Composing a reply must stop the carousel: a story that advances (or the
  // whole viewer closing) mid-sentence retargets or destroys the draft.
  const [replyFocused, setReplyFocused] = useState(false);
  const replyInputRef = useRef<HTMLInputElement>(null);
  // The picker holds its own search box, so opening it takes the caret out of
  // the reply field and `replyFocused` goes false. Without a flag of its own in
  // the pause guard below, the story would advance mid-pick and the draft it
  // was meant for would be retargeted or lost.
  const [replyEmojiOpen, setReplyEmojiOpen] = useState(false);
  // One glyph in the middle of a sentence the reader is typing is worth getting
  // right, so this reuses the message composer's insert: caret position read
  // before the update, restored after the render, capped at what a DM accepts.
  const insertReplyEmoji = useEmojiInsert(replyInputRef, replyText, setReplyText, {
    maxLength: MAX_MESSAGE_CHARS,
    onRefused: () => toast.info(`A reply can be up to ${MAX_MESSAGE_CHARS} characters`),
  });
  const [deleting, setDeleting] = useState(false);
  // Optimistic like state for the story currently open. Writing back into the
  // `stories` prop mutated a shared object and only re-rendered when the parent
  // happened to pass a callback, which could leave the heart and its count out
  // of sync for a frame or two.
  const [likeOverride, setLikeOverride] = useState<{
    id: string;
    liked: boolean;
    count: number;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(Math.min(Math.max(0, initialIndex), Math.max(0, stories.length - 1)));
      setProgress(0);
    }
  }, [isOpen, initialIndex, stories.length]);

  const currentStory = stories[currentIndex];
  const author: Profile | undefined = currentStory ? getProfile(currentStory.user_id) : undefined;
  // A story from somebody you have not met yet: the rail hydrates the authors
  // of the stories it shows, but a deep link or a fresh realtime story can beat
  // that read. Show the wait instead of the id.
  const authorPending = Boolean(author) && isProfilePending(author);
  const isMyStory = currentStory?.user_id === currentUserId;

  // What the heart button shows: our in-flight answer for this story if we just
  // tapped it, otherwise the hydrated props. Both halves come from one snapshot,
  // so a filled heart is never paired with a count that ignores it.
  const likedNow =
    likeOverride?.id === currentStory?.id ? likeOverride.liked : Boolean(currentStory?.likedByMe);
  const likesNow =
    likeOverride?.id === currentStory?.id ? likeOverride.count : currentStory?.likes_count || 0;

  // Story images are follow-network media: the browser cannot fetch them with a
  // bearer header, so each one needs the signed URL the media proxy mints.
  // That happens per story id, for the open story plus its next two neighbours —
  // a swipe then swaps bytes that are already in memory instead of starting a
  // fresh round trip in front of the reader.
  const layer: StoryLayer = useMemo(() => storyLayer(currentStory), [currentStory]);
  const currentId = currentStory?.id ?? "";
  const mintedRef = useRef<Record<string, string>>({});
  const [minted, setMinted] = useState<Record<string, string>>({});
  // Stories whose media has settled: painted, or failed and showing its
  // gradient. Not "decoded successfully" — a dead object counts here too,
  // because the viewer must not keep waiting for it.
  const [settledIds, setSettledIds] = useState<Set<string>>(new Set());
  const [waitedMs, setWaitedMs] = useState(0);
  // A clip starts muted because that is the only thing a browser will autoplay
  // without a gesture; one tap turns its sound on.
  const [storySound, setStorySound] = useState(false);

  const markSettled = useCallback((id: string) => {
    if (!id) return;
    setSettledIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isOpen || stories.length === 0) return undefined;
    let alive = true;
    for (const idx of [currentIndex, ...storyPreloadIndices(stories.length, currentIndex)]) {
      const story = stories[idx];
      if (!story) continue;
      const frame = storyLayer(story);
      if (frame.kind === "text" || mintedRef.current[story.id]) continue;
      void authorizedMediaUrl(frame.src)
        .then((url) => {
          if (!alive || !url) return;
          mintedRef.current = { ...mintedRef.current, [story.id]: url };
          setMinted(mintedRef.current);
          if (frame.kind !== "image") return;
          // Decode off-screen now, so the frame is a swap and not a wait.
          const probe = new Image();
          probe.onload = () => markSettled(story.id);
          probe.onerror = () => markSettled(story.id);
          probe.src = url;
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [isOpen, currentIndex, stories, markSettled]);

  const currentUrl = currentId ? (minted[currentId] ?? null) : null;
  const currentSettled = currentId ? settledIds.has(currentId) : true;

  // How long this story has been open without its media. Released the moment
  // the frame settles, and past the viewer's patience (`storyShouldHoldClock`)
  // a photo that never arrives cannot freeze the carousel.
  useEffect(() => {
    if (!isOpen || !currentId || layer.kind === "text" || currentSettled) return undefined;
    const started = Date.now();
    setWaitedMs(0);
    const iv = setInterval(() => setWaitedMs(Date.now() - started), 200);
    return () => clearInterval(iv);
  }, [isOpen, currentId, layer.kind, currentSettled]);

  const holdClock = storyShouldHoldClock({
    layer,
    hasUrl: Boolean(currentUrl),
    decoded: currentSettled,
    waitedMs,
  });

  // Auto-progress timer
  useEffect(() => {
    if (
      !isOpen ||
      !currentStory ||
      isPaused ||
      replyFocused ||
      replyEmojiOpen ||
      sendingReply ||
      holdClock
    )
      return;

    const step = storyProgressStep(STORY_TICK_MS, STORY_DURATION_MS);
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
        return prev + step;
      });
    }, STORY_TICK_MS);

    return () => clearInterval(interval);
    // Every value the guard above reads has to be a dependency: a tick already
    // scheduled only stops when this effect re-runs. Leaving `replyFocused` and
    // `sendingReply` out meant typing a reply froze nothing until some other
    // dep happened to change — the freeze read as broken on a slow frame.
  }, [
    isOpen,
    currentIndex,
    currentStory,
    isPaused,
    replyFocused,
    replyEmojiOpen,
    sendingReply,
    holdClock,
    stories.length,
    onClose,
  ]);

  // Reset progress when index changes
  useEffect(() => {
    setProgress(0);
    // Move the optimistic like on: it describes the story that was open.
    setLikeOverride(null);
    // A draft belongs to the story it was written under. Carrying it over and
    // hitting Send would DM the *new* author words meant for the old one.
    setReplyText("");
    setReplyEmojiOpen(false);
    // A manual jump drops the typing guard too; the blur clears `replyFocused`.
    replyInputRef.current?.blur();
  }, [currentIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // While the picker is up, Escape is its own key: closing the panel and the
      // viewer on one press would throw away the reply being composed.
      if (replyEmojiOpen) return;
      if (e.key === "Escape") return onClose();
      // While the reply box has the caret, arrow keys move the cursor and the
      // space bar types — not story controls.
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (e.key === "ArrowRight") handleNext();
      if (e.key === "ArrowLeft") handlePrev();
      if (e.key === " ") setIsPaused((p) => !p);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, currentIndex, stories.length, replyEmojiOpen]);

  if (!isOpen || !currentStory || !author) return null;
  // SSR: there is no <body> to portal into on the server, and the viewer is a
  // client-only surface anyway (it opens on a click).
  if (typeof document === "undefined") return null;

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
    const storyId = currentStory.id;
    const apply = (liked: boolean, count: number) => setLikeOverride({ id: storyId, liked, count });

    apply(!likedNow, Math.max(0, likesNow + (likedNow ? -1 : 1)));
    try {
      const res = await toggleLikeStory(storyId);
      // Flag and tally arrive from the same write, so the filled heart and the
      // number beside it always move together.
      apply(res.liked, res.likesCount);
      onStoryLikeToggled?.(storyId, res.liked, res.likesCount);
      if (res.liked) {
        toast.success("Liked story ❤️");
      }
    } catch (err) {
      // Put back exactly what was there: a heart that stayed behind after a
      // failed request is the inconsistency people notice.
      apply(likedNow, likesNow);
      toast.error(friendlyError(err, "Couldn't like that story — try again in a moment."));
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
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't delete that story. Please try again."));
    } finally {
      setDeleting(false);
    }
  }

  async function handleSendReply(e: React.FormEvent) {
    e.preventDefault();
    const reply = replyText.trim();
    if (!reply || !author || !currentStory) return;

    setSendingReply(true);
    try {
      // Send DM to the author referencing the story (honest quote rules live
      // in `storyReplyBody`, unit-tested).
      await sendMessage(author.id, storyReplyBody(currentStory, reply));
      toast.success(`Reply sent to ${author.display_name}! 💬`);
      setReplyText("");
    } catch (err: unknown) {
      // A failed reply is NOT a sent one: keep the draft, say what happened.
      toast.error(friendlyError(err, "Couldn't send your reply — it's still here, try again."));
    } finally {
      setSendingReply(false);
    }
  }

  const gradientClass = currentStory.gradient || "from-purple-950 via-indigo-900 to-slate-900";

  return createPortal(
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
          "relative flex flex-col justify-between h-[92dvh] sm:h-[85dvh] max-h-[680px] w-full max-w-sm overflow-hidden rounded-2xl sm:rounded-[32px] p-4 sm:p-5 shadow-2xl text-white border border-white/15 select-none transition-all",
          // A media story sits on flat black and the picture *is* the background;
          // a text story keeps the gradient its author picked. Painting media in
          // a real element rather than as a CSS background is what lets the frame
          // fade in once decoded instead of blinking from dark panel to photo.
          layer.kind === "text" ? cn("bg-gradient-to-b", gradientClass) : "bg-black",
        )}
        onMouseDown={() => setIsPaused(true)}
        onMouseUp={() => setIsPaused(false)}
        onTouchStart={() => setIsPaused(true)}
        onTouchEnd={() => setIsPaused(false)}
        onClick={(e) => e.stopPropagation()}
      >
        {layer.kind !== "text" && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {currentUrl ? (
              layer.kind === "image" ? (
                <img
                  key={currentId}
                  src={currentUrl}
                  alt=""
                  draggable={false}
                  onLoad={() => markSettled(currentId)}
                  onError={() => markSettled(currentId)}
                  className="h-full w-full animate-in object-cover fade-in duration-300"
                />
              ) : (
                <video
                  key={currentId}
                  src={currentUrl}
                  autoPlay
                  playsInline
                  muted={!storySound}
                  onCanPlay={() => markSettled(currentId)}
                  onError={() => markSettled(currentId)}
                  className="h-full w-full object-cover"
                />
              )
            ) : (
              // Signed URL still minting: the author's gradient is a kinder
              // placeholder than a black hole, and it never 404s.
              <div className={cn("absolute inset-0 bg-gradient-to-b", gradientClass)} />
            )}
            {/* Scrim so the caption, the name and the reply bar stay legible no
                matter what the picture is doing behind them. */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/20 to-black/85" />
          </div>
        )}

        {/* Top Progress Bars (One per story) */}
        <div className="relative z-10">
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
              {authorPending ? (
                <span className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-white/25 ring-2 ring-white/50" />
              ) : (
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
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  {authorPending ? (
                    <span className="block h-3 w-24 animate-pulse rounded bg-white/25" />
                  ) : (
                    <>
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
                    </>
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
              {/* A clip starts muted — the only thing a browser will autoplay
                  without a gesture — so the sound deserves one honest tap. */}
              {layer.kind === "video" && currentUrl && (
                <button
                  onClick={() => setStorySound((s) => !s)}
                  aria-pressed={storySound}
                  title={storySound ? "Mute story" : "Unmute story"}
                  className="rounded-full p-2 bg-black/30 hover:bg-black/50 text-white/80 hover:text-white transition-colors"
                >
                  {storySound ? (
                    <Volume2 className="h-3.5 w-3.5" />
                  ) : (
                    <VolumeX className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
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
        <div className="relative z-10 my-auto text-center px-4 space-y-4">
          {holdClock && (
            <div className="flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-white/70" />
            </div>
          )}
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
        <div className="relative z-10 space-y-2 pt-3">
          {isMyStory ? (
            // You can't DM yourself a story reply — offer the heart instead.
            <div className="flex items-center justify-center pb-1">
              <button
                type="button"
                onClick={handleLike}
                aria-pressed={likedNow}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-2.5 backdrop-blur-md transition-all active:scale-90 cursor-pointer",
                  likedNow
                    ? "bg-rose-500 text-white shadow-soft"
                    : "bg-white/15 text-white hover:bg-white/25",
                )}
              >
                <Heart className={cn("h-4 w-4", likedNow && "fill-current")} />
                <span className="text-xs font-bold">{likesNow}</span>
              </button>
            </div>
          ) : (
            <>
              <form onSubmit={handleSendReply} className="flex items-center gap-2">
                {/* Full picker, same one the DM composer and the post composer
                    open: search, categories and recents. */}
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setReplyEmojiOpen((open) => !open)}
                    aria-expanded={replyEmojiOpen}
                    aria-label="Insert emoji"
                    className={cn(
                      "grid h-9 w-9 place-items-center rounded-full backdrop-blur-md transition-all active:scale-90 cursor-pointer",
                      replyEmojiOpen
                        ? "bg-white/30 text-white"
                        : "bg-white/15 text-white hover:bg-white/25",
                    )}
                  >
                    <Smile className="h-4 w-4" />
                  </button>
                  {replyEmojiOpen && (
                    <EmojiPicker
                      multiple
                      label="Emoji"
                      className="bottom-full left-0 mb-2"
                      onPick={insertReplyEmoji}
                      onClose={() => setReplyEmojiOpen(false)}
                    />
                  )}
                </div>
                <input
                  ref={replyInputRef}
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onFocus={() => setReplyFocused(true)}
                  onBlur={() => setReplyFocused(false)}
                  placeholder={
                    authorPending ? "Reply…" : `Reply to ${author.display_name.split(" ")[0]}...`
                  }
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
                    aria-pressed={likedNow}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-3 py-2.5 backdrop-blur-md transition-all active:scale-90",
                      likedNow
                        ? "bg-rose-500 text-white shadow-soft"
                        : "bg-white/15 text-white hover:bg-white/25",
                    )}
                  >
                    <Heart className={cn("h-4 w-4", likedNow && "fill-current")} />
                    <span className="text-xs font-bold">{likesNow}</span>
                  </button>
                )}
              </form>

              {/* Quick emoji reactions: they land in the reply draft, so say
              nothing rather than claiming a reaction was sent. */}
              <div className="flex items-center justify-around px-2 pt-1">
                {["🔥", "❤️", "👏", "✨", "🙌", "☕"].map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => insertReplyEmoji(emoji)}
                    className="text-lg hover:scale-125 transition-transform active:scale-95 cursor-pointer"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
