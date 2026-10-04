import { createFileRoute, Link } from "@tanstack/react-router";
import { canonicalLink, ogUrlMeta, brandedTitle } from "@/lib/seo";
import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Radio,
  Mic,
  Calendar,
  Headphones,
  Play,
  Plus,
  Search,
  X,
  Loader2,
  Check,
  Trash2,
} from "lucide-react";
import { AppShell, Panel, PageHeader } from "@/components/social/AppShell";
import { RailFooter } from "@/components/social/RightRail";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { SpaceRoomModal } from "@/components/social/SpaceRoomModal";
import { usePlatform } from "@/lib/platform-state";
import { Skeleton } from "@/components/ui/skeleton";
import { compact } from "@/lib/formatters";

function SpacesSkeleton() {
  return (
    <div
      className="grid gap-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
      aria-busy="true"
      aria-label="Loading spaces"
    >
      {[1, 2, 3].map((i) => (
        <div key={i} className="glass-panel rounded-3xl p-6 shadow-soft space-y-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
          <Skeleton className="h-7 w-[85%] rounded-md" />
          <div className="flex items-center gap-3 pt-2">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-28 rounded-md" />
              <Skeleton className="h-3 w-12 rounded-md" />
            </div>
            <div className="flex -space-x-2">
              {[1, 2, 3].map((j) => (
                <Skeleton key={j} className="h-8 w-8 rounded-full border-2 border-background" />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border/30 pt-4">
            <Skeleton className="h-4 w-32 rounded-md" />
            <Skeleton className="h-10 w-32 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
import { getProfile, useProfile, currentUser } from "@/lib/profile-service";
import type { Space } from "@/lib/types";
import { getSpaces, createSpace, deleteSpaceRecording } from "@/lib/api-client";
import { getRecommendedSpaces } from "@/lib/recommendations.functions";
import { useRealtime } from "@/lib/realtime";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { getSpaceStorageState } from "@/lib/spaces-storage.functions";
import { formatBytes, spaceStorageQuotaBytes } from "@/lib/spaces-storage";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";

export const Route = createFileRoute("/spaces")({
  validateSearch: (search: Record<string, unknown>): { spaceId?: string } => ({
    spaceId: search.spaceId ? String(search.spaceId) : undefined,
  }),
  head: () => ({
    meta: [
      { title: brandedTitle("Live Audio Rooms") },
      {
        name: "description",
        content:
          "Join live audio Spaces: design clinics, photography workshops, and creator conversations happening right now.",
      },
      { property: "og:title", content: brandedTitle("Live Audio Rooms") },
      {
        property: "og:description",
        content: "Live audio rooms for creators: join, listen, or host your own Space.",
      },
      // The room directory is one indexable page; a deep-linked room id in the
      // query string is the same directory, so it rolls up here.
      ogUrlMeta("/spaces"),
    ],
    links: [canonicalLink("/spaces")],
  }),
  component: SpacesPage,
});

const gradientChoices = [
  { name: "Purple Neon", value: "from-purple-600 to-pink-600" },
  { name: "Cyan Breeze", value: "from-cyan-500 to-blue-600" },
  { name: "Sunset Gold", value: "from-amber-500 to-rose-600" },
  { name: "Emerald Pulse", value: "from-emerald-500 to-teal-700" },
];

function SpaceCard({
  space,
  index,
  onJoin,
  onRemind,
  isReminded,
  onDeleteRecording,
}: {
  space: Space;
  index: number;
  onJoin: (space: Space) => void;
  onRemind: (spaceId: string) => void;
  isReminded: boolean;
  onDeleteRecording: (space: Space) => void;
}) {
  const { profile: hostProfile } = useProfile(space.host_id);
  // Resolve the host's real name/avatar instead of showing the raw UUID that an
  // uncached getProfile() fallback returns for a fresh visitor.
  const host = hostProfile ?? getProfile(space.host_id);
  const guests = useMemo(() => {
    const seen = new Set<string>();
    return (space.participants || [])
      .filter((p) => {
        if (!p?.id || p.id === space.host_id || seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      })
      .slice(0, 4)
      .map((p) => getProfile(p.id));
  }, [space.participants, space.host_id]);

  // Mirror the Recorded-tab rule: a room is only a replay once a real
  // recording URL was saved alongside the flag — and recordings belong to the
  // host alone, so only they ever see (or re-enter) the replay.
  const isRecorded = Boolean(
    space.recorded && space.recording_url && space.host_id === currentUser.id,
  );
  const isMine = space.host_id === currentUser.id;

  return (
    <article
      style={{ animationDelay: `${index * 70}ms` }}
      className="group glass-panel animate-in fade-in slide-in-from-bottom-4 relative overflow-hidden rounded-3xl p-6 shadow-soft duration-700 fill-mode-both transition-all hover:-translate-y-1 hover:shadow-lift"
    >
      <span
        className={cn(
          "absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-to-br opacity-25 blur-2xl transition-transform duration-700 group-hover:scale-125",
          space.gradient || "from-purple-600 to-pink-600",
        )}
      />
      <div className="relative">
        <div className="flex items-center gap-2">
          {space.live ? (
            <span className="flex items-center gap-1.5 rounded-full bg-rose-500/12 px-3 py-1 text-xs font-bold text-rose-500">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
              </span>
              LIVE
            </span>
          ) : isRecorded ? (
            <span className="flex items-center gap-1.5 rounded-full bg-purple-500/15 px-3 py-1 text-xs font-bold text-purple-600 dark:text-purple-400">
              <Headphones className="h-3 w-3" /> {space.duration || "Recorded replay"}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-foreground/5 px-3 py-1 text-xs font-bold text-muted-foreground">
              <Calendar className="h-3 w-3" /> {space.startsIn || "Upcoming"}
            </span>
          )}
          <span className="rounded-full bg-brand/8 px-3 py-1 text-xs font-bold text-brand">
            {space.topic}
          </span>
        </div>

        <h3 className="mt-4 text-xl font-bold leading-snug">{space.title}</h3>

        <div className="mt-4 flex items-center gap-3">
          <Link
            to="/profile"
            search={{ id: host.id, user: host.username }}
            className="shrink-0 transition-transform hover:scale-105 active:scale-95"
          >
            <Avatar name={host.display_name} src={host.avatar_url} className="h-10 w-10 text-xs" />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-1 truncate">
              <Link
                to="/profile"
                search={{ id: host.id, user: host.username }}
                className="truncate text-sm font-bold hover:text-brand hover:underline transition-colors"
              >
                {host.display_name}
              </Link>
              <UserBadge plan={host.plan} verified={host.verified} size="xs" />
            </div>
            <p className="text-xs text-muted-foreground">Host</p>
          </div>
          <div className="ml-auto flex -space-x-2">
            {guests.map((g, idx) => (
              <Link
                key={`${space.id}-guest-${g.id}-${idx}`}
                to="/profile"
                search={{ id: g.id, user: g.username }}
                className="transition-transform hover:scale-110 active:scale-95"
              >
                <Avatar
                  name={g.display_name}
                  src={g.avatar_url}
                  ring
                  className="h-8 w-8 text-[0.6rem]"
                />
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Headphones className="h-4 w-4" />
            {space.live
              ? `${compact(space.listeners || 1)} listening`
              : isRecorded
                ? `${compact(space.replay_count ?? 0)} replays`
                : "Reminder available"}
          </p>
          <div className="flex items-center gap-2">
            {isRecorded && isMine && (
              <button
                onClick={() => onDeleteRecording(space)}
                title="Delete recording"
                className="flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-2.5 text-xs font-bold text-muted-foreground transition-all hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-500 active:scale-95 cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
                <span className="hidden sm:inline">Delete</span>
              </button>
            )}
            <button
              onClick={() => (space.live || isRecorded ? onJoin(space) : onRemind(space.id))}
              className={cn(
                "flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold transition-all duration-300 active:scale-95 cursor-pointer",
                space.live
                  ? "bg-gradient-to-r from-brand to-brand-pink text-white hover:shadow-glow"
                  : isRecorded
                    ? "bg-purple-600 text-white hover:bg-purple-700 shadow-soft"
                    : isReminded
                      ? "bg-emerald-500/15 text-emerald-600 font-bold"
                      : "bg-foreground/5 text-foreground hover:bg-foreground/10",
              )}
            >
              {space.live ? (
                <Play className="h-4 w-4 fill-current" />
              ) : isRecorded ? (
                <Play className="h-4 w-4 fill-current" />
              ) : isReminded ? (
                <Check className="h-4 w-4" />
              ) : (
                <Calendar className="h-4 w-4" />
              )}
              {space.live
                ? "Join Space"
                : isRecorded
                  ? "Listen Replay"
                  : isReminded
                    ? "Reminder Set"
                    : "Remind me"}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

const tabs = ["Live now", "Upcoming", "Recorded"] as const;

function SpacesPage() {
  const search = Route.useSearch();
  const { currentPlan, planDetails } = usePlan();
  // The console can switch the whole live-audio subsystem off; the database
  // refuses the writes, and these pages refuse to offer them.
  const { spacesEnabled } = usePlatform();
  const [tab, setTab] = useState<(typeof tabs)[number]>("Live now");
  const [allSpaces, setAllSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSpace, setActiveSpace] = useState<Space | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [reminders, setReminders] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  // Host deleting a saved replay (recording) — confirm first, then reclaim.
  const [deleteTarget, setDeleteTarget] = useState<Space | null>(null);
  const [deletingRecording, setDeletingRecording] = useState(false);
  // What the signed-in host has spent of their replay budget. A live Space is
  // not in this number: broadcasting stores nothing, so the figure only moves
  // when a replay is saved or deleted.
  const [storage, setStorage] = useState<{
    usedBytes: number;
    quotaBytes: number;
    replays: number;
  } | null>(null);

  async function refreshStorage() {
    if (!currentUser.id || currentUser.id === "guest") return;
    try {
      const snap = await getSpaceStorageState();
      setStorage({ usedBytes: snap.usedBytes, quotaBytes: snap.quotaBytes, replays: snap.replays });
    } catch (err) {
      // Advisory readout only — never a reason the Spaces page stops working.
      console.warn("Space storage read failed:", err);
    }
  }

  const signedInForStorage = Boolean(currentUser.id) && currentUser.id !== "guest";

  useEffect(() => {
    if (!signedInForStorage) return;
    void refreshStorage();
  }, [signedInForStorage]);

  // Create Space Form State
  const [scheduleMode, setScheduleMode] = useState<"live" | "scheduled">("live");
  const [scheduledDate, setScheduledDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  });
  const [scheduledTime, setScheduledTime] = useState("18:00");
  const [titleDraft, setTitleDraft] = useState("");
  const [topicDraft, setTopicDraft] = useState("Design & Craft");
  const [gradientDraft, setGradientDraft] = useState(gradientChoices[0]!.value);
  const [creating, setCreating] = useState(false);
  // Personalised ranking: Space id → recommendation rank (lower = more relevant).
  const [recRank, setRecRank] = useState<Record<string, number>>({});

  useEffect(() => {
    setLoading(true);
    getSpaces()
      .then((data) => {
        if (data?.spaces && data.spaces.length > 0) setAllSpaces(data.spaces);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Fetch a personalised ordering once (best-effort; guests get chronological).
  useEffect(() => {
    let active = true;
    getRecommendedSpaces({ data: { limit: 100 } })
      .then((res) => {
        if (!active || !res?.personalised) return;
        const map: Record<string, number> = {};
        (res.ranked as { id: string }[]).forEach((r, i) => (map[r.id] = i));
        setRecRank(map);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Keep the list in sync as rooms open, fill up and close
  useRealtime(
    (event) => {
      if (event.type === "space:created" && event.space?.id) {
        setAllSpaces((prev) =>
          prev.some((s) => s.id === event.space.id) ? prev : [event.space, ...prev],
        );
      } else if (event.type === "space:ended" && event.spaceId) {
        // Mirror endSpace's authoritative DB write: the room stops being live,
        // any recorder is stopped, and it only files under Recorded when a real
        // replay was saved (recording_url present) — never for a bare end.
        setAllSpaces((prev) =>
          prev.map((s) =>
            s.id === event.spaceId
              ? {
                  ...s,
                  live: false,
                  is_recording: false,
                  recorded: Boolean(s.recording_url),
                  listeners: 0,
                }
              : s,
          ),
        );
        setActiveSpace((cur) => (cur && cur.id === event.spaceId ? null : cur));
      } else if (event.type === "space:listeners" && event.spaceId) {
        setAllSpaces((prev) =>
          prev.map((s) => (s.id === event.spaceId ? { ...s, listeners: event.listeners } : s)),
        );
      } else if (event.type === "space:recording") {
        // finalizeSpaceRecording announces the saved replay URL: the room
        // becomes replayable live, no reload needed.
        const data = event.data || event;
        const sid = event.spaceId || data?.spaceId;
        if (sid && data?.recordingUrl) {
          setAllSpaces((prev) =>
            prev.map((s) =>
              s.id === sid
                ? { ...s, recorded: true, recording_url: data.recordingUrl, is_recording: false }
                : s,
            ),
          );
        }
      } else if (event.type === "space:recording-deleted") {
        const sid = event.spaceId || event.data?.spaceId;
        if (sid) applyRecordingDeleted(sid);
      }
    },
    [
      "space:created",
      "space:ended",
      "space:listeners",
      "space:recording",
      "space:recording-deleted",
    ],
  );

  // Auto-open space if spaceId is provided in URL
  // Open only once per link; list refreshes must not reopen a closed room.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!search.spaceId || autoOpened.current === search.spaceId || allSpaces.length === 0) return;
    if (!spacesEnabled) {
      // A shared link into a room must not open a subsystem that is switched
      // off; remember the id so this effect doesn't re-run on every list tick.
      autoOpened.current = search.spaceId;
      return;
    }
    const found = allSpaces.find((s) => s.id === search.spaceId);
    if (found) {
      autoOpened.current = search.spaceId;
      setActiveSpace((cur) => (cur?.id === found.id ? cur : found));
    }
  }, [search.spaceId, allSpaces, spacesEnabled]);

  function handleRemind(spaceId: string) {
    setReminders((prev) => {
      const next = !prev[spaceId];
      toast(
        next ? "Reminder set! We'll notify you when this Space goes live." : "Reminder removed",
      );
      return { ...prev, [spaceId]: next };
    });
  }

  /** Drop a room's replay from the list state and close any open modal on it. */
  function applyRecordingDeleted(spaceId: string) {
    setAllSpaces((prev) =>
      prev.map((s) =>
        s.id === spaceId
          ? {
              ...s,
              recorded: false,
              recording_url: undefined,
              is_recording: false,
              replay_count: 0,
            }
          : s,
      ),
    );
    setActiveSpace((cur) => (cur && cur.id === spaceId ? null : cur));
  }

  async function confirmDeleteRecording() {
    if (!deleteTarget || deletingRecording) return;
    setDeletingRecording(true);
    try {
      await deleteSpaceRecording(deleteTarget.id);
      applyRecordingDeleted(deleteTarget.id);
      toast.success("Recording deleted");
      setDeleteTarget(null);
      // The bytes come back to the host's budget the moment the replay goes.
      void refreshStorage();
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't delete the recording. Please try again."));
    } finally {
      setDeletingRecording(false);
    }
  }

  async function handleCreateSpace(e: React.FormEvent) {
    e.preventDefault();
    if (!titleDraft.trim() || creating) return;

    setCreating(true);
    try {
      const isScheduled = scheduleMode === "scheduled";
      const startsInText = isScheduled
        ? `${new Date(`${scheduledDate}T${scheduledTime}`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${scheduledTime}`
        : "Live now";

      const res = await createSpace({
        title: titleDraft.trim(),
        topic: topicDraft.trim() || "General",
        gradient: gradientDraft,
        live: !isScheduled,
        startsAt: isScheduled ? new Date(`${scheduledDate}T${scheduledTime}`).toISOString() : null,
      });

      const newSpace: Space = {
        ...res.space,
        live: !isScheduled,
        startsIn: isScheduled ? startsInText : undefined,
      };

      // `createSpace` already broadcast `space:created`, which this tab
      // receives locally, so the room may already be in the list. Merge on
      // idempotency rather than prepending a second copy (duplicate React key).
      setAllSpaces((prev) =>
        prev.some((s) => s.id === newSpace.id)
          ? prev.map((s) => (s.id === newSpace.id ? { ...s, ...newSpace } : s))
          : [newSpace, ...prev],
      );
      setShowCreateModal(false);
      setTitleDraft("");

      if (isScheduled) {
        toast.success(`Space scheduled for ${startsInText}! Added to your Upcoming calendar.`);
        setTab("Upcoming");
      } else {
        toast.success("Space created! You are now live.");
        setActiveSpace(newSpace);
      }
    } catch (err: unknown) {
      toast.error(friendlyError(err, "Couldn't start the Space. Please try again."));
    } finally {
      setCreating(false);
    }
  }

  // A Space is a replay only once a recording has actually been saved to
  // storage (`recorded` + a real `recording_url`). Ending a never-recorded room
  // must not create a dead "Listen Replay" entry, and a scheduled room that
  // hasn't gone live belongs in Upcoming — not Recorded. Recordings are the
  // host's property: other users never see them (mirrors the `spaces public
  // read` RLS and the recordings/ media ACL).
  const isRecordedSpace = (s: (typeof allSpaces)[number]) =>
    Boolean(s.recorded && s.recording_url && s.host_id === currentUser.id);
  // A scheduled room is "Upcoming" only while its start time is still ahead of
  // now; once it is past due and never went live it has no tab.
  const isUpcomingSpace = (s: (typeof allSpaces)[number]) => {
    if (s.live || isRecordedSpace(s)) return false;
    const start = s.starts_at ? new Date(s.starts_at).getTime() : 0;
    return Boolean(start && start > Date.now());
  };

  // Defensive: never render two cards for the same room id, whatever path
  // added it (create + realtime echo, or a re-fetch racing a broadcast).
  const uniqueSpaces = useMemo(() => {
    const seen = new Set<string>();
    return allSpaces.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  }, [allSpaces]);

  const matched = uniqueSpaces.filter((s) => {
    if (tab === "Live now" && !s.live) return false;
    if (tab === "Upcoming" && !isUpcomingSpace(s)) return false;
    if (tab === "Recorded" && !isRecordedSpace(s)) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return s.title.toLowerCase().includes(q) || s.topic.toLowerCase().includes(q);
    }
    return true;
  });

  // Apply the personalised ordering to discovery tabs (Live / Upcoming) when we
  // have it and the user isn't actively searching. Rooms created after mount
  // aren't in the ranking yet, so they keep the top (newest-first) position.
  const filtered = (() => {
    if (tab === "Recorded" || searchQuery.trim() || Object.keys(recRank).length === 0) {
      return matched;
    }
    const rankOf = (s: (typeof matched)[number], idx: number) =>
      s.id in recRank ? recRank[s.id] : -(idx + 1);
    return matched
      .map((s, idx) => ({ s, idx }))
      .sort((a, b) => rankOf(a.s, a.idx) - rankOf(b.s, b.idx))
      .map((x) => x.s);
  })();

  return (
    <AppShell
      title="Spaces"
      right={
        <div className="space-y-5">
          <div className="group relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-brand" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search Spaces..."
              className="glass-panel h-12 w-full rounded-full pl-11 pr-4 text-sm outline-none transition-all duration-300 focus:shadow-soft focus:ring-2 focus:ring-brand/30"
            />
          </div>

          <Panel>
            <h2 className="mb-2 flex items-center gap-2 text-lg font-bold">
              <Mic className="h-4 w-4 text-brand" /> Host a Space
            </h2>
            <p className="text-sm text-muted-foreground">
              Go live in seconds. Invite co-hosts, open the floor, and record for later.
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              disabled={!spacesEnabled}
              title={spacesEnabled ? undefined : "Live Spaces are paused by the platform team"}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-brand to-brand-pink py-3 text-sm font-bold text-white transition-all duration-300 hover:shadow-glow active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
            >
              <Plus className="h-4 w-4" /> Start a Space
            </button>
          </Panel>
          <RailFooter />
        </div>
      }
    >
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          title="Spaces"
          subtitle="Live audio rooms hosted by the people you follow."
          action={
            <button
              onClick={() => setShowCreateModal(true)}
              disabled={!spacesEnabled}
              title={spacesEnabled ? undefined : "Live Spaces are paused by the platform team"}
              className="flex items-center gap-2 rounded-full bg-gradient-to-r from-brand to-brand-pink px-5 py-2.5 text-sm font-bold text-white transition-all duration-300 hover:shadow-glow active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
            >
              <Radio className="h-4 w-4" /> Go live
            </button>
          }
        />

        {!spacesEnabled && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs font-semibold text-rose-900 shadow-soft dark:text-rose-100">
            <Radio className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <span>
              Live Audio Spaces are paused right now. Recorded rooms stay available to replay, and
              hosting resumes on its own when the platform team switches the subsystem back on.
            </span>
          </div>
        )}

        <div className="glass-panel flex gap-1 rounded-full p-1.5 shadow-soft overflow-x-auto [scrollbar-width:none] touch-pan-x">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 min-w-[90px] rounded-full px-3.5 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-bold transition-all duration-300 min-h-[38px] flex items-center justify-center shrink-0",
                tab === t
                  ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="grid gap-5">
          {loading ? (
            <SpacesSkeleton />
          ) : (
            <>
              {filtered.map((s, i) => (
                <SpaceCard
                  key={s.id}
                  space={s}
                  index={i}
                  onJoin={(sp) => {
                    if (!spacesEnabled) {
                      toast.info("Live Spaces are paused right now — try again shortly.");
                      return;
                    }
                    setActiveSpace(sp);
                  }}
                  onRemind={handleRemind}
                  isReminded={Boolean(reminders[s.id])}
                  onDeleteRecording={(sp) => setDeleteTarget(sp)}
                />
              ))}

              {filtered.length === 0 && (
                <Panel className="text-center py-12">
                  <Mic className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="font-bold">No spaces found</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Be the first to start a conversation in this tab!
                  </p>
                </Panel>
              )}
            </>
          )}
        </div>
      </div>

      {/* Live Space Room Modal */}
      <SpaceRoomModal
        space={activeSpace}
        isOpen={Boolean(activeSpace)}
        onClose={() => setActiveSpace(null)}
      />

      {/* Delete Recording Confirmation Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div
            className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 text-rose-500">
              <span className="p-2.5 rounded-2xl bg-rose-500/15">
                <Trash2 className="h-6 w-6" />
              </span>
              <div>
                <h3 className="text-base font-black">Delete this recording?</h3>
                <p className="text-xs text-muted-foreground">This can't be undone.</p>
              </div>
            </div>
            <p className="text-xs text-foreground/80 leading-relaxed">
              The replay of “{deleteTarget.title}” will be removed for you and every listener. The
              room's chat transcript stays as it is.
            </p>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="flex-1 rounded-2xl border border-border py-2.5 text-xs font-bold hover:bg-muted cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteRecording}
                disabled={deletingRecording}
                className="flex-1 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white py-2.5 text-xs font-bold shadow-soft cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1.5"
              >
                {deletingRecording && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete Recording
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Space Dialog */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 sm:p-4 animate-in fade-in duration-200">
          <div
            className="glass-panel relative w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-2xl sm:rounded-3xl p-5 sm:p-6 shadow-2xl border border-border/80 bg-card/95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 sm:pb-4 border-b border-border/60">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand-pink text-white">
                  <Mic className="h-4 w-4 sm:h-5 sm:w-5" />
                </span>
                <h2 className="text-base sm:text-lg font-bold">Start a Space</h2>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground min-h-[36px] min-w-[36px] flex items-center justify-center"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSpace} className="mt-5 space-y-4">
              {/* Timing mode selector */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                  Space Timing
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setScheduleMode("live")}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-2xl py-2.5 text-xs font-bold transition-all border",
                      scheduleMode === "live"
                        ? "bg-gradient-to-r from-brand to-brand-pink text-white border-transparent shadow-soft"
                        : "border-border/80 bg-foreground/5 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Radio className="h-3.5 w-3.5" /> Go Live Now
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleMode("scheduled")}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-2xl py-2.5 text-xs font-bold transition-all border",
                      scheduleMode === "scheduled"
                        ? "bg-gradient-to-r from-brand to-brand-pink text-white border-transparent shadow-soft"
                        : "border-border/80 bg-foreground/5 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Calendar className="h-3.5 w-3.5" /> Schedule for Later
                  </button>
                </div>
              </div>

              {/* Scheduled date & time picker */}
              {scheduleMode === "scheduled" && (
                <div className="grid grid-cols-2 gap-2 p-3 rounded-2xl bg-brand/5 border border-brand/20 animate-in fade-in">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-muted-foreground block mb-1">
                      Event Date
                    </label>
                    <input
                      type="date"
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                      className="w-full rounded-xl bg-card border border-border px-3 py-1.5 text-xs font-semibold outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-muted-foreground block mb-1">
                      Start Time
                    </label>
                    <input
                      type="time"
                      value={scheduledTime}
                      onChange={(e) => setScheduledTime(e.target.value)}
                      className="w-full rounded-xl bg-card border border-border px-3 py-1.5 text-xs font-semibold outline-none focus:border-brand"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                  What do you want to talk about?
                </label>
                <input
                  type="text"
                  required
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  placeholder="e.g. Design Systems clinic & AMA"
                  className="w-full rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm outline-none border border-transparent focus:border-brand/40"
                />
              </div>

              <div>
                <label
                  htmlFor="space-topic"
                  className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1"
                >
                  Topic / Category
                </label>
                {/* Combobox: pick a suggested topic or type your own free-text category. */}
                <input
                  id="space-topic"
                  type="text"
                  required
                  list="space-topic-suggestions"
                  value={topicDraft}
                  onChange={(e) => setTopicDraft(e.target.value)}
                  placeholder="e.g. Indie Game Dev, Study Together..."
                  className="w-full rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm outline-none border border-transparent focus:border-brand/40"
                />
                <datalist id="space-topic-suggestions">
                  <option value="Design & Craft" />
                  <option value="AI & Generative" />
                  <option value="Photography" />
                  <option value="Product & Tech" />
                  <option value="Sound Design" />
                  <option value="Open Mic" />
                </datalist>
              </div>

              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                  Visual Gradient Theme
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {gradientChoices.map((g) => (
                    <button
                      key={g.name}
                      type="button"
                      onClick={() => setGradientDraft(g.value)}
                      className={cn(
                        "h-10 rounded-xl bg-gradient-to-r p-2 text-left text-xs font-bold text-white shadow-xs transition-all",
                        g.value,
                        gradientDraft === g.value
                          ? "ring-2 ring-foreground ring-offset-2 scale-102"
                          : "opacity-75 hover:opacity-100",
                      )}
                    >
                      {g.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tier Audio Quality & Limit Status */}
              <div className="rounded-2xl border border-border/80 bg-foreground/5 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-muted-foreground">Broadcast Audio Quality</span>
                  <span
                    className={cn(
                      "text-[0.65rem] font-black px-1.5 py-0.5 rounded",
                      planDetails.badgeColor,
                    )}
                  >
                    {planDetails.limits.spacesAudioQuality}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-muted-foreground text-[0.72rem]">
                  <span>
                    Max Audience: <strong>{planDetails.limits.spacesMaxListeners} listeners</strong>
                  </span>
                  {currentPlan === "free" ? (
                    <button
                      type="button"
                      onClick={() => openUpgradeModal("Unlock HD Spatial Audio & 250 Listeners")}
                      className="font-bold text-brand hover:underline"
                    >
                      Upgrade for Studio HD →
                    </button>
                  ) : (
                    <span className="text-emerald-500 font-bold">✨ HD Active</span>
                  )}
                </div>
                {/* The storage promise, stated plainly: going live costs nothing,
                    and only a saved replay spends the plan's replay budget. */}
                <div className="mt-1.5 flex items-center justify-between gap-2 text-muted-foreground text-[0.72rem]">
                  <span>
                    Live broadcast stores <strong className="text-foreground">nothing</strong>
                    {planDetails.limits.spacesRecording ? (
                      <> · replays up to {formatBytes(spaceStorageQuotaBytes(currentPlan))}</>
                    ) : (
                      <> · replays need an upgrade</>
                    )}
                  </span>
                  {storage && planDetails.limits.spacesRecording ? (
                    <span
                      className={cn(
                        "shrink-0 font-bold",
                        storage.usedBytes >= storage.quotaBytes
                          ? "text-amber-500"
                          : "text-emerald-500",
                      )}
                    >
                      {formatBytes(storage.usedBytes)} / {formatBytes(storage.quotaBytes)}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-4 border-t border-border/60">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-full px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-foreground/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!titleDraft.trim() || creating}
                  className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-brand to-brand-pink px-6 py-2.5 text-xs font-bold text-white shadow-soft hover:shadow-glow transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
                >
                  {creating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : scheduleMode === "scheduled" ? (
                    <Calendar className="h-4 w-4" />
                  ) : (
                    <Radio className="h-4 w-4" />
                  )}
                  {scheduleMode === "scheduled" ? "Schedule Space" : "Go Live Now"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
