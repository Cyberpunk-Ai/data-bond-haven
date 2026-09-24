import { useCurrentUserId } from "@/hooks/useCurrentUserId";
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useMemo } from "react";
import { Sparkles, RefreshCw, Loader2, Plus, Sparkle, ArrowUp, Compass } from "lucide-react";
import { AppShell, Panel } from "@/components/social/AppShell";
import { Composer } from "@/components/social/Composer";
import { PostCard } from "@/components/social/PostCard";
import { DefaultRail } from "@/components/social/RightRail";
import { Avatar } from "@/components/social/Avatar";
import { StoryModal } from "@/components/social/StoryModal";
import { StoryCreatorModal } from "@/components/social/StoryCreatorModal";
import { FeedSkeleton } from "@/components/social/PostSkeleton";
import { getCachedFeedData, triggerFeedPreload } from "@/lib/feed-cache";
import type { Post, Profile, Story } from "@/lib/types";
import { currentUser, getProfile } from "@/lib/profile-service";
import { getPosts, getStories } from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import { useAuth } from "@/lib/auth-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/feed")({
  validateSearch: (search: Record<string, unknown>): { compose?: string } => ({
    compose: search.compose ? String(search.compose) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Your Feed — Spaces1" },
      {
        name: "description",
        content:
          "Your Spaces1 home: share a moment, follow live Spaces, and see posts from the creators and communities you care about.",
      },
      { property: "og:title", content: "Your Feed — Spaces1" },
      {
        property: "og:description",
        content: "Share moments, join live Spaces, and discover creators on Spaces1.",
      },
    ],
  }),
  component: FeedPage,
});

const tabs = ["For you", "Following", "Latest"] as const;

interface StoriesBarProps {
  stories: Story[];
  onOpenStory: (storyIndex: number) => void;
  onOpenCreator: () => void;
}

