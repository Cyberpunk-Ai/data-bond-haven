import { useState, useEffect, useMemo, useRef } from "react";
import {
  FileText,
  Radio,
  Sparkles,
  Eye,
  Heart,
  MessageSquare,
  Repeat2,
  Trash2,
  Search,
  RefreshCw,
  CheckCircle2,
  StopCircle,
  Tag,
  X,
  MapPin,
  ExternalLink,
} from "lucide-react";
import {
  getAdminPosts,
  forceDeletePostAdmin,
  hidePostAdmin,
  markPostSensitiveAdmin,
  terminateSpaceAdmin,
  getSpaces,
  getStories,
  deleteStory,
} from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import { useProfiles } from "@/lib/profile-service";
import type { Post, Space, Story, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";
import { firstMedia, splitMediaList } from "@/lib/media-list";
import { useAuthorizedMediaUrl } from "@/lib/media-access";
import { Avatar } from "@/components/social/Avatar";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";

interface AdminContentTabProps {
  activeRole: UserRole;
  currentUserId: string;
}

export function AdminContentTab({ activeRole, currentUserId }: AdminContentTabProps) {
  const [contentType, setContentType] = useState<"posts" | "spaces" | "stories">("posts");
  const [posts, setPosts] = useState<Post[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Click-to-view previews: admins can open any post or story and see the
  // exact content members see (full text, media, stats) before moderating.
  const [previewPost, setPreviewPost] = useState<Post | null>(null);
  const [previewStory, setPreviewStory] = useState<Story | null>(null);
  // One in-flight hide/unhide at a time, so a double click cannot send the
  // same moderation action twice.
  const [hidingPostId, setHidingPostId] = useState<string | null>(null);
  // Same guard for the sensitive-media flag, which is a different write and so
  // must not be able to overlap with itself on the same row.
  const [flaggingPostId, setFlaggingPostId] = useState<string | null>(null);
  // Posts page in 50-row chunks; the moderation table no longer ships the
  // newest 200 rows on every tab open or keystroke.
  const POSTS_PAGE = 50;
  const [postsHasMore, setPostsHasMore] = useState(false);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const postsOffsetRef = useRef(0);
  // The Author column used to print raw profile UUIDs. getAdminPosts() already
  // hydrates the shared profile cache for every author, so resolve names from
  // it (batched, no per-row fetch).
  const authorIds = useMemo(() => Array.from(new Set(posts.map((p) => p.user_id))), [posts]);
  const authors = useProfiles(authorIds);

  // Searching fired a fresh 200-row query on every keystroke. Debounce it and
  // let the server narrow the result set instead.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const fetchContent = async () => {
    try {
      setLoading(true);
      if (contentType === "posts") {
        postsOffsetRef.current = 0;
        const p = await getAdminPosts(
          { query: debouncedQuery || undefined },
          { limit: POSTS_PAGE, offset: 0 },
        );
        setPosts(p);
        postsOffsetRef.current = POSTS_PAGE;
        setPostsHasMore(Boolean((p as Post[] & { hasMore?: boolean }).hasMore));
      } else if (contentType === "spaces") {
        // Staff moderation wants breadth, so ask for a generous (but still
        // bounded) window rather than the unbounded full-table read.
        const res = await getSpaces({ limit: 500 });
        setSpaces(res.spaces || []);
      } else if (contentType === "stories") {
        const st = await getStories();
        setStories(st);
      }
    } catch (err) {
      console.error("Failed to fetch admin content", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContent();
  }, [contentType, debouncedQuery]);

  const loadMorePosts = async () => {
    if (loadingMorePosts || !postsHasMore) return;
    try {
      setLoadingMorePosts(true);
      const p = await getAdminPosts(
        { query: debouncedQuery || undefined },
        { limit: POSTS_PAGE, offset: postsOffsetRef.current },
      );
      setPosts((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...p.filter((x: Post) => !seen.has(x.id))];
      });
      postsOffsetRef.current += POSTS_PAGE;
      setPostsHasMore(Boolean((p as Post[] & { hasMore?: boolean }).hasMore));
    } catch {
      setPostsHasMore(false);
    } finally {
      setLoadingMorePosts(false);
    }
  };

  useRealtime({
    "post:deleted": ({ id }: { id: string }) => {
      setPosts((prev) => prev.filter((p) => p.id !== id));
    },
    "space:ended": ({ spaceId }: { spaceId: string }) => {
      setSpaces((prev) =>
        prev.map((s) => (s.id === spaceId ? { ...s, live: false, is_live: false } : s)),
      );
    },
  });

  const showToast = (msg: string) => {
    setToastMessage(msg);
    toast.success(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const handleDeletePost = async (postId: string) => {
    try {
      await forceDeletePostAdmin(postId, currentUserId);
      setPosts((prev) => prev.filter((p) => p.id !== postId));
      showToast("Post removed by administrator");
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't delete that post. Try again."));
    }
  };

  /**
   * Hide (or restore) without deleting — the lighter half of the moderation
   * toolset the server already supports (`moderatePost` writes an audit entry
   * either way). A hidden post disappears from every feed but stays on the
   * author's profile row, so it can be restored if the report was wrong.
   */
  const handleToggleHidePost = async (post: Post) => {
    const nextHidden = !post.hidden;
    setHidingPostId(post.id);
    try {
      await hidePostAdmin(post.id, nextHidden);
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, hidden: nextHidden } : p)));
      setPreviewPost((prev) =>
        prev && prev.id === post.id ? { ...prev, hidden: nextHidden } : prev,
      );
      showToast(nextHidden ? "Post hidden from all feeds" : "Post restored to feeds");
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't update that post's visibility. Try again."));
    } finally {
      setHidingPostId(null);
    }
  };

  /**
   * The lightest intervention the moderation toolkit has: the post stays
   * published and stays in every feed, readers who turned the sensitive-content
   * filter on just see its media behind a tap-to-reveal veil. Use it when the
   * media is legal but not something people should meet unprepared.
   */
  const handleToggleSensitive = async (post: Post) => {
    const next = !post.is_sensitive;
    setFlaggingPostId(post.id);
    try {
      await markPostSensitiveAdmin(post.id, next);
      setPosts((prev) =>
        prev.map((p) =>
          p.id === post.id
            ? { ...p, is_sensitive: next, sensitive_source: next ? "staff" : null }
            : p,
        ),
      );
      setPreviewPost((prev) =>
        prev && prev.id === post.id
          ? { ...prev, is_sensitive: next, sensitive_source: next ? "staff" : null }
          : prev,
      );
      showToast(next ? "Media marked sensitive for filtered readers" : "Sensitive flag cleared");
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't update that post's sensitivity. Try again."));
    } finally {
      setFlaggingPostId(null);
    }
  };

  const handleTerminateSpace = async (spaceId: string) => {
    try {
      await terminateSpaceAdmin(spaceId, currentUserId);
      setSpaces((prev) => prev.map((s) => (s.id === spaceId ? { ...s, is_live: false } : s)));
      showToast("Audio space session terminated");
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't end that Space. Try again."));
    }
  };

  const handleDeleteStory = async (storyId: string) => {
    try {
      await deleteStory(storyId);
      setStories((prev) => prev.filter((s) => s.id !== storyId));
      showToast("Story deleted");
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't delete that story. Try again."));
    }
  };

  const canDeleteContent = ["superadmin", "admin", "moderator"].includes(activeRole);
  const canManageSpaces = ["superadmin", "admin", "community"].includes(activeRole);

  return (
    <div className="space-y-6">
      {/* Toast Notice */}
      {toastMessage && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs font-semibold text-emerald-800 dark:text-emerald-200 shadow-soft animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Type Switcher & Search Bar */}
      <div className="glass-panel flex flex-col gap-3 rounded-3xl border border-border/80 p-4 shadow-soft md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-1.5 rounded-2xl bg-foreground/5 p-1">
          <button
            onClick={() => setContentType("posts")}
            className={cn(
              "flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors",
              contentType === "posts"
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <FileText className="h-3.5 w-3.5" />
            <span>Posts ({posts.length})</span>
          </button>
          <button
            onClick={() => setContentType("spaces")}
            className={cn(
              "flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors",
              contentType === "spaces"
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Radio className="h-3.5 w-3.5 text-rose-500" />
            <span>Live Spaces ({spaces.length})</span>
          </button>
          <button
            onClick={() => setContentType("stories")}
            className={cn(
              "flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors",
              contentType === "stories"
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Sparkles className="h-3.5 w-3.5 text-brand" />
            <span>Stories ({stories.length})</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search content or tags..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-56 rounded-2xl border border-border bg-background/80 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          <button
            onClick={fetchContent}
            className="rounded-2xl border border-border bg-card p-2 text-foreground hover:bg-foreground/5"
            title="Refresh list"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin text-brand")} />
          </button>
        </div>
      </div>

      {/* Content Rendering by Type */}
      {contentType === "posts" && (
        <div className="glass-panel overflow-hidden rounded-3xl border border-border/80 shadow-soft">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border/60 bg-foreground/5 text-muted-foreground uppercase tracking-wider font-bold text-[0.68rem]">
              <tr>
                <th className="px-5 py-3.5">Post Content & Tags</th>
                <th className="px-4 py-3.5">Author</th>
                <th className="px-4 py-3.5">Impressions</th>
                <th className="px-4 py-3.5">Engagement</th>
                <th className="px-4 py-3.5">Date</th>
                <th className="px-5 py-3.5 text-right">Moderation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-muted-foreground">
                    <RefreshCw className="mx-auto h-5 w-5 animate-spin text-brand mb-2" />
                    Fetching posts...
                  </td>
                </tr>
              ) : posts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-muted-foreground">
                    No posts found.
                  </td>
                </tr>
              ) : (
                posts.map((post) => (
                  <tr
                    key={post.id}
                    onClick={() => setPreviewPost(post)}
                    title="Click to view the full post"
                    className="cursor-pointer transition-colors hover:bg-foreground/5"
                  >
                    <td className="px-5 py-3.5 max-w-md">
                      <p className="line-clamp-2 font-medium text-foreground">{post.content}</p>
                      {post.hidden && (
                        <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                          <StopCircle className="h-2.5 w-2.5" />
                          Hidden
                        </span>
                      )}
                      {post.tags && post.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {post.tags.map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center gap-0.5 rounded-md bg-foreground/5 px-1.5 py-0.2 text-[0.65rem] text-brand font-semibold"
                            >
                              <Tag className="h-2.5 w-2.5" />
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground">
                      <p className="max-w-[11rem] truncate font-semibold text-foreground">
                        {authors[post.user_id]?.display_name || "Unknown member"}
                      </p>
                      <p className="max-w-[11rem] truncate font-mono text-[0.7rem]">
                        {authors[post.user_id]?.username
                          ? `@${authors[post.user_id].username}`
                          : `${post.user_id.slice(0, 8)}\u2026`}
                      </p>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="flex items-center gap-1 font-bold text-foreground">
                        <Eye className="h-3 w-3 text-emerald-500" />
                        {(post.viewCount || 0).toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3 text-muted-foreground text-[0.7rem]">
                        <span className="flex items-center gap-1">
                          <Heart className="h-3 w-3 text-rose-500" />
                          {post.likeCount || 0}
                        </span>
                        <span className="flex items-center gap-1">
                          <MessageSquare className="h-3 w-3 text-blue-500" />
                          {post.commentCount || 0}
                        </span>
                        <span className="flex items-center gap-1">
                          <Repeat2 className="h-3 w-3 text-emerald-500" />
                          {post.repostCount || 0}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground text-[0.7rem]">
                      {new Date(post.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {canDeleteContent && (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleToggleHidePost(post);
                            }}
                            disabled={hidingPostId === post.id}
                            className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[0.7rem] font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 disabled:opacity-60"
                            title={
                              post.hidden
                                ? "Restore this post to all feeds"
                                : "Hide from feeds without deleting"
                            }
                          >
                            {post.hidden ? "Restore" : "Hide"}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleToggleSensitive(post);
                            }}
                            disabled={flaggingPostId === post.id}
                            className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[0.7rem] font-bold text-violet-700 dark:text-violet-300 hover:bg-violet-500/20 disabled:opacity-60"
                            title={
                              post.is_sensitive
                                ? "Clear the sensitive flag (overrides the community threshold)"
                                : "Blur this post's media for readers with the filter on"
                            }
                          >
                            {post.is_sensitive ? "Unblur" : "Blur"}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeletePost(post.id);
                            }}
                            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[0.7rem] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/20"
                            title="Purge post"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {postsHasMore && (
            <div className="flex justify-center pt-3">
              <button
                type="button"
                disabled={loadingMorePosts}
                onClick={() => void loadMorePosts()}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/5 px-5 py-2 text-xs font-bold text-brand transition-all active:scale-95 cursor-pointer disabled:opacity-60"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loadingMorePosts && "animate-spin")} />
                Load {POSTS_PAGE} more posts
              </button>
            </div>
          )}
        </div>
      )}

      {contentType === "spaces" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.map((space) => {
            const isLive = space.live ?? space.is_live ?? false;
            return (
              <div
                key={space.id}
                className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft"
              >
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.68rem] font-bold",
                      isLive
                        ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 animate-pulse"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Radio className="h-3 w-3" />
                    {isLive ? "LIVE" : "ENDED"}
                  </span>
                  <span className="text-[0.7rem] text-muted-foreground">
                    {space.listeners} listeners
                  </span>
                </div>

                <h3 className="text-sm font-bold text-foreground mt-3">{space.title}</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Hosted by: <strong>{space.host_name || space.host_id}</strong>
                </p>

                <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/60">
                  <span className="rounded-md bg-foreground/5 px-2 py-0.5 text-[0.65rem] font-semibold text-brand">
                    {space.topic}
                  </span>

                  {canManageSpaces && isLive && (
                    <button
                      onClick={() => handleTerminateSpace(space.id)}
                      className="flex items-center gap-1 rounded-xl bg-rose-600 px-2.5 py-1 text-[0.7rem] font-bold text-white shadow-soft hover:bg-rose-700"
                    >
                      <StopCircle className="h-3 w-3" />
                      <span>Terminate</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {contentType === "stories" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {stories.map((story) => (
            <div
              key={story.id}
              onClick={() => setPreviewStory(story)}
              title="Click to view the full story"
              className={cn(
                // Story gradients only carry the from/via/to colour stops (same
                // as the feed's story rings) — without an explicit direction
                // class nothing paints, which made these cards translucent
                // with white text on top. Set the gradient AND a dark veil so
                // the labels stay legible on every palette, including the
                // light ones like the yellow theme.
                "relative flex h-52 cursor-pointer flex-col justify-between overflow-hidden rounded-3xl border border-black/10 shadow-soft transition-transform hover:scale-[1.015] bg-gradient-to-br",
                story.gradient || "from-violet-600 to-pink-600",
              )}
            >
              {/* Image stories show the actual media behind the veil */}
              {story.media_url && <StoryPreviewImage url={story.media_url} />}
              <div className="absolute inset-0 bg-black/25" aria-hidden />
              <div className="relative flex items-center justify-between text-white drop-shadow-md">
                <span className="text-xs font-bold">{story.user_name || story.user_id}</span>
                {canDeleteContent && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteStory(story.id);
                    }}
                    className="rounded-lg bg-black/40 p-1.5 text-white hover:bg-black/60"
                    title="Delete story"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <p className="relative text-sm font-semibold text-white drop-shadow-md line-clamp-3">
                {story.text}
              </p>

              <div className="relative flex items-center justify-between text-xs text-white/95 drop-shadow-md">
                <span>❤️ {story.likes_count || 0}</span>
                <span className="text-[0.68rem]">
                  {new Date(story.created_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Click-to-view: full post preview */}
      {previewPost && (
        <PostPreviewModal
          post={previewPost}
          author={authors[previewPost.user_id]}
          onClose={() => setPreviewPost(null)}
          onDelete={
            canDeleteContent
              ? async () => {
                  await handleDeletePost(previewPost.id);
                  setPreviewPost(null);
                }
              : undefined
          }
          onHide={canDeleteContent ? () => void handleToggleHidePost(previewPost) : undefined}
        />
      )}

      {/* Click-to-view: full story preview */}
      {previewStory && (
        <StoryPreviewModal
          story={previewStory}
          authorName={previewStory.user_name || authors[previewStory.user_id]?.display_name}
          onClose={() => setPreviewStory(null)}
          onDelete={
            canDeleteContent
              ? async () => {
                  await handleDeleteStory(previewStory.id);
                  setPreviewStory(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/** Story images are follow-network private media — mint the signed URL. */
function StoryPreviewImage({ url, contain = false }: { url: string; contain?: boolean }) {
  const first = firstMedia(url);
  const { src } = useAuthorizedMediaUrl(first);
  if (!src) return null;
  return (
    <img
      src={src}
      alt="Story media"
      className={cn(
        "absolute inset-0 h-full w-full",
        contain ? "object-contain bg-black/60" : "object-cover",
      )}
    />
  );
}

/** Same rule for post media (public folder — returned as-is, no token). */
function PostMediaImage({ url }: { url: string }) {
  const { src } = useAuthorizedMediaUrl(url);
  if (!src) return null;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block">
      <img
        src={src}
        alt="Post media"
        className="max-h-[22rem] w-full rounded-2xl border border-border/60 object-contain bg-black/40"
      />
      <span className="mt-1 flex items-center gap-1 text-[0.68rem] text-muted-foreground hover:text-brand">
        <ExternalLink className="h-3 w-3" /> Open full size
      </span>
    </a>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function PostPreviewModal({
  post,
  author,
  onClose,
  onDelete,
  onHide,
}: {
  post: Post;
  author?: { display_name: string; username: string; avatar_url: string | null };
  onClose: () => void;
  onDelete?: () => void;
  onHide?: () => void;
}) {
  const mediaUrls = splitMediaList(post.media_url || post.image_url || "");
  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar
            name={author?.display_name || "Member"}
            src={author?.avatar_url}
            className="h-9 w-9 text-xs"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{author?.display_name || "Unknown member"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {author?.username ? `@${author.username}` : `${post.user_id.slice(0, 8)}…`}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close preview"
          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {post.content}
      </p>

      {post.tags && post.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {post.tags.map((t) => (
            <span
              key={t}
              className="rounded-md bg-brand/10 px-2 py-0.5 text-[0.7rem] font-semibold text-brand"
            >
              #{t}
            </span>
          ))}
        </div>
      )}

      {mediaUrls.length > 0 && (
        <div className="mt-4 space-y-3">
          {mediaUrls.map((u) => (
            <PostMediaImage key={u} url={u} />
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Eye className="h-3.5 w-3.5 text-emerald-500" /> {(post.viewCount || 0).toLocaleString()}{" "}
          views
        </span>
        <span className="flex items-center gap-1">
          <Heart className="h-3.5 w-3.5 text-rose-500" /> {post.likeCount || 0}
        </span>
        <span className="flex items-center gap-1">
          <MessageSquare className="h-3.5 w-3.5 text-blue-500" /> {post.commentCount || 0}
        </span>
        <span className="flex items-center gap-1">
          <Repeat2 className="h-3.5 w-3.5 text-emerald-500" /> {post.repostCount || 0}
        </span>
        <span>{new Date(post.created_at).toLocaleString()}</span>
        {post.hidden && (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            <StopCircle className="h-3 w-3" />
            Hidden from feeds
          </span>
        )}
      </div>

      {onHide && (
        <button
          onClick={onHide}
          className="mt-4 mr-2 flex items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
        >
          <StopCircle className="h-3.5 w-3.5" />
          {post.hidden ? "Restore to feeds" : "Hide from feeds"}
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          className="mt-4 flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete this post
        </button>
      )}
    </ModalShell>
  );
}

function StoryPreviewModal({
  story,
  authorName,
  onClose,
  onDelete,
}: {
  story: Story;
  authorName?: string;
  onClose: () => void;
  onDelete?: () => void;
}) {
  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold">Story preview</p>
          <p className="text-xs text-muted-foreground">
            {authorName || story.user_name || `${story.user_id.slice(0, 8)}…`}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close preview"
          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Re-render the story itself: gradient or image, veil, text, stickers */}
      <div
        className={cn(
          "relative mx-auto mt-4 flex aspect-[9/16] max-h-[60dvh] w-full max-w-[18rem] flex-col justify-between overflow-hidden rounded-3xl border border-black/15 p-4 text-white shadow-soft bg-gradient-to-br",
          story.gradient || "from-violet-600 to-pink-600",
        )}
      >
        {story.media_url && <StoryPreviewImage url={story.media_url} contain />}
        <div className="absolute inset-0 bg-black/30" aria-hidden />
        <div className="relative flex items-center justify-between text-xs font-bold drop-shadow">
          <span>{authorName || "Member"}</span>
          {story.mood && <span>{story.mood}</span>}
        </div>
        <div className="relative">
          {(story.stickers?.length ?? 0) > 0 && (
            <p className="mb-1 text-2xl drop-shadow">
              {(story.stickers ?? [])
                .map((s) => (typeof s === "string" ? s : s.emoji))
                .filter(Boolean)
                .join(" ")}
            </p>
          )}
          <p className="whitespace-pre-wrap text-sm font-semibold drop-shadow-md">
            {story.text || story.caption || "(media story)"}
          </p>
          {story.location && (
            <p className="mt-1.5 flex items-center gap-1 text-[0.7rem] text-white/90">
              <MapPin className="h-3 w-3" /> {story.location}
            </p>
          )}
        </div>
        <div className="relative flex items-center justify-between text-[0.7rem] font-semibold drop-shadow">
          <span>❤️ {story.likes_count || 0}</span>
          <span>👁 {story.view_count || 0}</span>
          <span>{new Date(story.created_at).toLocaleString()}</span>
        </div>
      </div>

      {onDelete && (
        <button
          onClick={onDelete}
          className="mt-4 flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete this story
        </button>
      )}
    </ModalShell>
  );
}
