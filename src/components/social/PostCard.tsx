import { useState, useEffect, useRef, memo } from "react";
import { Link } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import {
  Heart,
  MessageCircle,
  Repeat2,
  Bookmark,
  Share2,
  BarChart3,
  MoreHorizontal,
  BadgeCheck,
  Send,
  Trash2,
  Copy,
  VolumeX,
  Flag,
  DollarSign,
  Sparkles,
  CheckCircle2,
  Maximize2,
  Compass,
  Zap,
  Flame,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { TimeAgo } from "@/components/social/TimeAgo";
import { TipModal } from "@/components/social/TipModal";
import { ReportModal } from "@/components/social/ReportModal";
import { ModernVideoPlayer } from "@/components/social/ModernVideoPlayer";
import { compact } from "@/lib/formatters";
import type { Post, Comment, Poll } from "@/lib/types";
import { getProfile, useProfile, currentUser } from "@/lib/profile-service";
import {
  toggleLikePost,
  toggleRepostPost,
  toggleBookmarkPost,
  recordPostImpression,
  addPostComment,
  deletePost,
  votePoll,
  sendFeedFeedback,
} from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import { usePlan } from "@/lib/plan-state";
import { useAuth } from "@/lib/auth-state";
import { cn, optimizeImageUrl } from "@/lib/utils";
import { ClampText } from "@/components/social/ClampText";

function renderContentWithLinks(text: string) {
  if (!text) return null;
  // Match URLs starting with http:// or https://, hashtags, and mentions
  const tokenRegex = /(https?:\/\/[^\s]+|#[a-zA-Z0-9_]+|@[a-zA-Z0-9_.]+)/g;
  const parts = text.split(tokenRegex);

  return parts.map((part, i) => {
    if (part.startsWith("http://") || part.startsWith("https://")) {
      // Security check: ensure string is valid URL
      let safeUrl = part;
      try {
        const parsed = new URL(part);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return part;
        safeUrl = parsed.href;
      } catch {
        return part;
      }

      return (
        <a
          key={i}
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand hover:underline font-medium break-all transition-colors inline-flex items-center gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
          <ExternalLink className="inline-block h-3 w-3 ml-0.5 opacity-70 shrink-0" />
        </a>
      );
    }
    if (part.startsWith("#") && part.length > 1) {
      const tag = part.slice(1);
      return (
        <Link
          key={i}
          to="/explore"
          search={{ q: tag }}
          className="text-brand hover:text-brand-pink font-semibold transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </Link>
      );
    }
    if (part.startsWith("@") && part.length > 1) {
      const handle = part.slice(1);
      return (
        <Link
          key={i}
          to="/profile"
          search={{ user: handle }}
          className="text-brand font-bold hover:underline transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </Link>
      );
    }
    return part;
  });
}

// Session-level set to avoid duplicate impression calls in rapid scrolls
const recordedImpressions = new Set<string>();

// Shared IntersectionObserver to avoid creating dozens of observers in the feed
let sharedObserver: IntersectionObserver | null = null;
const observerCallbacks = new Map<Element, () => void>();

function getSharedObserver() {
  if (typeof window === "undefined") return null;
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const cb = observerCallbacks.get(entry.target);
            if (cb) {
              cb();
              observerCallbacks.delete(entry.target);
              sharedObserver?.unobserve(entry.target);
            }
          }
        }
      },
      { threshold: 0.3 },
    );
  }
  return sharedObserver;
}

function Action({
  icon: Icon,
  count,
  active,
  activeClass,
  label,
  onClick,
  filled,
}: {
  icon: typeof Heart;
  count?: number;
  active?: boolean;
  activeClass: string;
  label: string;
  onClick?: () => void;
  filled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "group/action flex shrink-0 items-center gap-1 sm:gap-1.5 rounded-full px-2 sm:px-2.5 py-1.5 text-xs sm:text-sm font-medium text-muted-foreground transition-all duration-200 touch-manipulation min-h-[40px] active:scale-95 cursor-pointer",
        active ? activeClass : "hover:text-foreground hover:bg-foreground/5",
      )}
    >
      <span className="relative flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-full transition-colors duration-200 group-hover/action:bg-foreground/5">
        <Icon
          className={cn(
            "h-4 w-4 sm:h-[1.05rem] sm:w-[1.05rem] transition-transform duration-300 group-active/action:scale-90",
            active && "scale-110",
            active && filled && "fill-current",
          )}
        />
      </span>
      {count !== undefined && (
        <span className="tabular-nums text-[0.72rem] sm:text-xs font-semibold">
          {compact(count)}
        </span>
      )}
    </button>
  );
}

