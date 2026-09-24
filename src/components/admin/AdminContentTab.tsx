import { useState, useEffect } from "react";
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
  AlertTriangle,
} from "lucide-react";
import {
  getAdminPosts,
  forceDeletePostAdmin,
  terminateSpaceAdmin,
  getSpaces,
  getStories,
  deleteStory,
} from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import type { Post, Space, Story, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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

  const fetchContent = async () => {
    try {
      setLoading(true);
      if (contentType === "posts") {
        const p = await getAdminPosts({ query: searchQuery || undefined });
        setPosts(p);
      } else if (contentType === "spaces") {
        const res = await getSpaces();
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
  }, [contentType, searchQuery]);

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
    } catch (err: any) {
      toast.error(err.message || "Failed to delete post");
    }
  };

  const handleTerminateSpace = async (spaceId: string) => {
    try {
      await terminateSpaceAdmin(spaceId, currentUserId);
      setSpaces((prev) => prev.map((s) => (s.id === spaceId ? { ...s, is_live: false } : s)));
      showToast("Audio space session terminated");
    } catch (err: any) {
      toast.error(err.message || "Failed to terminate space");
    }
  };

  const handleDeleteStory = async (storyId: string) => {
    try {
      await deleteStory(storyId);
      setStories((prev) => prev.filter((s) => s.id !== storyId));
      showToast("Story deleted");
    } catch (err: any) {
      toast.error(err.message || "Failed to delete story");
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
                  <tr key={post.id} className="transition-colors hover:bg-foreground/5">
                    <td className="px-5 py-3.5 max-w-md">
                      <p className="line-clamp-2 font-medium text-foreground">{post.content}</p>
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
                      <code className="font-mono text-[0.7rem]">{post.user_id}</code>
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
                        <button
                          onClick={() => handleDeletePost(post.id)}
                          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[0.7rem] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/20"
                          title="Purge post"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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
              className={cn(
                "glass-panel relative flex h-52 flex-col justify-between overflow-hidden rounded-3xl border border-border/80 p-4 shadow-soft",
                story.gradient || "bg-gradient-to-br from-violet-600 to-pink-600",
              )}
            >
              <div className="flex items-center justify-between text-white drop-shadow-md">
                <span className="text-xs font-bold">{story.user_name || story.user_id}</span>
                {canDeleteContent && (
                  <button
                    onClick={() => handleDeleteStory(story.id)}
                    className="rounded-lg bg-black/40 p-1.5 text-white hover:bg-black/60"
                    title="Delete story"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <p className="text-sm font-semibold text-white drop-shadow-md line-clamp-3">
                {story.text}
              </p>

              <div className="flex items-center justify-between text-xs text-white/90 drop-shadow-md">
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
    </div>
  );
}
