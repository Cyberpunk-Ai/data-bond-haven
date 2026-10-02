import { useCurrentUserId } from "@/hooks/useCurrentUserId";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect, lazy, Suspense } from "react";
import {
  CalendarDays,
  Link2,
  MapPin,
  Settings2,
  Share2,
  Grid3X3,
  Loader2,
  DollarSign,
  Sparkles,
  MessageSquare,
  Plus,
  Check,
  ArrowLeft,
  Users,
} from "lucide-react";
import { AppShell, Panel } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { PostCard } from "@/components/social/PostCard";
import { FeedSkeleton } from "@/components/social/PostSkeleton";
import { TimeAgo } from "@/components/social/TimeAgo";
import { DefaultRail } from "@/components/social/RightRail";
import { FollowButton } from "@/components/social/RightRail";
import { EditProfileModal } from "@/components/social/EditProfileModal";
import { TipModal } from "@/components/social/TipModal";
import { compact } from "@/lib/formatters";
import { currentUser as defaultUser, getProfile, fetchProfile } from "@/lib/profile-service";
import { getProfileTabPosts } from "@/lib/profile.functions";
import type { Post, Profile } from "@/lib/types";
import {
  getProfileTabPage,
  getCurrentUser,
  getUserProfile,
  getProfileNetwork,
  toggleFollowUser,
  isFollowing as isFollowingUser,
  type ProfileTabPage,
} from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import { useAuth } from "@/lib/auth-state";
import { usePlan } from "@/lib/plan-state";
import { useBranding } from "@/lib/branding-state";
import { PLAN_DETAILS } from "@/lib/plans";
import { useCreatorBalance } from "@/lib/monetization-state";
import { cn, withTimeout, PAGE_REQUEST_TIMEOUT_MS } from "@/lib/utils";
import { toast } from "sonner";

const AnalyticsDashboard = lazy(() =>
  import("@/components/social/AnalyticsDashboard").then((m) => ({ default: m.AnalyticsDashboard })),
);

export const Route = createFileRoute("/profile")({
  validateSearch: (search: Record<string, unknown>): { id?: string; user?: string } => ({
    id: search.id ? String(search.id) : undefined,
    user: search.user ? String(search.user) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Profile — Spaces1" },
      {
        name: "description",
        content:
          "Creator profile on Spaces1: posts, replies, media and live audio rooms with follower stats and custom branding.",
      },
      { property: "og:title", content: "Profile — Spaces1" },
      {
        property: "og:description",
        content: "Discover creator profiles, posts, and live audio rooms on Spaces1.",
      },
    ],
  }),
  component: ProfilePage,
});

const ownTabs = ["Posts", "Replies", "Reposts", "Media", "Likes", "Network", "Analytics"] as const;
const otherTabs = ["Posts", "Replies", "Reposts", "Media", "Network"] as const;

/** Tabs that list posts, and the query each one means. */
const POST_TABS: Record<string, ProfileTabPage> = {
  Posts: "posts",
  Reposts: "reposts",
  Media: "media",
  Likes: "likes",
};

interface ProfileReply {
  commentId: string;
  replyContent: string;
  repliedAt: string;
  /** The parent post is what makes a reply worth showing; without it there is no thread to link to. */
  post?: { id: string; content?: string; user_id?: string };
}