function isMediaVideo(url?: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes(".mp4") ||
    lower.includes(".webm") ||
    lower.includes(".mov") ||
    lower.includes(".m4v") ||
    lower.includes(".ogv") ||
    lower.startsWith("data:video") ||
    lower.includes("/video/") ||
    lower.includes("video_")
  );
}

function PostCardBase({
  post,
  index = 0,
  onDeleted,
}: {
  post: Post;
  index?: number;
  onDeleted?: (id: string) => void;
}) {
  const { currentPlan, isPlus, isPro } = usePlan();
  const { user } = useAuth();
  const activeUser = user || currentUser;
  const { profile: hookProfile } = useProfile(post.user_id);
  const author = hookProfile ?? getProfile(post.user_id);
  const cardRef = useRef<HTMLElement>(null);
  const [state, setState] = useState({
    liked: post.likedByMe,
    likes: post.likeCount,
    reposted: post.repostedByMe,
    reposts: post.repostCount,
    saved: post.bookmarkedByMe,
    views: post.viewCount || 1,
  });

  // Sync state if post prop changes
  useEffect(() => {
    setState({
      liked: post.likedByMe,
      likes: post.likeCount,
      reposted: post.repostedByMe,
      reposts: post.repostCount,
      saved: post.bookmarkedByMe,
      views: post.viewCount || 1,
    });
    if (post.comments) {
      setCommentsList(post.comments);
    }
  }, [
    post.id,
    post.likeCount,
    post.likedByMe,
    post.repostCount,
    post.repostedByMe,
    post.bookmarkedByMe,
    post.viewCount,
  ]);

  // Record impression when post enters viewport using shared observer pool
  useEffect(() => {
    const el = cardRef.current;
    if (!el || recordedImpressions.has(post.id)) return;

    const observer = getSharedObserver();
    if (!observer) return;

    observerCallbacks.set(el, () => {
      if (recordedImpressions.has(post.id)) return;
      recordedImpressions.add(post.id);
      recordPostImpression(post.id)
        .then((res) => {
          if (res && typeof res.viewCount === "number") {
            setState((s) => ({ ...s, views: res.viewCount }));
          }
        })
        .catch(() => {});
    });

    observer.observe(el);

    return () => {
      observerCallbacks.delete(el);
      observer.unobserve(el);
    };
  }, [post.id]);

  // Listen to realtime updates for this specific post
  useRealtime(
    (event) => {
      if (
        event.type === "post_like_updated" &&
        event.postId === post.id &&
        typeof event.likeCount === "number"
      ) {
        const newLikes = event.likeCount;
        setState((s) => ({ ...s, likes: newLikes }));
      } else if (
        event.type === "post_repost_updated" &&
        event.postId === post.id &&
        typeof event.repostCount === "number"
      ) {
        const newReposts = event.repostCount;
        setState((s) => ({ ...s, reposts: newReposts }));
      } else if (
        event.type === "post_view_updated" &&
        event.postId === post.id &&
        typeof event.viewCount === "number"
      ) {
        const newViews = event.viewCount;
        setState((s) => ({ ...s, views: newViews }));
      } else if (event.type === "poll_updated" && event.postId === post.id && event.tallies) {
        // Merge other people's counts without touching this viewer's own choice.
        setPoll((prev) => {
          if (!prev) return prev;
          const counts = new Map<string, number>(
            (event.tallies as any[]).map((t) => [t.id, t.votes]),
          );
          return {
            ...prev,
            options: prev.options.map((o) => ({ ...o, votes: counts.get(o.id) ?? o.votes })),
            totalVotes: typeof event.totalVotes === "number" ? event.totalVotes : prev.totalVotes,
          };
        });
      } else if (event.event === "new_comment" && event.data?.post_id === post.id) {
        setCommentsList((prev) => {
          if (prev.some((c) => c.id === event.data.id)) return prev;
          return [...prev, event.data];
        });
      }
    },
    ["post_like_updated", "post_repost_updated", "post_view_updated", "poll_updated"],
  );

  // Comments state
  const [showComments, setShowComments] = useState(false);
  const [showAllComments, setShowAllComments] = useState(false);
  const [commentsList, setCommentsList] = useState<Comment[]>(post.comments || []);
  const [commentDraft, setCommentDraft] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showImagePreview, setShowImagePreview] = useState(false);
  const [previewMediaUrl, setPreviewMediaUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);
  const [isTipModalOpen, setIsTipModalOpen] = useState(false);
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Autoplay/Pause video when scrolling in/out of viewport
  useEffect(() => {
    if (!videoRef.current) return;
    const videoEl = videoRef.current;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          videoEl.play().catch(() => {
            // Safe catch for potential browser play block
          });
        } else {
          videoEl.pause();
        }
      },
      {
        threshold: 0.3, // Play when 30% of the video card is visible
      },
    );

    observer.observe(videoEl);

    return () => {
      observer.unobserve(videoEl);
    };
  }, [post.media_url]);

  // Poll interactive state
  const [poll, setPoll] = useState<Poll | undefined>(post.poll || undefined);
  const hasVotedInPoll = poll?.options.some((o) => o.votedByMe);

  useEffect(() => {
    if (post.poll) {
      setPoll(post.poll);
    }
  }, [post.poll]);

  async function handleVote(optionId: string) {
    if (!poll || hasVotedInPoll) return;
    setPoll((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        totalVotes: prev.totalVotes + 1,
        options: prev.options.map((opt) =>
          opt.id === optionId ? { ...opt, votes: opt.votes + 1, votedByMe: true } : opt,
        ),
      };
    });
    try {
      const res = await votePoll(post.id, optionId);
      if (res && res.poll) {
        setPoll(res.poll);
      }
      toast.success("Vote recorded!");
    } catch {
      toast.error("Failed to submit vote");
    }
  }

  const mediaSrc = post.image_url || post.media_url;

  async function handleLike() {
    const nextLiked = !state.liked;
    const nextLikes = state.likes + (nextLiked ? 1 : -1);
    setState((s) => ({ ...s, liked: nextLiked, likes: Math.max(0, nextLikes) }));

    try {
      const res = await toggleLikePost(post.id);
      if (res && typeof res.likeCount === "number") {
        setState((s) => ({ ...s, liked: res.liked, likes: res.likeCount }));
      }
    } catch (err) {
      console.warn("Like sync fallback:", err);
    }
  }

  async function handleRepost() {
    const nextReposted = !state.reposted;
    const nextReposts = state.reposts + (nextReposted ? 1 : -1);
    setState((s) => ({ ...s, reposted: nextReposted, reposts: Math.max(0, nextReposts) }));

    try {
      const res = await toggleRepostPost(post.id);
      if (res && typeof res.repostCount === "number") {
        setState((s) => ({ ...s, reposted: res.reposted, reposts: res.repostCount }));
      }
      toast(nextReposted ? "Reposted to your profile" : "Repost undone");
    } catch (err) {
      console.warn("Repost sync fallback:", err);
    }
  }

  async function handleBookmark() {
    const nextSaved = !state.saved;
    setState((s) => ({ ...s, saved: nextSaved }));

    try {
      const res = await toggleBookmarkPost(post.id);
      if (res && typeof res.bookmarked === "boolean") {
        setState((s) => ({ ...s, saved: res.bookmarked }));
      }
      toast(nextSaved ? "Saved to Bookmarks" : "Removed from Bookmarks");
    } catch (err) {
      console.warn("Bookmark sync fallback:", err);
    }
  }

  async function handleCommentSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!commentDraft.trim() || submittingComment) return;

    setSubmittingComment(true);
    const text = commentDraft.trim();
    try {
      const res = await addPostComment(post.id, text);
      const newComment = res.comment as Comment;
      // The same comment also arrives through the realtime bridge, so only add
      // it when it isn't already in the list.
      setCommentsList((prev) =>
        prev.some((c) => c.id === newComment.id) ? prev : [...prev, newComment],
      );
      setCommentDraft("");
      toast.success("Comment added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add your comment");
    } finally {
      setSubmittingComment(false);
    }
  }

  function handleShare() {
    const shareUrl = window.location.origin + "/post/" + post.id;
    if (navigator.share) {
      navigator
        .share({
          title: `${author.display_name} on Spaces1`,
          text: post.content,
          url: shareUrl,
        })
        .catch(() => {});
    } else {
      navigator.clipboard.writeText(shareUrl);
      toast.success("Post link copied to clipboard!");
    }
  }

  async function handleDelete() {
    setShowMenu(false);
    try {
      await deletePost(post.id);
      onDeleted?.(post.id);
      toast.success("Post deleted");
    } catch (err: any) {
      toast.error("Failed to delete post: " + (err.message || "Error"));
    }
  }

  const isMine = post.user_id === currentUser.id;

  async function handleSendFeedback(
    action: "interested" | "not_interested" | "mute_author",
    tag?: string,
  ) {
    setShowMenu(false);
    try {
      if (action === "interested") {
        await sendFeedFeedback({ postId: post.id, action: "interested", tag });
        toast.success("Tuned! We'll recommend more posts like this");
      } else if (action === "not_interested") {
        await sendFeedFeedback({ postId: post.id, action: "not_interested", tag });
        toast("Tuned! We'll show fewer posts like this");
      } else if (action === "mute_author") {
        await sendFeedFeedback({ postId: post.id, action: "mute_author", authorId: post.user_id });
        toast(`Muted posts from @${author.username}`);
      }
    } catch {
      toast.error("Failed to update preference");
    }
  }

  return (
    <article
      ref={cardRef}
      style={{ animationDelay: `${index * 60}ms` }}
      className="glass-panel animate-in fade-in slide-in-from-bottom-3 rounded-3xl p-4 sm:p-5 shadow-soft duration-700 ease-out fill-mode-both transition-all hover:shadow-lift relative isolate overflow-hidden min-w-0 max-w-full break-words"
    >
      <header className="flex items-start gap-3">
        <Link
          to="/profile"
          search={{ id: author.id, user: author.username }}
          className="shrink-0 rounded-full transition-transform duration-200 hover:scale-105 active:scale-95"
        >
          <Avatar
            name={author.display_name}
            src={author.avatar_url}
            className="h-11 w-11 text-xs shrink-0"
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Link
              to="/profile"
              search={{ id: author.id, user: author.username }}
              className="truncate font-bold hover:text-brand hover:underline transition-colors"
            >
              {author.display_name}
            </Link>
            <UserBadge plan={author.plan} verified={author.verified} isMe={isMine} size="xs" />
            <Link
              to="/profile"
              search={{ id: author.id, user: author.username }}
              className="truncate text-sm text-muted-foreground hover:text-brand transition-colors"
            >
              @{author.username}
            </Link>
            <span className="text-muted-foreground">·</span>
            <TimeAgo iso={post.created_at} className="shrink-0 text-sm text-muted-foreground" />
          </div>
          {/* Content with Expand/Collapse & Link Parsers */}
          {(() => {
            const isLongContent = post.content.length > 240 || post.content.split("\n").length > 3;
            if (!isLongContent) {
              return (
                <p className="mt-2 max-h-[380px] overflow-y-auto custom-scrollbar pr-1 whitespace-pre-wrap text-[0.975rem] leading-relaxed [overflow-wrap:anywhere]">
                  {renderContentWithLinks(post.content)}
                </p>
              );
            }
            return (
              <div className="mt-2 text-[0.975rem] leading-relaxed [overflow-wrap:anywhere]">
                <p
                  className={cn(
                    "whitespace-pre-wrap transition-all duration-300 pr-1",
                    !isExpanded && "line-clamp-3 overflow-hidden",
                  )}
                >
                  {renderContentWithLinks(post.content)}
                </p>
                <button
                  type="button"
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="mt-1 text-xs font-bold text-brand hover:text-brand-pink transition-colors focus:outline-none"
                >
                  {isExpanded ? "Show less" : "... Read more"}
                </button>
              </div>
            );
          })()}
        </div>

        {/* More Menu */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setShowMenu(!showMenu)}
            aria-label="More options"
            className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>

          {showMenu && (
            <div className="absolute right-0 top-8 z-30 w-52 rounded-2xl border border-border/80 bg-card/95 p-1.5 shadow-xl backdrop-blur-md animate-in fade-in duration-150 divide-y divide-border/40">
              <div className="space-y-0.5 pb-1">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(window.location.origin + "/post/" + post.id);
                    setShowMenu(false);
                    toast.success("Link copied!");
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold hover:bg-foreground/5 transition-colors"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy link
                </button>

                <button
                  onClick={() => {
                    handleBookmark();
                    setShowMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold hover:bg-foreground/5 transition-colors"
                >
                  <Bookmark className="h-3.5 w-3.5" />{" "}
                  {state.saved ? "Remove bookmark" : "Bookmark post"}
                </button>
              </div>

              {!isMine && (
                <div className="space-y-0.5 py-1">
                  <button
                    onClick={() => handleSendFeedback("interested")}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/10 transition-colors"
                  >
                    <ThumbsUp className="h-3.5 w-3.5" /> More like this
                  </button>

                  <button
                    onClick={() => handleSendFeedback("not_interested")}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-foreground/5 transition-colors"
                  >
                    <ThumbsDown className="h-3.5 w-3.5" /> Not interested
                  </button>

                  <button
                    onClick={() => handleSendFeedback("mute_author")}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-foreground/5 transition-colors"
                  >
                    <VolumeX className="h-3.5 w-3.5" /> Mute @{author.username}
                  </button>
                </div>
              )}

              <div className="pt-1">
                {isMine ? (
                  <button
                    onClick={handleDelete}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold text-rose-500 hover:bg-rose-500/10 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete post
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setShowMenu(false);
                      setIsReportModalOpen(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold text-rose-500 hover:bg-rose-500/10 transition-colors"
                  >
                    <Flag className="h-3.5 w-3.5" /> Report post
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Media attachment (Image, Video, or Multi-Image Gallery) */}
      {(() => {
        // Gather and flatten all possible sources into a unique, cleaned array
        const candidateUrls: string[] = [];
        const sources = [mediaSrc, (post as any).media_urls, (post as any).images];

        for (const src of sources) {
          if (!src) continue;
          if (Array.isArray(src)) {
            candidateUrls.push(...src.filter((s) => typeof s === "string"));
          } else if (typeof src === "string") {
            if (src.includes(",")) {
              candidateUrls.push(...src.split(",").map((s) => s.trim()));
            } else {
              candidateUrls.push(src.trim());
            }
          }
        }

        const allMedia = Array.from(
          new Set(candidateUrls.filter((u) => typeof u === "string" && u.trim() !== "")),
        );

        if (allMedia.length === 0 || imageError) return null;

        const hasVideo = allMedia.some(isMediaVideo);

        // Multi-image/media carousel (completely scrollable with snap alignments)
        if (allMedia.length > 1) {
          return (
            <div className="mt-3.5 space-y-1.5 pl-14 pr-1">
              <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground px-0.5">
                <span className="flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-brand" /> {allMedia.length} Media attachments
                </span>
                <span className="text-[10px] uppercase tracking-wider font-mono bg-muted/60 dark:bg-muted/10 px-2.5 py-0.5 rounded-full text-muted-foreground/95 flex items-center gap-1">
                  Swipe ➔
                </span>
              </div>
              <div className="flex gap-2.5 overflow-x-auto pb-2 pt-0.5 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden touch-pan-x snap-x snap-mandatory">
                {allMedia.map((url, idx) => (
                  <div
                    key={`${url}_${idx}`}
                    className={cn(
                      "relative overflow-hidden rounded-2xl border border-border/70 bg-neutral-950/20 aspect-[4/3] group/card cursor-pointer shadow-xs shrink-0 snap-start",
                      hasVideo
                        ? "w-full"
                        : allMedia.length === 2
                          ? "w-[calc(50%-5px)]"
                          : "w-[85%] sm:w-[48%]",
                    )}
                    onClick={() => {
                      setPreviewMediaUrl(url);
                      setShowImagePreview(true);
                    }}
                  >
                    {isMediaVideo(url) ? (
                      <ModernVideoPlayer src={url} className="w-full h-full object-cover" />
                    ) : (
                      <img
                        src={optimizeImageUrl(url, 800)}
                        alt={`Attachment ${idx + 1}`}
                        loading="lazy"
                        className="w-full h-full object-cover transition-transform duration-500 group-hover/card:scale-105"
                      />
                    )}
                    <div className="absolute top-2.5 right-2.5 rounded-full bg-black/60 backdrop-blur-md px-2.5 py-0.5 text-[10px] font-bold text-white/95 shadow-sm z-10 font-mono">
                      {idx + 1}/{allMedia.length}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        }

        const singleUrl = allMedia[0];
        if (isMediaVideo(singleUrl) || (post as any).media_type === "video") {
          return (
            <div className="mt-3.5 overflow-hidden rounded-2xl border border-border/60 bg-black relative w-full shadow-md">
              <ModernVideoPlayer src={singleUrl} className="w-full" />
            </div>
          );
        }

        return (
          <div
            onClick={() => {
              setPreviewMediaUrl(singleUrl);
              setShowImagePreview(true);
            }}
            className="mt-3.5 overflow-hidden rounded-2xl border border-border/60 bg-neutral-950/20 dark:bg-black/30 cursor-zoom-in transition-all duration-300 hover:border-brand/50 group relative flex items-center justify-center w-full p-0 sm:p-0.5 sm:max-h-[440px]"
          >
            <img
              src={optimizeImageUrl(singleUrl, 1000)}
              alt="Post media"
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setImageError(true)}
              className="w-full h-auto block rounded-2xl sm:rounded-xl sm:max-h-[420px] sm:object-contain transition-transform duration-500 ease-out group-hover:scale-[1.008]"
            />
            <div className="pointer-events-none absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-full bg-black/70 backdrop-blur-md px-2.5 py-1 text-[10px] font-bold text-white/95 flex items-center gap-1 shadow-sm">
              <Maximize2 className="h-3 w-3 text-brand" /> Zoom
            </div>
          </div>
        );
      })()}

      {/* Image Full-screen Lightbox Modal */}
      {showImagePreview &&
        (previewMediaUrl || mediaSrc) &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-in fade-in duration-200"
            onClick={() => setShowImagePreview(false)}
          >
            <div
              className="relative max-w-5xl max-h-[92vh] overflow-hidden rounded-3xl"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={previewMediaUrl || mediaSrc || ""}
                alt="Full preview"
                className="max-h-[85vh] w-auto max-w-full rounded-2xl object-contain shadow-2xl"
              />
              <button
                onClick={() => setShowImagePreview(false)}
                className="absolute top-4 right-4 rounded-full bg-black/70 p-2 text-white hover:bg-black/90 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>
          </div>,
          document.body,
        )}

      {post.image_gradient && !mediaSrc && (
        <div className="mt-4 overflow-hidden rounded-2xl">
          <div
            className={cn(
              "aspect-[16/10] w-full bg-gradient-to-br transition-transform duration-700 ease-out hover:scale-[1.03]",
              post.image_gradient,
            )}
          />
        </div>
      )}

      {/* Interactive Poll */}
      {poll && (
        <div className="mt-4 rounded-2xl border border-border/80 bg-foreground/[0.03] p-4 space-y-2.5">
          {poll.question && (
            <p className="text-sm font-bold text-foreground mb-3">{poll.question}</p>
          )}
          <div className="space-y-2">
            {poll.options.map((opt) => {
              const pct = poll.totalVotes > 0 ? Math.round((opt.votes / poll.totalVotes) * 100) : 0;
              const isSelected = opt.votedByMe;

              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={hasVotedInPoll}
                  onClick={() => handleVote(opt.id)}
                  className={cn(
                    "group relative w-full overflow-hidden rounded-xl border p-3 text-left transition-all",
                    hasVotedInPoll
                      ? "cursor-default border-border/60 bg-foreground/5"
                      : "cursor-pointer border-border hover:border-brand/60 hover:bg-brand/5 active:scale-[0.99]",
                    isSelected && "border-brand bg-brand/10 ring-1 ring-brand",
                  )}
                >
                  {/* Animated Fill Bar */}
                  {hasVotedInPoll && (
                    <div
                      style={{ width: `${pct}%` }}
                      className={cn(
                        "absolute inset-y-0 left-0 transition-all duration-700 ease-out",
                        isSelected
                          ? "bg-gradient-to-r from-brand/25 to-brand-pink/25"
                          : "bg-foreground/10",
                      )}
                    />
                  )}

                  <div className="relative flex items-center justify-between gap-2 text-xs font-semibold">
                    <span className="flex items-center gap-1.5 truncate">
                      {isSelected && <CheckCircle2 className="h-3.5 w-3.5 text-brand shrink-0" />}
                      <span className={cn(isSelected ? "text-brand font-bold" : "text-foreground")}>
                        {opt.text}
                      </span>
                    </span>
                    {hasVotedInPoll && (
                      <span className="tabular-nums shrink-0 font-bold text-muted-foreground">
                        {pct}% ({compact(opt.votes)})
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 px-1">
            <span>{compact(poll.totalVotes)} total votes</span>
            <span>{hasVotedInPoll ? "Final results" : "Click an option to vote"}</span>
          </div>
        </div>
      )}

      {post.tags && post.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 pl-14">
          {post.tags.map((t) => {
            const cleanTag = t.replace(/^#/, "");
            return (
              <Link
                key={t}
                to="/explore"
                search={{ tag: cleanTag }}
                className="rounded-full bg-brand/8 px-3 py-1 text-xs font-semibold text-brand transition-all hover:bg-brand/15 hover:scale-105 active:scale-95"
              >
                #{cleanTag}
              </Link>
            );
          })}
        </div>
      )}

      <footer className="mt-3 flex items-center justify-between border-t border-border/60 pt-2 px-0.5 overflow-x-auto [scrollbar-width:none] gap-0.5 sm:gap-1">
        <Action
          icon={Heart}
          label="Like"
          count={state.likes}
          active={state.liked}
          filled
          activeClass="text-rose-500"
          onClick={handleLike}
        />
        <Action
          icon={MessageCircle}
          label="Comment"
          count={commentsList.length}
          active={showComments}
          activeClass="text-sky-500"
          onClick={() => setShowComments(!showComments)}
        />
        <Action
          icon={Repeat2}
          label="Repost"
          count={state.reposts}
          active={state.reposted}
          activeClass="text-emerald-500"
          onClick={handleRepost}
        />
        <Action icon={BarChart3} label="Views" count={state.views} activeClass="" />
        <Action
          icon={DollarSign}
          label="Tip Creator"
          activeClass="text-amber-500"
          onClick={() => setIsTipModalOpen(true)}
        />
        <Action
          icon={Bookmark}
          label="Bookmark"
          active={state.saved}
          filled
          activeClass="text-brand"
          onClick={handleBookmark}
        />
        <Action icon={Share2} label="Share" activeClass="" onClick={handleShare} />
      </footer>

      {/* Expandable Comments Drawer */}
      {showComments && (
        <div className="mt-4 space-y-3 border-t border-border/60 pt-4 animate-in fade-in duration-200">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Comments ({commentsList.length})
          </h4>

          {/* Comments List */}
          <div className="space-y-3 max-h-72 overflow-y-auto custom-scrollbar pr-1.5">
            {(showAllComments ? commentsList : commentsList.slice(0, 3)).map((c) => {
              const cAuthor = getProfile(c.user_id);
              return (
                <div key={c.id} className="flex items-start gap-2.5 text-xs">
                  <Link
                    to="/profile"
                    search={{ id: cAuthor.id, user: cAuthor.username }}
                    className="shrink-0 mt-0.5 transition-transform hover:scale-105 active:scale-95"
                  >
                    <Avatar
                      name={cAuthor.display_name}
                      src={cAuthor.avatar_url}
                      className="h-7 w-7 text-[0.6rem] shrink-0"
                    />
                  </Link>
                  <div className="flex-1 rounded-2xl bg-foreground/5 p-2.5">
                    <div className="flex items-baseline justify-between gap-1">
                      <Link
                        to="/profile"
                        search={{ id: cAuthor.id, user: cAuthor.username }}
                        className="font-bold inline-flex items-center gap-1 hover:text-brand transition-colors"
                      >
                        {cAuthor.display_name}
                        <UserBadge
                          plan={cAuthor.plan}
                          verified={cAuthor.verified}
                          isMe={c.user_id === currentUser.id}
                          size="xs"
                        />
                      </Link>
                      <TimeAgo iso={c.created_at} className="text-[10px] text-muted-foreground" />
                    </div>
                    <div className="mt-1 text-foreground/90 leading-relaxed">
                      <ClampText
                        text={c.content}
                        lines={4}
                        limit={240}
                        render={renderContentWithLinks}
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            {commentsList.length > 3 && !showAllComments && (
              <button
                type="button"
                onClick={() => setShowAllComments(true)}
                className="w-full text-center text-xs font-bold text-brand hover:text-brand-pink hover:underline py-2 transition-all"
              >
                Show all {commentsList.length} comments
              </button>
            )}

            {commentsList.length > 3 && showAllComments && (
              <button
                type="button"
                onClick={() => setShowAllComments(false)}
                className="w-full text-center text-xs font-bold text-brand hover:text-brand-pink hover:underline py-2 transition-all"
              >
                Collapse comments
              </button>
            )}

            {commentsList.length === 0 && (
              <p className="text-xs text-muted-foreground py-2 text-center">
                No comments yet. Start the conversation!
              </p>
            )}
          </div>

          {/* Add comment input */}
          <form onSubmit={handleCommentSubmit} className="flex items-center gap-2 pt-1">
            <Link
              to="/profile"
              search={{ id: activeUser.id, user: activeUser.username }}
              className="shrink-0 transition-transform hover:scale-105 active:scale-95"
            >
              <Avatar
                name={activeUser.display_name}
                src={activeUser.avatar_url}
                className="h-8 w-8 text-xs shrink-0"
              />
            </Link>
            <input
              type="text"
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              placeholder="Write a reply..."
              className="flex-1 rounded-full bg-foreground/5 px-4 py-2 text-xs outline-none border border-transparent focus:border-brand/40"
            />
            <button
              type="submit"
              disabled={!commentDraft.trim() || submittingComment}
              className="rounded-full bg-brand text-white p-2 hover:bg-brand/90 transition-all disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}

      {/* Tip Creator Modal */}
      <TipModal
        isOpen={isTipModalOpen}
        onClose={() => setIsTipModalOpen(false)}
        recipient={{
          username: author.username,
          display_name: author.display_name,
          avatar_url: author.avatar_url,
          plan: author.plan,
        }}
        postId={post.id}
      />

      {/* Report Post Modal */}
      <ReportModal
        isOpen={isReportModalOpen}
        onClose={() => setIsReportModalOpen(false)}
        targetType="post"
        targetId={post.id}
        targetPreview={post.content}
        authorId={author.id}
        authorName={author.display_name}
      />
    </article>
  );
}

/** Memoised so a feed re-render only re-renders the cards whose data changed. */
export const PostCard = memo(
  PostCardBase,
  (prev, next) =>
    prev.post === next.post && prev.index === next.index && prev.onDeleted === next.onDeleted,
);
