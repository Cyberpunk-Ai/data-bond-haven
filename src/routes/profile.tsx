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
} from "lucide-react";
import { AppShell, Panel } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { PostCard } from "@/components/social/PostCard";
import { FeedSkeleton } from "@/components/social/PostSkeleton";
import { DefaultRail } from "@/components/social/RightRail";
import { EditProfileModal } from "@/components/social/EditProfileModal";
import { TipModal } from "@/components/social/TipModal";
import { compact } from "@/lib/formatters";
import { currentUser as defaultUser, getProfile } from "@/lib/profile-service";
import type { Post, Profile } from "@/lib/types";
import {
  getPosts,
  getCurrentUser,
  getUserProfile,
  toggleFollowUser,
  isFollowing as isFollowingUser,
} from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import { useAuth } from "@/lib/auth-state";
import { usePlan } from "@/lib/plan-state";
import { useBranding } from "@/lib/branding-state";
import { PLAN_DETAILS } from "@/lib/plans";
import { useCreatorBalance } from "@/lib/monetization-state";
import { cn } from "@/lib/utils";
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

const ownTabs = ["Posts", "Reposts", "Media", "Likes", "Analytics"] as const;
const otherTabs = ["Posts", "Reposts", "Media"] as const;

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
  const [allPosts, setAllPosts] = useState<Post[]>([]);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isTipModalOpen, setIsTipModalOpen] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setUserProfile(resolvedProfile);
    setTab("Posts");
  }, [resolvedProfile.id, targetId]);

  useEffect(() => {
    if (isMe && authUser) {
      setUserProfile(authUser);
    }
  }, [authUser, isMe]);

  useEffect(() => {
    setLoading(true);
    // Resolve the profile first, then fetch only that author's posts instead of
    // pulling the whole feed and filtering client-side.
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
      .then((authorId) => (authorId ? getPosts({ userId: authorId }) : []))
      .then((data) => {
        if (Array.isArray(data)) setAllPosts(data);
      })
      .catch((err) => console.warn("Failed loading profile details:", err))
      .finally(() => setLoading(false));
  }, [isMe, targetId]);

  const viewerId = useCurrentUserId();
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

  useRealtime(
    (event) => {
      if (event.type === "user_profile_updated" && event.id === userProfile.id) {
        setUserProfile((prev) => ({ ...prev, ...event }));
      } else if (event.type === "new_post" && event.post) {
        // Only surface new posts by this profile's author; otherwise the list and
        // counts get polluted by everyone's posts while viewing a profile.
        if (event.post.user_id === userProfile.id) {
          setAllPosts((prev) => [event.post, ...prev]);
        }
      } else if (event.type === "post_deleted" && event.postId) {
        setAllPosts((prev) => prev.filter((p) => p.id !== event.postId));
      }
    },
    ["user_profile_updated", "new_post", "post_deleted"],
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

  const authorPosts = allPosts.filter((p) => p.user_id === userProfile.id);
  const reposts = allPosts.filter(
    (p) =>
      p.repostedByMe ||
      (p as any).reposted_by === userProfile.id ||
      (p as any).repost_user_id === userProfile.id,
  );
  const media = allPosts.filter(
    (p) => (p.image_gradient || p.image_url || p.media_url) && p.user_id === userProfile.id,
  );
  const liked = allPosts.filter((p) => p.likedByMe);
  const list =
    tab === "Posts"
      ? authorPosts
      : tab === "Reposts"
        ? reposts
        : tab === "Media"
          ? media
          : tab === "Likes" && isMe
            ? liked
            : authorPosts;

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
                <span>
                  <strong className="font-extrabold">{compact(userProfile.following || 0)}</strong>{" "}
                  <span className="text-muted-foreground">Following</span>
                </span>
                <span>
                  <strong className="font-extrabold">{compact(userProfile.followers || 0)}</strong>{" "}
                  <span className="text-muted-foreground">Followers</span>
                </span>
                <span>
                  <strong className="font-extrabold">{authorPosts.length}</strong>{" "}
                  <span className="text-muted-foreground">Posts</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* followed by */}
        {userProfile.followers > 0 && (
          <Panel className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Followed by{" "}
              <strong className="font-semibold text-foreground">
                {compact(userProfile.followers)}
              </strong>{" "}
              creators on Spaces1
            </p>
          </Panel>
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
          {loading ? (
            <FeedSkeleton />
          ) : tab === "Analytics" && isMe ? (
            <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-muted/40" />}>
              <AnalyticsDashboard />
            </Suspense>
          ) : (
            <>
              {list.map((p, i) => (
                <PostCard
                  key={`${tab}-${p.id}`}
                  post={p}
                  index={i}
                  onDeleted={(id) => setAllPosts((prev) => prev.filter((x) => x.id !== id))}
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