function ProfilePage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const targetId = search.id || search.user;

  const { currentPlan, isPlus, isPro } = usePlan();
  const { user: authUser } = useAuth();
  const { branding, activeTheme } = useBranding();
  const { pendingBalance, loading: balanceLoading } = useCreatorBalance();

  const currentLoggedInUser = authUser || defaultUser;
  const cleanTarget = targetId?.replace(/^@/, "");
  const isMe =
    !targetId ||
    targetId === currentLoggedInUser.id ||
    targetId === currentLoggedInUser.username ||
    cleanTarget === currentLoggedInUser.username ||
    cleanTarget === currentLoggedInUser.id;

  // Resolve profile
  const resolvedProfile: Profile = isMe ? currentLoggedInUser : getProfile(targetId);

  const [userProfile, setUserProfile] = useState<Profile>(resolvedProfile);
  const [tab, setTab] = useState<string>("Posts");
  const [authorId, setAuthorId] = useState<string | null>(null);
  const [tabPosts, setTabPosts] = useState<Post[]>([]);
  const [tabCursor, setTabCursor] = useState<string | null>(null);
  const [postsTotal, setPostsTotal] = useState(0);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isTipModalOpen, setIsTipModalOpen] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  // Load-first so the posts area shows the skeleton on the initial paint
  // instead of flashing "Nothing in posts yet" before the fetch resolves.
  const [loading, setLoading] = useState(true);
  const [replies, setReplies] = useState<ProfileReply[]>([]);
  const [repliesLoading, setRepliesLoading] = useState(false);
  // Each tab streams one page at a time through its own cursor, so "Load more"
  // walks older activity instead of re-fetching everything and filtering here.
  const [loadingMore, setLoadingMore] = useState(false);
  /** Bumped by realtime events to re-run the current tab's query. */
  const [tabNonce, setTabNonce] = useState(0);
  // The profile's live follower/following numbers and the network roster itself
  // are re-read on their own nonce so a new follower can appear without
  // disturbing whichever post tab is loaded or its scroll position.
  const [countsNonce, setCountsNonce] = useState(0);
  const [network, setNetwork] = useState<{ followers: Profile[]; following: Profile[] }>({
    followers: [],
    following: [],
  });
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkView, setNetworkView] = useState<"followers" | "following">("followers");

  useEffect(() => {
    setUserProfile(resolvedProfile);
    setTab("Posts");
  }, [resolvedProfile.id, targetId]);

  useEffect(() => {
    if (isMe && authUser) {
      setUserProfile(authUser);
    }
  }, [authUser, isMe]);

  // Resolved signed-in id. Used both to re-run the resolve effect the moment a
  // fresh login lands (see below) and to gate the follow-state fetch further down.
  const viewerId = useCurrentUserId();

  // Resolve who this page is about. The tab query is a separate effect: the two
  // used to be one chain, so a tab switch re-resolved the profile and the first
  // paint asked for posts before it knew whose they were.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setTabPosts([]);
    setTabCursor(null);
    setAuthorId(null);
    const profilePromise: Promise<string | null> = isMe
      ? getCurrentUser().then((res) => {
          if (res?.user) {
            setUserProfile(res.user);
            return res.user.id;
          }
          return null;
        })
      : targetId
        ? getUserProfile(targetId).then((res) => {
            if (res?.profile) {
              setUserProfile(res.profile);
              void isFollowingUser(res.profile.id)
                .then(setIsFollowing)
                .catch(() => {});
              return res.profile.id;
            }
            return null;
          })
        : Promise.resolve(null);

    profilePromise
      .then((id) => {
        if (active && id && id !== "guest") setAuthorId(id);
      })
      .catch((err) => console.warn("Failed loading profile details:", err));
    return () => {
      active = false;
    };
  }, [isMe, targetId, viewerId]);

  useEffect(() => {
    const query = POST_TABS[tab];
    if (!authorId || !query) return undefined;
    let active = true;
    setLoading(true);
    getProfileTabPage({ profileId: authorId, tab: query })
      .then((page) => {
        if (!active) return;
        setTabPosts(page.posts);
        setTabCursor(page.nextCursor);
        if (query === "posts") setPostsTotal(page.total);
      })
      .catch((err) => {
        if (!active) return;
        setTabPosts([]);
        setTabCursor(null);
        console.warn("Failed loading profile tab:", err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authorId, tab, tabNonce]);

  async function loadMoreTabPosts() {
    const query = POST_TABS[tab];
    if (!authorId || !query || !tabCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await withTimeout(
        getProfileTabPage({ profileId: authorId, tab: query, before: tabCursor }),
        PAGE_REQUEST_TIMEOUT_MS,
      );
      setTabPosts((prev) => {
        // A shifted cursor can hand back rows already on screen; appending them
        // again renders duplicate cards under the same keys.
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.posts.filter((p) => !seen.has(p.id))];
      });
      setTabCursor(page.nextCursor);
      if (query === "posts") setPostsTotal(page.total);
    } catch (err) {
      // Keep the cursor: one failed page (or a timeout) must not permanently
      // retire the "Load more" button — the next tap retries the same page.
      console.warn("Load more tab posts failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  // The "Replies" tab is its own targeted server query (comments this profile
  // made, joined to their parent post) rather than a client filter of the feed
  // page — the backend already supports it (getProfileTabPosts), the UI didn't.
  useEffect(() => {
    if (tab !== "Replies" || !authorId) return undefined;
    let active = true;
    setRepliesLoading(true);
    getProfileTabPosts({ data: { profileId: authorId, tab: "replies", limit: 30 } })
      .then(async (res) => {
        const items = (
          ((res as unknown as { replies?: ProfileReply[] })?.replies ?? []) as ProfileReply[]
        ).filter((r) => r.commentId && r.post?.id);
        const parentAuthors = Array.from(
          new Set(items.map((r) => r.post?.user_id).filter(Boolean) as string[]),
        );
        await Promise.all(parentAuthors.map((id) => fetchProfile(id).catch(() => null)));
        if (active) setReplies(items);
      })
      .catch((err) => console.warn("Failed loading replies:", err))
      .finally(() => {
        if (active) setRepliesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tab, authorId, tabNonce]);

  useEffect(() => {
    if (isMe || viewerId === "guest" || !userProfile?.id || userProfile.id === "guest") return;
    let alive = true;
    void isFollowingUser(userProfile.id)
      .then((v) => alive && setIsFollowing(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isMe, viewerId, userProfile?.id]);

  // Re-read the authoritative follower/following numbers without touching the
  // active tab or its loaded posts. The DB trigger recomputes both columns from
  // `follows` on every follow change, so a fresh profile read is always correct.
  // Runs on first resolve and again whenever `countsNonce` bumps (a follow).
  useEffect(() => {
    const id = authorId ?? userProfile?.id;
    if (!id || id === "guest") return;
    let alive = true;
    const refresh = isMe
      ? getCurrentUser().then((r) => r.user)
      : getUserProfile(id).then((r) => r.profile);
    refresh
      .then((p) => {
        if (!alive || !p) return;
        setUserProfile((prev) => ({ ...prev, followers: p.followers, following: p.following }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [countsNonce, authorId, isMe, userProfile?.id]);

  // The Network tab lists actual people, so hydrate it lazily only when opened,
  // and re-hydrate whenever a follow event changes the roster.
  useEffect(() => {
    const id = authorId ?? userProfile?.id;
    if (tab !== "Network" || !id || id === "guest") return;
    let alive = true;
    setNetworkLoading(true);
    getProfileNetwork(id)
      .then((res) => {
        if (alive) setNetwork(res);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setNetworkLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tab, countsNonce, authorId, userProfile?.id]);

  useRealtime(
    (event) => {
      if (event.type === "user_profile_updated" && event.id === userProfile.id) {
        setUserProfile((prev) => ({ ...prev, ...event }));
      } else if (event.type === "new_post" && event.post) {
        // Only react to this profile's own posts; everyone else's would pollute
        // the list and the counts. Re-running the tab query rather than
        // prepending is deliberate: whether the new post belongs in Media (or in
        // Reposts/Likes at all) is the server's answer, not the client's.
        if (event.post.user_id === userProfile.id) setTabNonce((n) => n + 1);
      } else if (event.type === "post_deleted" && event.postId) {
        setTabPosts((prev) => prev.filter((p) => p.id !== event.postId));
        setReplies((prev) => prev.filter((r) => r.post?.id !== event.postId));
      } else if (event.type === "follow_updated") {
        // A follow touched the profile we're viewing. Stamp the authoritative
        // follower number the moment it arrives, then re-read the roster so a new
        // follower shows up in the Network tab without a reload.
        if (event.targetUserId === userProfile.id && typeof event.followers === "number") {
          const nextFollowers = event.followers as number;
          setUserProfile((prev) => ({ ...prev, followers: nextFollowers }));
        }
        if (event.targetUserId === userProfile.id || event.followerId === userProfile.id) {
          setCountsNonce((n) => n + 1);
        }
      } else if (event.type === "notification" && event.notification?.type === "follow") {
        // A new follower landed in the signed-in user's audience; refresh their
        // own network so the joiner is immediately visible.
        if (isMe) setCountsNonce((n) => n + 1);
      }
    },
    ["user_profile_updated", "new_post", "post_deleted", "follow_updated", "notification"],
  );

  async function handleToggleFollow() {
    const next = !isFollowing;
    const prevFollowing = isFollowing;
    const prevFollowers = userProfile.followers;
    setIsFollowing(next);
    setUserProfile((p) => ({
      ...p,
      followers: next ? p.followers + 1 : Math.max(0, p.followers - 1),
    }));
    setFollowLoading(true);
    try {
      await toggleFollowUser(userProfile.id);
      // Reflect the change in the Network roster too (the followed profile now
      // has me as a follower; my own following list gained an entry).
      setCountsNonce((n) => n + 1);
      toast.success(
        next ? `Following @${userProfile.username}` : `Unfollowed @${userProfile.username}`,
      );
    } catch (err) {
      // Roll back the optimistic update so the UI matches the server.
      setIsFollowing(prevFollowing);
      setUserProfile((p) => ({ ...p, followers: prevFollowers }));
      toast.error(
        err instanceof Error ? err.message : "Could not update follow. Please try again.",
      );
    } finally {
      setFollowLoading(false);
    }
  }

  function handleShareProfile() {
    const profileUrl = `${window.location.origin}/u/${userProfile.username}`;
    if (navigator.share) {
      navigator
        .share({
          title: `${userProfile.display_name} on Spaces1`,
          text: userProfile.bio,
          url: profileUrl,
        })
        .catch(() => {});
    } else {
      navigator.clipboard
        .writeText(profileUrl)
        .then(() => toast.success("Profile link copied to clipboard!"))
        .catch(() => toast.error("Could not copy link."));
    }
  }

  const tabs = isMe ? ownTabs : otherTabs;

  // The tab's rows come straight from the query that defines it. What used to
  // live here was four client-side filters over one list of this author's
  // posts, which could never find the posts *they* reposted or liked.
  const list = tabPosts;

  return (
    <AppShell title={userProfile.display_name} right={<DefaultRail />}>
      <div className="mx-auto max-w-2xl space-y-5">
        {/* Back button if viewing another profile */}
        {!isMe && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate({ to: "/feed" })}
              className="flex items-center gap-1.5 rounded-full bg-foreground/5 hover:bg-foreground/10 px-3.5 py-1.5 text-xs font-bold text-foreground transition-all active:scale-95"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Feed
            </button>
          </div>
        )}

        {/* cover */}
        <div
          className={cn(
            "glass-panel overflow-hidden rounded-3xl shadow-soft transition-all duration-300",
            isMe && isPlus && branding.showAuraOnPosts && activeTheme.borderClass,
            isMe && isPlus && branding.showAuraOnPosts && activeTheme.glowClass,
          )}
        >
          <div
            className={cn(
              "relative h-40 bg-gradient-to-br transition-all duration-500 sm:h-52",
              isMe && isPlus ? activeTheme.gradient : "from-brand via-brand-pink to-brand-orange",
            )}
          >
            <div className="absolute inset-0 opacity-30 [background:radial-gradient(circle_at_20%_30%,white,transparent_55%)]" />
          </div>
          <div className="px-4 sm:px-5 pb-5">
            <div className="-mt-12 sm:-mt-14 flex flex-wrap sm:flex-nowrap items-end justify-between gap-3">
              <Avatar
                name={userProfile.display_name}
                src={userProfile.avatar_url}
                className="h-20 w-20 sm:h-24 sm:w-24 text-xl sm:text-2xl ring-4 ring-card shadow-lg shrink-0"
              />
              <div className="flex items-center gap-2 flex-wrap justify-end ml-auto">
                {/* Tip Button */}
                {isMe ? (
                  <button
                    onClick={() => setIsTipModalOpen(true)}
                    aria-label="Monetization and Tips"
                    className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-bold text-amber-600 dark:text-amber-400 transition-all duration-300 hover:bg-amber-500/20 active:scale-95 cursor-pointer min-h-[38px] flex items-center gap-1.5 shadow-xs"
                    title="View Tips & Earnings"
                  >
                    <DollarSign className="h-4 w-4 stroke-[2.5]" />
                    <span>
                      Balance ({balanceLoading ? "..." : `$${pendingBalance.toFixed(2)}`})
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={() => setIsTipModalOpen(true)}
                    aria-label="Tip Creator"
                    className="rounded-full border border-amber-500/40 bg-amber-500/15 px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-bold text-amber-600 dark:text-amber-400 transition-all duration-300 hover:bg-amber-500/25 active:scale-95 cursor-pointer min-h-[38px] flex items-center gap-1.5 shadow-xs"
                    title="Send Creator Tip"
                  >
                    <DollarSign className="h-4 w-4 stroke-[2.5]" />
                    <span>Tip Creator</span>
                  </button>
                )}

                {/* Share Button */}
                <button
                  onClick={handleShareProfile}
                  aria-label="Share Profile"
                  className="rounded-full border border-border p-2 sm:p-2.5 transition-all duration-300 hover:bg-foreground/5 active:scale-95 cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center"
                  title="Share Profile"
                >
                  <Share2 className="h-4 w-4" />
                </button>

                {isMe ? (
                  <>
                    <button
                      onClick={() => setIsEditModalOpen(true)}
                      aria-label="Edit Profile Settings"
                      className="rounded-full border border-border p-2 sm:p-2.5 transition-all duration-300 hover:bg-foreground/5 active:scale-95 cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center"
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setIsEditModalOpen(true)}
                      className="rounded-full px-4 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft hover:shadow-glow transition-all duration-300 active:scale-95 cursor-pointer min-h-[38px] flex items-center"
                    >
                      Edit profile
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() =>
                        navigate({ to: "/messages", search: { user: userProfile.id } })
                      }
                      className="rounded-full border border-border px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-bold text-foreground hover:bg-foreground/5 transition-all active:scale-95 flex items-center gap-1.5 min-h-[38px] cursor-pointer"
                    >
                      <MessageSquare className="h-4 w-4 text-brand" /> Message
                    </button>
                    <button
                      onClick={handleToggleFollow}
                      disabled={followLoading}
                      className={cn(
                        "rounded-full px-4 sm:px-5 py-2 text-xs sm:text-sm font-bold transition-all duration-300 active:scale-95 flex items-center gap-1.5 cursor-pointer shadow-soft min-h-[38px]",
                        isFollowing
                          ? "bg-foreground/10 text-foreground hover:bg-foreground/15"
                          : "bg-gradient-to-r from-brand to-brand-pink text-white hover:shadow-glow",
                      )}
                    >
                      {isFollowing ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                      {isFollowing ? "Following" : "Follow"}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4">
              <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight flex-wrap">
                <span>{userProfile.display_name}</span>
                <UserBadge
                  isMe={isMe}
                  plan={userProfile.plan}
                  verified={userProfile.verified}
                  size="md"
                />
              </h1>
              <p className="text-sm text-muted-foreground">@{userProfile.username}</p>

              {isMe && isPlus && branding.tagline && (
                <p className="mt-1 text-xs font-semibold text-brand">✨ {branding.tagline}</p>
              )}

              <p className="mt-3 text-[0.95rem] leading-relaxed">{userProfile.bio}</p>

              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
                {userProfile.location && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="h-4 w-4" /> {userProfile.location}
                  </span>
                )}
                {userProfile.website && (
                  <a
                    href={
                      userProfile.website.startsWith("http")
                        ? userProfile.website
                        : `https://${userProfile.website}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-brand hover:underline"
                  >
                    <Link2 className="h-4 w-4" /> {userProfile.website}
                  </a>
                )}
                <span className="flex items-center gap-1.5">
                  <CalendarDays className="h-4 w-4" /> Joined Spaces Community
                </span>
              </div>

              <div className="mt-4 flex gap-6 text-sm">
                <button
                  type="button"
                  onClick={() => {
                    setNetworkView("following");
                    setTab("Network");
                  }}
                  className="cursor-pointer hover:opacity-80 transition-opacity"
                >
                  <strong className="font-extrabold">{compact(userProfile.following || 0)}</strong>{" "}
                  <span className="text-muted-foreground">Following</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNetworkView("followers");
                    setTab("Network");
                  }}
                  className="cursor-pointer hover:opacity-80 transition-opacity"
                >
                  <strong className="font-extrabold">{compact(userProfile.followers || 0)}</strong>{" "}
                  <span className="text-muted-foreground">Followers</span>
                </button>
                <span>
                  <strong className="font-extrabold">{compact(postsTotal)}</strong>{" "}
                  <span className="text-muted-foreground">Posts</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* followed by */}
        {userProfile.followers > 0 && (
          <button
            type="button"
            onClick={() => {
              setNetworkView("followers");
              setTab("Network");
            }}
            className="w-full cursor-pointer text-left"
          >
            <Panel className="flex items-center gap-3 transition-colors hover:border-brand/40">
              <Users className="h-4 w-4 shrink-0 text-brand" />
              <p className="text-sm text-muted-foreground">
                Followed by{" "}
                <strong className="font-semibold text-foreground">
                  {compact(userProfile.followers)}
                </strong>{" "}
                creators on Spaces1
              </p>
            </Panel>
          </button>
        )}

        {/* tabs */}
        <div className="glass-panel sticky top-2 z-30 flex items-center gap-1 rounded-full p-1 sm:p-1.5 shadow-soft lg:top-4 overflow-x-auto [scrollbar-width:none] touch-pan-x">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 shrink-0 whitespace-nowrap rounded-full px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-bold transition-all duration-300 cursor-pointer min-h-[36px] sm:min-h-[40px] flex items-center justify-center",
                tab === t
                  ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="space-y-5">
          {tab === "Network" ? (
            <div className="space-y-4">
              <div className="glass-panel flex items-center gap-1 rounded-full p-1">
                {(["followers", "following"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setNetworkView(v)}
                    className={cn(
                      "flex-1 rounded-full px-3 py-2 text-xs sm:text-sm font-bold capitalize transition-all duration-300 cursor-pointer min-h-[38px]",
                      networkView === v
                        ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {v} ·{" "}
                    {compact(
                      v === "followers" ? userProfile.followers || 0 : userProfile.following || 0,
                    )}
                  </button>
                ))}
              </div>

              {networkLoading && network[networkView].length === 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {[1, 2, 3, 4].map((n) => (
                    <div key={n} className="glass-panel animate-pulse rounded-2xl p-3.5 h-[68px]" />
                  ))}
                </div>
              ) : network[networkView].length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {network[networkView].map((p) => (
                    <div
                      key={p.id}
                      className="glass-panel flex items-center gap-3 rounded-2xl p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lift"
                    >
                      <Link
                        to="/profile"
                        search={{ id: p.id, user: p.username }}
                        className="shrink-0 transition-transform hover:scale-105 active:scale-95"
                      >
                        <Avatar
                          name={p.display_name}
                          src={p.avatar_url}
                          className="h-11 w-11 text-sm"
                        />
                      </Link>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <Link
                            to="/profile"
                            search={{ id: p.id, user: p.username }}
                            className="truncate text-sm font-bold text-foreground hover:text-brand transition-colors"
                          >
                            {p.display_name}
                          </Link>
                          <UserBadge plan={p.plan} verified={p.verified} size="xs" />
                        </div>
                        <Link
                          to="/profile"
                          search={{ id: p.id, user: p.username }}
                          className="block truncate text-xs text-muted-foreground hover:text-brand transition-colors"
                        >
                          @{p.username}
                        </Link>
                      </div>
                      {p.id !== viewerId && <FollowButton targetUserId={p.id} />}
                    </div>
                  ))}
                </div>
              ) : (
                <Panel className="py-12 text-center">
                  <Users className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-60" />
                  <p className="font-bold">
                    No {networkView === "followers" ? "followers" : "following"} yet
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                    {networkView === "followers"
                      ? isMe
                        ? "People who follow you appear here the moment they do."
                        : `@${userProfile.username} has no followers yet.`
                      : isMe
                        ? "Accounts you follow will show up here."
                        : `@${userProfile.username} isn't following anyone yet.`}
                  </p>
                </Panel>
              )}
            </div>
          ) : loading ? (
            <FeedSkeleton />
          ) : tab === "Analytics" && isMe ? (
            <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-muted/40" />}>
              <AnalyticsDashboard />
            </Suspense>
          ) : tab === "Replies" ? (
            <>
              {repliesLoading && replies.length === 0 && <FeedSkeleton />}
              {!repliesLoading &&
                replies.map((r) => {
                  const parent = r.post;
                  if (!parent) return null;
                  const parentAuthor = getProfile(parent.user_id ?? "");
                  return (
                    <Panel key={r.commentId} className="space-y-2.5 p-4 sm:p-5">
                      <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed [overflow-wrap:anywhere]">
                        {r.replyContent}
                      </p>
                      <Link
                        to="/post/$id"
                        params={{ id: parent.id }}
                        className="block rounded-2xl border border-border/60 bg-foreground/[0.03] p-3 transition-colors hover:border-brand/40"
                      >
                        <p className="text-[11px] font-bold text-muted-foreground">
                          in reply to {parentAuthor.display_name}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {parent.content}
                        </p>
                      </Link>
                      <div className="flex items-center justify-between">
                        <TimeAgo iso={r.repliedAt} className="text-[11px] text-muted-foreground" />
                        <Link
                          to="/post/$id"
                          params={{ id: parent.id }}
                          className="text-[11px] font-bold text-brand hover:underline"
                        >
                          View post
                        </Link>
                      </div>
                    </Panel>
                  );
                })}
              {!repliesLoading && replies.length === 0 && (
                <Panel className="flex flex-col items-center gap-3 py-14 text-center">
                  <MessageSquare className="h-8 w-8 text-muted-foreground" />
                  <p className="font-bold">No replies yet</p>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    {isMe
                      ? "Comments you post on other people's threads will show up here."
                      : `@${userProfile.username} hasn't replied to anyone yet.`}
                  </p>
                </Panel>
              )}
            </>
          ) : (
            <>
              {list.map((p, i) => (
                <PostCard
                  key={`${tab}-${p.id}`}
                  post={p}
                  index={i}
                  onDeleted={(id) => setTabPosts((prev) => prev.filter((x) => x.id !== id))}
                />
              ))}
              {list.length === 0 && (
                <Panel className="flex flex-col items-center gap-3 py-14 text-center">
                  <Grid3X3 className="h-8 w-8 text-muted-foreground" />
                  <p className="font-bold">Nothing in {tab.toLowerCase()} yet</p>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    {isMe
                      ? "Share your thoughts or upload media to see it here."
                      : `@${userProfile.username} hasn't published anything in this section yet.`}
                  </p>
                </Panel>
              )}
              {POST_TABS[tab] && tabCursor && (
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadMoreTabPosts()}
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/5 px-6 py-2.5 text-xs font-bold text-brand transition-all active:scale-95 cursor-pointer disabled:opacity-60"
                  >
                    <Loader2 className={cn("h-3.5 w-3.5", loadingMore && "animate-spin")} />
                    Load more {tab.toLowerCase()}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Edit Profile Modal */}
      <EditProfileModal
        isOpen={isEditModalOpen}
        initialProfile={userProfile}
        onClose={() => setIsEditModalOpen(false)}
        onProfileUpdated={(updated) => setUserProfile((prev) => ({ ...prev, ...updated }))}
      />

      {/* Tip Modal */}
      <TipModal
        isOpen={isTipModalOpen}
        onClose={() => setIsTipModalOpen(false)}
        recipient={{
          username: userProfile.username,
          display_name: userProfile.display_name,
          avatar_url: userProfile.avatar_url,
          plan: userProfile.plan,
        }}
      />
    </AppShell>
  );
}
