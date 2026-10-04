import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarDays,
  Users2,
  Grid3X3,
  DollarSign,
  Wallet,
  Share2,
  Settings2,
  Check,
  Repeat2,
} from "lucide-react";

import { AppShell, Panel } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { TeamAvatar } from "@/components/social/TeamAvatar";
import { PostCard } from "@/components/social/PostCard";
import { FeedSkeleton } from "@/components/social/PostSkeleton";
import { DefaultRail } from "@/components/social/RightRail";
import { TipModal } from "@/components/social/TipModal";
import { WorkspaceBadge } from "@/components/social/WorkspaceBadge";
import { WorkspaceMonetization } from "@/components/social/WorkspaceMonetization";
import { EditWorkspaceModal, type EditableWorkspace } from "@/components/social/EditWorkspaceModal";
import { getWorkspaceProfile, type WorkspaceProfile } from "@/lib/workspace.functions";
import { NOINDEX_META, ORG_NAME, brandedTitle } from "@/lib/seo";
import { pagePreviewMeta, previewCardFor } from "@/lib/og-meta";
import { useWorkspace } from "@/lib/workspace-state";
import { getPosts, getWorkspaceReposts } from "@/lib/api-client";
import { getWorkspaceEarnings } from "@/lib/payouts.functions";
import { useServerFn } from "@tanstack/react-start";
import { useRealtime } from "@/lib/realtime";
import { compact } from "@/lib/formatters";
import { toast } from "sonner";
import type { Post } from "@/lib/types";
import { cn } from "@/lib/utils";

// Pulled in only when a manager opens the Team tab — the roster/invite/seat
// desk is heavy and irrelevant to visitors reading the team's posts.
const TeamWorkspaceManager = lazy(() =>
  import("@/components/social/TeamWorkspaceManager").then((m) => ({
    default: m.TeamWorkspaceManager,
  })),
);

// Team analytics reuse the creator dashboard pointed at the team's posts; only
// the owner opens this tab, so it never weighs down the public page load.
const AnalyticsDashboard = lazy(() =>
  import("@/components/social/AnalyticsDashboard").then((m) => ({
    default: m.AnalyticsDashboard,
  })),
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/workspace/$id")({
  loader: ({ params }) =>
    // A bad id is a 404-style empty state, not a thrown loader error.
    UUID_RE.test(params.id)
      ? getWorkspaceProfile({ data: { id: params.id } }).catch(() => null)
      : Promise.resolve(null),
  head: ({ loaderData }) => {
    const ws = loaderData as WorkspaceProfile | null;
    if (!ws)
      return {
        meta: [{ title: brandedTitle("Team unavailable") }, ...NOINDEX_META],
      };
    const title = `${ws.name} — Team on ${ORG_NAME}`;
    const description = ws.bio || `${ws.name} on ${ORG_NAME}`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { name: "twitter:card", content: previewCardFor(ws.avatarUrl) },
        // The team's logo, the same way a personal profile previews its avatar:
        // an invite link should look like the team it opens.
        ...pagePreviewMeta(ws.avatarUrl, `${ws.name} team logo`),
        // Teams are addressed by an opaque uuid and reached by an invite, not by
        // search. Preview meta stays (a shared team link should unfurl) but the
        // page itself never belongs in an index or a sitemap.
        ...NOINDEX_META,
      ],
    };
  },
  component: WorkspaceProfilePage,
});

type WsTab = "Posts" | "Reposts" | "Media" | "Earnings" | "Analytics" | "Team";