function StoriesBar({ stories, onOpenStory, onOpenCreator }: StoriesBarProps) {
  const { user } = useAuth();
  const activeUser = user || currentUser;
  const myStories = stories.filter((s) => s.user_id === activeUser.id);
  const storyUserIds = Array.from(
    new Set(stories.filter((s) => s.user_id && s.user_id !== activeUser.id).map((s) => s.user_id)),
  );
  const otherUsers = useMemo(() => {
    const seen = new Set<string>();
    return storyUserIds
      .map((uid) => getProfile(uid))
      .filter((u) => {
        if (!u?.id || seen.has(u.id)) return false;
        seen.add(u.id);
        return true;
      });
  }, [storyUserIds]);

  // Map users to their most recent story if available
  const userStoryMap = new Map<string, { story: Story; index: number }>();
  stories.forEach((story, idx) => {
    if (!userStoryMap.has(story.user_id)) {
      userStoryMap.set(story.user_id, { story, index: idx });
    }
  });

  return (
    <div className="glass-panel rounded-3xl p-4 shadow-soft">
      <div className="flex items-center justify-between pb-3 px-1">
        <div className="flex items-center gap-1.5">
          <Sparkle className="h-4 w-4 text-brand-pink fill-brand-pink/30" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Stories</h3>
          <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-bold text-brand">
            {stories.length} active
          </span>
        </div>
        <button
          onClick={onOpenCreator}
          className="flex items-center gap-1 text-xs font-bold text-brand hover:text-brand-pink transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Add Story</span>
        </button>
      </div>

      <div className="flex gap-3 sm:gap-4 overflow-x-auto pb-1 pt-1 [scrollbar-width:none] touch-pan-x">
        {/* Slot 1: Current User (Add / View Your Story) */}
        <div className="relative group flex w-16 shrink-0 flex-col items-center gap-2">
          {myStories.length > 0 ? (
            <>
              <button
                onClick={() => {
                  const entry = userStoryMap.get(activeUser.id);
                  if (entry) onOpenStory(entry.index);
                  else onOpenCreator();
                }}
                className="relative flex flex-col items-center cursor-pointer"
              >
                <span className="flex items-center justify-center h-16 w-16 aspect-square shrink-0 rounded-full p-[2.5px] bg-gradient-to-tr from-brand via-brand-pink to-brand-orange transition-transform duration-300 group-hover:scale-105 group-active:scale-95 shadow-soft">
                  <span className="flex items-center justify-center h-full w-full aspect-square shrink-0 rounded-full bg-card p-[2px]">
                    <Avatar
                      name={activeUser.display_name}
                      src={activeUser.avatar_url}
                      className="h-full w-full aspect-square rounded-full text-sm object-cover"
                    />
                  </span>
                </span>
                <span className="mt-1.5 w-full truncate text-center text-[0.7rem] font-bold text-foreground">
                  Your Story
                </span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenCreator();
                }}
                title="Add new story"
                aria-label="Add new story"
                className="absolute bottom-6 right-0 rounded-full bg-brand text-white p-1 shadow-md hover:bg-brand-pink transition-colors ring-2 ring-card cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5 stroke-[3]" />
              </button>
            </>
          ) : (
            <button
              onClick={onOpenCreator}
              className="flex flex-col items-center group w-full cursor-pointer"
            >
              <span className="relative flex items-center justify-center h-16 w-16 aspect-square shrink-0 rounded-full p-[2.5px] bg-border group-hover:bg-gradient-to-tr group-hover:from-brand group-hover:to-brand-pink transition-all duration-300 group-hover:scale-105 group-active:scale-95">
                <span className="flex items-center justify-center h-full w-full aspect-square shrink-0 rounded-full bg-card p-[2px]">
                  <Avatar
                    name={activeUser.display_name}
                    src={activeUser.avatar_url}
                    className="h-full w-full aspect-square rounded-full text-sm opacity-90 group-hover:opacity-100 object-cover"
                  />
                </span>
                <span className="absolute bottom-0 right-0 rounded-full bg-brand text-white p-1 shadow-md ring-2 ring-card">
                  <Plus className="h-3.5 w-3.5 stroke-[3]" />
                </span>
              </span>
              <span className="mt-1.5 w-full truncate text-center text-[0.7rem] font-medium text-muted-foreground group-hover:text-foreground">
                Add Story
              </span>
            </button>
          )}
        </div>

        {/* Other Users' Stories */}
        {otherUsers.map((user, idx) => {
          const entry = userStoryMap.get(user.id);
          const hasStory = Boolean(entry);

          return (
            <button
              key={`story-user-${user.id}-${idx}`}
              onClick={() => {
                if (entry) {
                  onOpenStory(entry.index);
                } else {
                  toast.info(`${user.display_name} hasn't posted a story yet today`);
                }
              }}
              className={cn(
                "group flex w-16 shrink-0 flex-col items-center gap-2 transition-opacity cursor-pointer",
                !hasStory && "opacity-75 hover:opacity-100",
              )}
            >
              <span
                className={cn(
                  "flex items-center justify-center h-16 w-16 aspect-square shrink-0 rounded-full p-[2.5px] transition-transform duration-300 group-hover:scale-105 group-active:scale-95",
                  hasStory
                    ? "bg-gradient-to-tr from-brand via-brand-pink to-brand-orange shadow-soft animate-in fade-in"
                    : "bg-border/60",
                )}
              >
                <span className="flex items-center justify-center h-full w-full aspect-square shrink-0 rounded-full bg-card p-[2px]">
                  <Avatar
                    name={user.display_name}
                    src={user.avatar_url}
                    className="h-full w-full aspect-square rounded-full text-sm object-cover"
                  />
                </span>
              </span>
              <span
                className={cn(
                  "w-full truncate text-center text-[0.7rem]",
                  hasStory ? "font-bold text-foreground" : "font-medium text-muted-foreground",
                )}
              >
                {user.display_name.split(" ")[0]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FeedPage() {
  const search = Route.useSearch();
  const [tab, setTab] = useState<(typeof tabs)[number]>("For you");

  // Fast synchronous hydration from session memory SWR cache
  const initialCache = getCachedFeedData();
  const [posts, setPosts] = useState<Post[]>(
    initialCache.foryou.length > 0 ? initialCache.foryou : [],
  );
  const [stories, setStories] = useState<Story[]>(
    initialCache.stories.length > 0 ? initialCache.stories : [],
  );
  const [loading, setLoading] = useState(initialCache.foryou.length === 0);
  const [pendingIncomingPosts, setPendingIncomingPosts] = useState<Post[]>([]);
  // Guards against out-of-order responses when the user switches tabs quickly.
  const feedReqId = useRef(0);

  // Progressive infinite scrolling for optimal DOM performance
  const [visibleCount, setVisibleCount] = useState(15);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(15);
  }, [tab]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((prev) => prev + 15);
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [posts.length, visibleCount]);

  // Auto-hide tab switcher on scroll down, reveal on slight scroll up
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const lastScrollY = useRef(0);

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      if (currentScrollY < 50) {
        setIsHeaderVisible(true);
      } else {
        const delta = currentScrollY - lastScrollY.current;
        if (delta > 3) {
          setIsHeaderVisible(false);
        } else if (delta < -3) {
          setIsHeaderVisible(true);
        }
      }
      lastScrollY.current = currentScrollY;
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-focus composer if search param contains compose
  useEffect(() => {
    if (search.compose) {
      const timer = setTimeout(() => {
        window.dispatchEvent(new CustomEvent("spaces:trigger_compose"));
      }, 150);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [search.compose]);

  // Pre-load feed assets and fresh bundles on mount
  useEffect(() => {
    triggerFeedPreload();
  }, []);

  // Story Viewer & Creator Modals
  const [viewerStoryIndex, setViewerStoryIndex] = useState<number | null>(null);
  const [isCreatorOpen, setIsCreatorOpen] = useState(false);

  async function fetchFeed(silent = false) {
    const reqId = ++feedReqId.current;
    if (!silent) setLoading(true);
    try {
      const filterKey = tab === "Following" ? "following" : tab === "Latest" ? "latest" : "foryou";
      const livePosts = await getPosts({ filter: filterKey });
      // Ignore responses from a superseded request (user switched tabs).
      if (reqId !== feedReqId.current) return;
      if (Array.isArray(livePosts)) {
        setPosts(livePosts);
        setPendingIncomingPosts([]);
      }
    } catch (err) {
      if (reqId !== feedReqId.current) return;
      console.warn("Feed fetch failed, keeping current posts:", err);
    } finally {
      if (reqId === feedReqId.current && !silent) setLoading(false);
    }
  }

  async function fetchStories() {
    try {
      const liveStories = await getStories();
      if (Array.isArray(liveStories) && liveStories.length > 0) {
        setStories(liveStories);
      }
    } catch (err) {
      console.warn("Falling back to cached stories:", err);
    }
  }

  // Reload when the signed-in user becomes known so likes/saves/follows show correctly after refresh.
  const viewerId = useCurrentUserId();
  useEffect(() => {
    fetchFeed();
    fetchStories();
  }, [tab, viewerId]);

  // Realtime hook for incoming posts and story events
  useRealtime(
    (event) => {
      const post =
        event.post || (event.type === "new_post" ? event.data || (event.id ? event : null) : null);
      if (event.type === "new_post" && post && post.id) {
        // If user is at the very top of the page, insert immediately
        if (window.scrollY < 200) {
          setPosts((prev) => {
            if (prev.some((p) => p.id === post.id)) return prev;
            return [post, ...prev];
          });
        } else {
          // Otherwise queue in floating new posts pill to avoid jarring jump
          setPendingIncomingPosts((prev) => {
            if (prev.some((p) => p.id === post.id)) return prev;
            return [post, ...prev];
          });
        }
      } else if (event.type === "post_deleted" && (event.id || event.postId)) {
        const targetId = event.id || event.postId;
        setPosts((prev) => prev.filter((p) => p.id !== targetId));
      } else if (event.type === "new_story") {
        const story = event.story || event.data || (event.id ? event : null);
        if (story && story.id) {
          setStories((prev) => [story, ...prev.filter((s) => s.id !== story.id)]);
        }
      } else if (event.type === "story_deleted" && event.storyId) {
        setStories((prev) => prev.filter((s) => s.id !== event.storyId));
      } else if (event.type === "story_like_updated" && event.storyId) {
        setStories((prev) =>
          prev.map((s) =>
            s.id === event.storyId
              ? { ...s, likedByMe: event.liked, likes_count: event.likesCount }
              : s,
          ),
        );
      }
    },
    [
      "new_post",
      "post_deleted",
      "like",
      "repost",
      "new_story",
      "story_like_updated",
      "story_deleted",
    ],
  );

  function handlePostCreated(newPost: Post) {
    setPosts((prev) => [newPost, ...prev.filter((p) => p.id !== newPost.id)]);
  }

  function handlePostDeleted(id: string) {
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }

  function handleStoryCreated(newStory: Story) {
    setStories((prev) => [newStory, ...prev.filter((s) => s.id !== newStory.id)]);
  }

  function handleStoryDeleted(storyId: string) {
    setStories((prev) => prev.filter((s) => s.id !== storyId));
  }

  function handleStoryLikeToggled(storyId: string, liked: boolean, likesCount: number) {
    setStories((prev) =>
      prev.map((s) => (s.id === storyId ? { ...s, likedByMe: liked, likes_count: likesCount } : s)),
    );
  }

  function handleShowPendingPosts() {
    if (pendingIncomingPosts.length > 0) {
      setPosts((prev) => [...pendingIncomingPosts, ...prev]);
      setPendingIncomingPosts([]);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  return (
    <AppShell title="Home" right={<DefaultRail />}>
      <div className="mx-auto max-w-2xl space-y-5 relative">
        <h1 className="sr-only">Your Spaces1 feed</h1>

        {/* Tab switcher & Tuning control - Smart Scroll Behavior */}
        <div
          className={cn(
            "sticky top-[3.6rem] lg:top-2 z-20 transition-all duration-300 ease-out my-2",
            isHeaderVisible
              ? "translate-y-0 opacity-100 pointer-events-auto"
              : "-translate-y-16 opacity-0 pointer-events-none",
          )}
        >
          <div className="flex items-center justify-between gap-1 rounded-2xl sm:rounded-full p-1 sm:p-1.5 shadow-md backdrop-blur-xl bg-card/90 border border-border/80 overflow-hidden">
            <div className="flex flex-1 gap-1 overflow-x-auto [scrollbar-width:none] touch-pan-x py-0.5">
              {tabs.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "relative flex-1 shrink-0 whitespace-nowrap rounded-full px-2.5 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-bold transition-all duration-300 min-h-[38px] sm:min-h-[42px] flex items-center justify-center cursor-pointer",
                    tab === t
                      ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1 pr-1">
              <button
                onClick={() => {
                  fetchFeed();
                  fetchStories();
                  toast.success("Feed refreshed");
                }}
                disabled={loading}
                aria-label="Refresh feed"
                className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-all cursor-pointer"
              >
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin text-brand")} />
              </button>
            </div>
          </div>
        </div>

        {/* Floating New Posts Pill */}
        {pendingIncomingPosts.length > 0 && (
          <div className="sticky top-16 z-20 flex justify-center animate-in fade-in slide-in-from-top-2 duration-200">
            <button
              onClick={handleShowPendingPosts}
              className="px-4 py-2 bg-gradient-to-r from-brand to-brand-pink text-white text-xs font-bold rounded-full shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center gap-1.5"
            >
              <ArrowUp className="w-3.5 h-3.5" />
              <span>
                {pendingIncomingPosts.length} new{" "}
                {pendingIncomingPosts.length === 1 ? "post" : "posts"}
              </span>
              <Sparkles className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Stories Bar with Add Story button */}
        <StoriesBar
          stories={stories}
          onOpenStory={(index) => setViewerStoryIndex(index)}
          onOpenCreator={() => setIsCreatorOpen(true)}
        />

        <Composer onPost={handlePostCreated} />

        {loading && posts.length === 0 ? (
          <FeedSkeleton />
        ) : posts.length === 0 ? (
          <Panel className="flex flex-col items-center gap-3 py-14 text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground" />
            <p className="font-bold">No posts in {tab} yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {tab === "Following"
                ? "Follow other creators and designers on Explore to see their latest thoughts here."
                : "Be the first to share an idea, design snippet, or poll with the community."}
            </p>
          </Panel>
        ) : (
          <div className="space-y-5">
            {posts.slice(0, visibleCount).map((p, i) => (
              <PostCard key={p.id} post={p} index={i} onDeleted={handlePostDeleted} />
            ))}
          </div>
        )}

        {visibleCount < posts.length && (
          <div
            ref={loadMoreRef}
            className="flex items-center justify-center py-6 text-sm text-muted-foreground gap-2 font-medium"
          >
            <Loader2 className="h-4 w-4 animate-spin text-brand" />
            <span>Loading more posts...</span>
          </div>
        )}

        {visibleCount >= posts.length && posts.length > 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground font-medium">
            <Sparkles className="h-4 w-4 text-brand" /> You're all caught up ({posts.length} posts)
          </div>
        )}
      </div>

      {/* Story Viewer Modal */}
      <StoryModal
        stories={stories}
        initialIndex={viewerStoryIndex ?? 0}
        isOpen={viewerStoryIndex !== null}
        onClose={() => setViewerStoryIndex(null)}
        onStoryDeleted={handleStoryDeleted}
        onStoryLikeToggled={handleStoryLikeToggled}
      />

      {/* Story Creator Modal */}
      <StoryCreatorModal
        isOpen={isCreatorOpen}
        onClose={() => setIsCreatorOpen(false)}
        onStoryCreated={handleStoryCreated}
      />
    </AppShell>
  );
}
