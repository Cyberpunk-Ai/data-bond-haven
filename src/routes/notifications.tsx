import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import {
  Heart,
  UserPlus,
  MessageCircle,
  Repeat2,
  AtSign,
  Radio,
  DollarSign,
  Banknote,
  Info,
  CheckCheck,
  BellOff,
  Loader2,
  X,
} from "lucide-react";
import { AppShell, PageHeader, Panel } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { TimeAgo } from "@/components/social/TimeAgo";
import { DefaultRail } from "@/components/social/RightRail";
import { Skeleton } from "@/components/ui/skeleton";
import type { Notification } from "@/lib/types";

function NotificationsSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="glass-panel flex items-start gap-4 rounded-3xl p-4.5 shadow-soft">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4.5 w-44 rounded-md" />
              <Skeleton className="h-3 w-14 rounded-md" />
            </div>
            <Skeleton className="h-3.5 w-64 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}
import { getProfile } from "@/lib/profile-service";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  hydrateAuthors,
} from "@/lib/api-client";
import { clearAllUnreadNotifications, decrementUnreadNotifications } from "@/lib/unread-state";
import { useRealtime } from "@/lib/realtime";
import { cn, withTimeout, PAGE_REQUEST_TIMEOUT_MS } from "@/lib/utils";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications — Spaces1" },
      {
        name: "description",
        content:
          "Every like, follow, mention, live Space invite, and tip in one clean timeline. Stay close to your Spaces community without the noise.",
      },
      { property: "og:title", content: "Notifications — Spaces1" },
      {
        property: "og:description",
        content: "Likes, follows, mentions, Space invites, and tips — all in one calm timeline.",
      },
    ],
  }),
  component: NotificationsPage,
});

const meta: Record<Notification["type"], { icon: typeof Heart; tint: string }> = {
  like: { icon: Heart, tint: "from-rose-500 to-pink-500" },
  ...({
    workspace_invite: { icon: UserPlus, tint: "from-emerald-500 to-teal-500" },
    workspace: { icon: UserPlus, tint: "from-emerald-500 to-teal-500" },
    // Server-side money and staff notices arrive without an actor — give them
    // their own icons instead of falling back to the "like" heart.
    payout: { icon: Banknote, tint: "from-emerald-500 to-teal-500" },
    system: { icon: Info, tint: "from-slate-500 to-zinc-500" },
    story_like: { icon: Heart, tint: "from-rose-500 to-pink-500" },
    message: { icon: MessageCircle, tint: "from-sky-500 to-cyan-500" },
  } as any),
  follow: { icon: UserPlus, tint: "from-violet-500 to-fuchsia-500" },
  comment: { icon: MessageCircle, tint: "from-sky-500 to-cyan-500" },
  reply: { icon: MessageCircle, tint: "from-blue-500 to-indigo-500" },
  repost: { icon: Repeat2, tint: "from-emerald-500 to-teal-500" },
  mention: { icon: AtSign, tint: "from-amber-500 to-orange-500" },
  space: { icon: Radio, tint: "from-indigo-500 to-violet-500" },
  tip: { icon: DollarSign, tint: "from-amber-500 to-orange-500" },
};

const fallbackMeta = { icon: BellOff, tint: "from-slate-500 to-zinc-500" };

const filters = ["All", "Mentions", "Follows", "Likes", "Tips", "Spaces"] as const;

// One page of the notification history in flight at a time; older rows are
// pulled on demand instead of shipping the whole archive up front.
const NOTIF_CHUNK = 50;

function NotificationsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<(typeof filters)[number]>("All");
  // Start in the loading state so the first paint shows the skeleton instead of
  // flashing an empty "no notifications" panel before the effect resolves.
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const offsetRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    getNotifications({ limit: NOTIF_CHUNK, offset: 0 })
      .then((data) => {
        if (Array.isArray(data)) {
          setItems(data);
          offsetRef.current = data.length;
          setHasMore(data.length === NOTIF_CHUNK);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function loadMore() {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await withTimeout(
        getNotifications({ limit: NOTIF_CHUNK, offset: offsetRef.current }),
        PAGE_REQUEST_TIMEOUT_MS,
      );
      if (Array.isArray(data)) {
        offsetRef.current += data.length;
        setHasMore(data.length === NOTIF_CHUNK);
        if (data.length) {
          setItems((prev) => {
            const seen = new Set(prev.map((n) => n.id));
            return [...prev, ...data.filter((n) => !seen.has(n.id))];
          });
        }
      }
    } catch (err) {
      // One failed page (or a timeout) is not the end of the timeline. Keep
      // `hasMore` and the offset so the button stays and a retry continues from
      // the same place — retiring it here silently hid all older notifications.
      console.warn("Load more notifications failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  // Belt to the realtime braces: if the tab was hidden while the socket was
  // down, re-pull the persistent timeline the moment it is visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      getNotifications({ limit: NOTIF_CHUNK, offset: 0 })
        .then((data) => {
          if (Array.isArray(data)) {
            setItems(data);
            offsetRef.current = data.length;
            setHasMore(data.length === NOTIF_CHUNK);
          }
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Realtime: new notifications drop straight into the timeline, and reads
  // performed on another device mark the row read here too. The toast is
  // raised globally by the AppShell, so this page only mutates the list.
  useRealtime(
    (event) => {
      if (event.type === "notification_read" && event.id) {
        setItems((prev) => prev.map((n) => (n.id === event.id ? { ...n, read: true } : n)));
        return;
      }
      const notif =
        event.notification ||
        (event.type === "notification" ? event.data || (event.id ? event : null) : null);
      if (notif && notif.id) {
        // Resolve the actor before rendering so the name/avatar are populated on
        // the first paint of the live row (the DB feed delivers the raw row).
        void hydrateAuthors([notif.actor_id]).finally(() => {
          setItems((prev) => {
            if (prev.some((n) => n.id === notif.id)) return prev;
            return [notif, ...prev];
          });
        });
      }
    },
    ["notification", "notification_read"],
  );

  async function handleMarkAllRead() {
    setItems((p) => p.map((n) => ({ ...n, read: true })));
    clearAllUnreadNotifications();
    try {
      await markAllNotificationsRead();
      toast.success("All notifications marked as read");
    } catch (err) {
      // Optimistic clear stands until the next load resyncs it; confirm only once
      // the server has agreed, so the toast isn't claiming a write that failed.
      console.warn("mark all read failed:", err);
    }
  }

  async function handleMarkRead(id: string) {
    const item = items.find((x) => x.id === id);
    if (item && !item.read) {
      decrementUnreadNotifications(1);
    }
    setItems((p) => p.map((x) => (x.id === id ? { ...x, read: true } : x)));
    try {
      await markNotificationRead(id);
    } catch (err) {
      // Opening the post is what the user came for; a flag that didn't stick shows
      // up again on the next load rather than blocking navigation here.
      console.warn("mark read failed:", err);
    }
  }

  // Mark read, then route the user to the relevant destination for the type.
  function handleOpen(n: Notification) {
    void handleMarkRead(n.id);
    if (n.type === "space") {
      void navigate({ to: "/spaces" });
      return;
    }
    if ((n.type as string) === "workspace_invite" || (n.type as string) === "workspace") {
      void navigate({ to: "/settings", search: { section: "workspaces" } as any });
      return;
    }
    if ((n.type as string) === "message") {
      // A DM alert belongs in the inbox — open the thread with the sender
      // directly instead of dropping the visitor on their profile.
      if (n.actor_id) {
        void navigate({ to: "/messages", search: { user: n.actor_id } });
      }
      return;
    }
    // Engagement on a post opens that post. The triggers stamp like/comment/
    // reply/repost with the post id, and tips carry it since the tip-notify
    // migration, so one list covers everything that points at a post.
    if (n.post_id && ["like", "comment", "reply", "repost", "mention", "tip"].includes(n.type)) {
      void navigate({ to: "/post/$id", params: { id: n.post_id } });
      return;
    }
    if (n.type === "tip" || (n.type as string) === "payout") {
      // No post context — the earnings hub is the right landing spot.
      void navigate({ to: "/settings", search: { section: "monetization" } });
      return;
    }
    if ((n.type as string) === "system") return; // notice only — marking it read is the action
    // Everything person-shaped (follows, story likes, post-less engagement)
    // opens the actor's profile.
    if (n.actor_id) {
      void navigate({ to: "/profile", search: { user: n.actor_id } });
    }
  }

  async function handleDelete(e: ReactMouseEvent, id: string) {
    e.stopPropagation();
    const item = items.find((x) => x.id === id);
    const removed = item;
    setItems((p) => p.filter((x) => x.id !== id));
    if (item && !item.read) decrementUnreadNotifications(1);
    try {
      await deleteNotification(id);
    } catch {
      // Restore on failure so the user doesn't lose the notification silently.
      if (removed)
        setItems((p) => [removed, ...p].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
      toast.error("Couldn't delete that notification. Please try again.");
    }
  }

  const visible = items.filter((n) => {
    if (filter === "All") return true;
    if (filter === "Mentions")
      return n.type === "mention" || n.type === "comment" || n.type === "reply";
    if (filter === "Follows") return n.type === "follow";
    if (filter === "Likes")
      return n.type === "like" || n.type === "repost" || n.type === "story_like";
    if (filter === "Tips") return n.type === "tip" || n.type === "payout";
    if (filter === "Spaces") return n.type === "space";
    return true;
  });

  const unread = items.filter((n) => !n.read).length;

  return (
    <AppShell title="Notifications" right={<DefaultRail />}>
      <div className="mx-auto max-w-2xl space-y-5">
        <PageHeader
          title="Notifications"
          subtitle={unread ? `${unread} new since your last visit` : "You're all caught up"}
          action={
            <button
              onClick={handleMarkAllRead}
              className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-semibold transition-all duration-300 hover:bg-foreground/5 active:scale-95 cursor-pointer"
            >
              <CheckCheck className="h-4 w-4" /> Mark all read
            </button>
          }
        />

        <div className="glass-panel flex items-center gap-1 rounded-full p-1.5 shadow-soft overflow-x-auto [scrollbar-width:none]">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "flex-1 rounded-full px-3.5 py-2 text-xs sm:text-sm font-bold transition-all duration-300 whitespace-nowrap cursor-pointer",
                filter === f
                  ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {loading ? (
          <NotificationsSkeleton />
        ) : (
          <div className="space-y-3">
            {visible.map((n, i) => {
              const actor = getProfile(n.actor_id);
              const { icon: Icon, tint } = meta[n.type] || fallbackMeta;
              return (
                <div
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpen(n)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleOpen(n);
                  }}
                  style={{ animationDelay: `${i * 45}ms` }}
                  className={cn(
                    "glass-panel group flex w-full animate-in items-start gap-3 rounded-3xl p-4 text-left shadow-soft transition-all duration-300 fade-in slide-in-from-bottom-3 hover:-translate-y-0.5 hover:shadow-lift cursor-pointer",
                    !n.read && "ring-1 ring-brand/25 bg-brand/[0.03]",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-white",
                      tint,
                    )}
                  >
                    <Icon className="h-4.5 w-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      {n.actor_id ? (
                        <>
                          <Avatar
                            name={actor.display_name}
                            src={actor.avatar_url}
                            className="h-6 w-6 text-[0.6rem]"
                          />
                          <span className="truncate text-sm font-bold">{actor.display_name}</span>
                        </>
                      ) : (
                        // Payout / system notices come from the platform, not a person.
                        <span className="text-sm font-bold">Spaces1</span>
                      )}
                      <TimeAgo
                        iso={n.created_at}
                        className="shrink-0 text-xs text-muted-foreground"
                      />
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">{n.body}</span>
                    {(n as any).action?.kind === "workspace_invite" && (
                      <InviteActions notification={n as any} />
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 pl-1">
                    {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-brand" />}
                    <button
                      type="button"
                      onClick={(e) => handleDelete(e, n.id)}
                      aria-label="Delete notification"
                      className="rounded-full p-1.5 text-muted-foreground/70 opacity-0 transition-all duration-200 hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              );
            })}

            {hasMore && visible.length > 0 && (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/5 px-6 py-2.5 text-xs font-bold text-brand transition-all active:scale-95 cursor-pointer disabled:opacity-60"
                >
                  <Loader2 className={`h-3.5 w-3.5 ${loadingMore ? "animate-spin" : ""}`} />
                  Load older notifications
                </button>
              </div>
            )}

            {visible.length === 0 && (
              <Panel className="flex flex-col items-center gap-3 py-12 text-center">
                <BellOff className="h-8 w-8 text-muted-foreground" />
                <p className="font-bold">Nothing here yet</p>
                <p className="text-sm text-muted-foreground">
                  {filter === "All"
                    ? "Activity like likes, mentions and follows will show up here."
                    : `New ${filter.toLowerCase()} will show up here.`}
                </p>
              </Panel>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function InviteActions({
  notification,
}: {
  notification: { action: { member_id: string; state: string } };
}) {
  const [state, setState] = useState(notification.action.state);
  const [busy, setBusy] = useState(false);
  async function respond(accept: boolean) {
    setBusy(true);
    const { error } = await (supabase as any).rpc("respond_workspace_invite", {
      _member_id: notification.action.member_id,
      _accept: accept,
    });
    setBusy(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setState(accept ? "accepted" : "declined");
    toast.success(accept ? "You joined the team" : "Invite declined");
  }
  if (state !== "pending") {
    return (
      <span className="mt-2 inline-block rounded-full bg-foreground/5 px-3 py-1 text-xs font-semibold capitalize text-muted-foreground">
        {state}
      </span>
    );
  }
  return (
    <span className="mt-3 flex gap-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={busy}
        onClick={() => respond(true)}
        className="rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        Accept
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => respond(false)}
        className="rounded-full border border-border px-4 py-1.5 text-xs font-bold text-foreground hover:bg-foreground/5 disabled:opacity-60"
      >
        Decline
      </button>
    </span>
  );
}