function WorkspaceProfilePage() {
  const loaderWs = Route.useLoaderData() as WorkspaceProfile | null;
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { workspaces, setActiveWsId, updateWorkspaceFor } = useWorkspace();
  const loadEarnings = useServerFn(getWorkspaceEarnings);

  // Local copy of the public identity so an owner/admin edit refreshes the
  // header immediately (the loader itself only runs on navigation).
  const [ws, setWs] = useState(loaderWs);
  useEffect(() => setWs(loaderWs), [loaderWs]);

  const [posts, setPosts] = useState<Post[]>([]);
  const [reposts, setReposts] = useState<Post[]>([]);
  const [repostsLoading, setRepostsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<WsTab>("Posts");
  const [isTipOpen, setIsTipOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [hasOpenPayout, setHasOpenPayout] = useState(false);

  // The viewer's role for *this* workspace (not necessarily the active one).
  // Only the Owner may see or move the team's money, so the Earnings tab is
  // owner-gated here and enforced again server-side by getWorkspaceEarnings /
  // requestPayout. Owner/Admin additionally get the embedded Team desk.
  const entry = workspaces.find((w) => w.id === id);
  const isOwner = entry?.myRole === "Owner";
  const isManager = isOwner || entry?.myRole === "Admin";

  useEffect(() => {
    if (!ws) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    // Team posts are publicly readable; hydrateWorkspaces gives each card the
    // brand identity, so the author never leaks through.
    getPosts({ workspaceId: id, limit: 50 })
      .then((data) => active && setPosts(Array.isArray(data) ? data : []))
      .catch((err) => console.warn("Failed loading team posts:", err))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id, ws?.id]);

  // Mirror the personal profile's "Balance" affordance: the owner sees whether
  // a withdrawal is already in flight (the button then reads like the personal
  // dashboard's). Errors are ignored — the hub behind the tab re-fetches.
  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    loadEarnings({ data: { workspaceId: id } })
      .then((res) => alive && setHasOpenPayout(!!res.openPayout))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isOwner, id, loadEarnings]);

  useRealtime(
    (event) => {
      if (event.type === "new_post" && event.post && (event.post as Post).workspace_id === id) {
        setPosts((prev) =>
          prev.some((p) => p.id === event.post.id) ? prev : [event.post as Post, ...prev],
        );
      } else if (event.type === "post_deleted" && event.postId) {
        setPosts((prev) => prev.filter((p) => p.id !== event.postId));
      }
    },
    ["new_post", "post_deleted"],
  );

  // Reposts are fetched lazily the first time the tab is opened — visitors
  // reading the team's posts never pay for the extra joins.
  useEffect(() => {
    if (tab !== "Reposts" || reposts.length > 0 || repostsLoading) return;
    let active = true;
    setRepostsLoading(true);
    getWorkspaceReposts(id)
      .then((data) => active && setReposts(Array.isArray(data) ? data : []))
      .catch((err) => console.warn("Failed loading team reposts:", err))
      .finally(() => active && setRepostsLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  const media = useMemo(
    () => posts.filter((p) => Boolean(p.image_gradient || p.image_url || p.media_url)),
    [posts],
  );

  const memberCount = entry
    ? entry.members.filter((m) => m.status === "active").length
    : ws?.memberCount || 0;

  if (!ws) {
    return (
      <AppShell title="Team" right={<DefaultRail />}>
        <div className="mx-auto w-full max-w-2xl space-y-5">
          <Link
            to="/feed"
            className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Back to feed
          </Link>
          <Panel className="flex flex-col items-center gap-3 py-14 text-center">
            <Users2 className="h-8 w-8 text-muted-foreground" />
            <p className="text-lg font-bold">This team isn't available</p>
            <p className="text-sm text-muted-foreground">It may have been deleted or renamed.</p>
          </Panel>
        </div>
      </AppShell>
    );
  }

  const joined = ws.createdAt ? new Date(ws.createdAt).toLocaleDateString() : "";
  // Teams are keyed by uuid. Posts/Reposts/Media mirror the personal profile;
  // Earnings and Analytics are owner-only (enforced again server-side), and
  // Team is the manager-only roster desk.
  const tabs = [
    "Posts",
    "Reposts",
    "Media",
    ...(isOwner ? (["Earnings", "Analytics"] as const) : []),
    ...(entry ? (["Team"] as const) : []),
  ] as WsTab[];

  function handleShareProfile() {
    const url = `${window.location.origin}/workspace/${id}`;
    if (navigator.share) {
      navigator.share({ title: `${ws!.name} on ${ORG_NAME}`, text: ws!.bio, url }).catch(() => {});
    } else {
      navigator.clipboard
        .writeText(url)
        .then(() => toast.success("Team link copied to clipboard!"))
        .catch(() => toast.error("Could not copy link."));
    }
  }

  async function handleSave(patch: {
    name: string;
    bio: string;
    logoEmoji: string;
    avatarUrl: string | null;
  }) {
    await updateWorkspaceFor(id, patch);
    setWs((prev) =>
      prev
        ? {
            ...prev,
            name: patch.name,
            bio: patch.bio,
            logoEmoji: patch.logoEmoji,
            avatarUrl: patch.avatarUrl,
          }
        : prev,
    );
  }

  const list = tab === "Media" ? media : posts;

  return (
    <AppShell title={ws.name} right={<DefaultRail />}>
      <div className="mx-auto w-full max-w-2xl space-y-5">
        {/* Back button — like the personal profile when viewing someone else */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate({ to: "/feed" })}
            className="flex items-center gap-1.5 rounded-full bg-foreground/5 hover:bg-foreground/10 px-3.5 py-1.5 text-xs font-bold text-foreground transition-all active:scale-95 cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Feed
          </button>
        </div>

        {/* cover + identity — same shell as the personal profile header */}
        <div className="glass-panel overflow-hidden rounded-3xl shadow-soft">
          <div className="relative h-40 bg-gradient-to-br from-brand via-brand-pink to-brand-orange sm:h-52">
            <div className="absolute inset-0 opacity-30 [background:radial-gradient(circle_at_20%_30%,white,transparent_55%)]" />
          </div>
          <div className="px-4 sm:px-5 pb-5">
            <div className="-mt-12 sm:-mt-14 flex flex-wrap sm:flex-nowrap items-end justify-between gap-3">
              <TeamAvatar
                name={ws.name}
                emoji={ws.logoEmoji}
                avatarUrl={ws.avatarUrl}
                size="lg"
                halo
              />
              <div className="flex items-center gap-2 flex-wrap justify-end ml-auto">
                {/* Balance (owner) / Tip team (everyone else) — mirrors the
                    personal profile's Balance-vs-Tip-Creator slot */}
                {isOwner ? (
                  <button
                    onClick={() => setTab("Earnings")}
                    aria-label="Team Earnings and Payouts"
                    title="View Team Tips & Earnings"
                    className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-bold text-amber-600 dark:text-amber-400 transition-all duration-300 hover:bg-amber-500/20 active:scale-95 cursor-pointer min-h-[38px] flex items-center gap-1.5 shadow-xs"
                  >
                    {hasOpenPayout ? (
                      <Wallet className="h-4 w-4" />
                    ) : (
                      <DollarSign className="h-4 w-4 stroke-[2.5]" />
                    )}
                    <span>{hasOpenPayout ? "Withdrawal in progress" : "Team balance"}</span>
                  </button>
                ) : (
                  <button
                    onClick={() => setIsTipOpen(true)}
                    aria-label="Tip team"
                    title="Send Team Tip"
                    className="rounded-full border border-amber-500/40 bg-amber-500/15 px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-bold text-amber-600 dark:text-amber-400 transition-all duration-300 hover:bg-amber-500/25 active:scale-95 cursor-pointer min-h-[38px] flex items-center gap-1.5 shadow-xs"
                  >
                    <DollarSign className="h-4 w-4 stroke-[2.5]" />
                    <span>Tip team</span>
                  </button>
                )}

                {/* Share */}
                <button
                  onClick={handleShareProfile}
                  aria-label="Share Team Profile"
                  title="Share Profile"
                  className="rounded-full border border-border p-2 sm:p-2.5 transition-all duration-300 hover:bg-foreground/5 active:scale-95 cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center"
                >
                  <Share2 className="h-4 w-4" />
                </button>

                {/* Team desk (any member) / settings shortcut (managers) */}
                {entry && (
                  <button
                    onClick={() => setTab("Team")}
                    aria-label="Team Members & Roles"
                    title={isManager ? "Manage team, members and roles" : "View team members"}
                    className={cn(
                      "rounded-full border p-2 sm:p-2.5 transition-all duration-300 active:scale-95 cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center",
                      tab === "Team"
                        ? "border-brand/40 bg-brand/10 text-brand"
                        : "border-border hover:bg-foreground/5",
                    )}
                  >
                    <Users2 className="h-4 w-4" />
                  </button>
                )}

                {/* Edit team profile (Owner/Admin) */}
                {isManager && (
                  <>
                    <button
                      onClick={() => setIsEditOpen(true)}
                      aria-label="Edit Team Settings"
                      title="Edit team profile"
                      className="rounded-full border border-border p-2 sm:p-2.5 transition-all duration-300 hover:bg-foreground/5 active:scale-95 cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center"
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setIsEditOpen(true)}
                      className="rounded-full px-4 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft hover:shadow-glow transition-all duration-300 active:scale-95 cursor-pointer min-h-[38px] flex items-center"
                    >
                      Edit team
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4">
              <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight flex-wrap">
                <span>{ws.name}</span>
                <WorkspaceBadge size="md" />
              </h1>
              <p className="text-sm text-muted-foreground">@{ws.slug}</p>

              {ws.bio && <p className="mt-3 text-[0.95rem] leading-relaxed">{ws.bio}</p>}

              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Users2 className="h-4 w-4" /> Team workspace
                </span>
                {joined && (
                  <span className="flex items-center gap-1.5">
                    <CalendarDays className="h-4 w-4" /> Joined {joined}
                  </span>
                )}
              </div>

              <div className="mt-4 flex gap-6 text-sm">
                <span>
                  <strong className="font-extrabold">{compact(ws.postCount)}</strong>{" "}
                  <span className="text-muted-foreground">Posts</span>
                </span>
                <span>
                  <strong className="font-extrabold">{compact(memberCount)}</strong>{" "}
                  <span className="text-muted-foreground">Members</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* members strip (viewer is on the team) — stands in for the personal
            profile's "Followed by" panel */}
        {entry && entry.members.length > 0 && (
          <Panel className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {entry.members.slice(0, 5).map((m) => (
                <Avatar
                  key={m.id}
                  name={m.name}
                  src={m.avatar_url}
                  className="h-7 w-7 text-[0.6rem] ring-2 ring-card"
                />
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              A team of{" "}
              <strong className="font-semibold text-foreground">{compact(memberCount)}</strong> on{" "}
              {ORG_NAME}
              {isOwner && (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.65rem] font-extrabold text-amber-600 dark:text-amber-400">
                  <Check className="h-3 w-3" /> You own this team
                </span>
              )}
            </p>
          </Panel>
        )}

        {/* tabs — same pill bar as the personal profile */}
        <div className="glass-panel sticky top-2 z-30 flex items-center gap-1 rounded-full p-1 sm:p-1.5 shadow-soft lg:top-4 overflow-x-auto [scrollbar-width:none] touch-pan-x">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 shrink-0 whitespace-nowrap rounded-full px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-bold transition-all duration-300 cursor-pointer min-h-[36px] sm:min-h-[40px] flex items-center justify-center gap-1.5",
                tab === t
                  ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "Earnings" && <Wallet className="h-3.5 w-3.5" />}
              {t === "Reposts" && <Repeat2 className="h-3.5 w-3.5" />}
              {t}
            </button>
          ))}
        </div>

        <div className="space-y-5">
          {tab === "Earnings" && isOwner ? (
            <WorkspaceMonetization workspaceId={id} />
          ) : tab === "Analytics" && isOwner ? (
            <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-muted/40" />}>
              <AnalyticsDashboard workspaceId={id} />
            </Suspense>
          ) : tab === "Team" && entry ? (
            <TeamSettingsPane workspaceId={id} onActivate={setActiveWsId} />
          ) : tab === "Reposts" ? (
            repostsLoading ? (
              <FeedSkeleton />
            ) : (
              <>
                {reposts.map((p, i) => (
                  <PostCard key={`repost-${p.id}`} post={p} index={i} />
                ))}
                {reposts.length === 0 && (
                  <Panel className="flex flex-col items-center gap-3 py-14 text-center">
                    <Repeat2 className="h-8 w-8 text-muted-foreground" />
                    <p className="font-bold">No reposts yet</p>
                    <p className="max-w-xs text-xs text-muted-foreground">
                      When {ws.name} reposts something as a team, it shows up here.
                    </p>
                  </Panel>
                )}
              </>
            )
          ) : loading ? (
            <FeedSkeleton />
          ) : (
            <>
              {list.map((p, i) => (
                <PostCard
                  key={`${tab}-${p.id}`}
                  post={p}
                  index={i}
                  onDeleted={(pid) => setPosts((prev) => prev.filter((x) => x.id !== pid))}
                />
              ))}
              {list.length === 0 && (
                <Panel className="flex flex-col items-center gap-3 py-14 text-center">
                  <Grid3X3 className="h-8 w-8 text-muted-foreground" />
                  <p className="font-bold">
                    {tab === "Media" ? "No media yet" : "No team posts yet"}
                  </p>
                  <p className="max-w-xs text-xs text-muted-foreground">
                    {ws.name} hasn't published anything{" "}
                    {tab === "Media" ? "with media" : "to the timeline"} yet.
                  </p>
                </Panel>
              )}
            </>
          )}
        </div>
      </div>

      {/* Tipping the team credits the workspace ledger (see startTipCheckout). */}
      <TipModal
        isOpen={isTipOpen}
        onClose={() => setIsTipOpen(false)}
        recipient={{ username: ws.slug, display_name: ws.name, avatar_url: ws.avatarUrl }}
        team={{
          workspaceId: ws.id,
          name: ws.name,
          avatarUrl: ws.avatarUrl,
          logoEmoji: ws.logoEmoji,
        }}
      />

      {/* Owner/Admin team-profile editor (name, logo, bio). */}
      {isManager && (
        <EditWorkspaceModal
          isOpen={isEditOpen}
          onClose={() => setIsEditOpen(false)}
          workspace={
            {
              id: ws.id,
              name: ws.name,
              bio: ws.bio,
              logoEmoji: ws.logoEmoji,
              avatarUrl: ws.avatarUrl,
            } satisfies EditableWorkspace
          }
          onSave={handleSave}
        />
      )}
    </AppShell>
  );
}

/**
 * Embeds the full Team Workspace desk (roster, invites, roles, seats, and the
 * settings editor). That desk operates on the viewer's *active* workspace, so
 * we point the active id at this page's team on first mount — a per-viewer
 * localStorage preference, safe to switch and it also makes the composer post
 * as the team you are managing.
 */
function TeamSettingsPane({
  workspaceId,
  onActivate,
}: {
  workspaceId: string;
  onActivate: (id: string) => void;
}) {
  const activated = useRef(false);
  useEffect(() => {
    if (!activated.current) {
      activated.current = true;
      onActivate(workspaceId);
    }
  }, [workspaceId, onActivate]);

  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-muted/40" />}>
      <TeamWorkspaceManager />
    </Suspense>
  );
}
