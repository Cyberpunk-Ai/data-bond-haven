import { createFileRoute, Link } from "@tanstack/react-router";
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
  Sparkles,
  Check,
} from "lucide-react";
import { AppShell, Panel, PageHeader } from "@/components/social/AppShell";
import { RailFooter } from "@/components/social/RightRail";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { SpaceRoomModal } from "@/components/social/SpaceRoomModal";
import { Skeleton } from "@/components/ui/skeleton";
import { compact } from "@/lib/formatters";

function SpacesSkeleton() {
  return (
    <div className="grid gap-5">
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
import { getProfile } from "@/lib/profile-service";
import type { Space } from "@/lib/types";
import { getSpaces, createSpace } from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/spaces")({
  validateSearch: (search: Record<string, unknown>): { spaceId?: string } => ({
    spaceId: search.spaceId ? String(search.spaceId) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Live Audio Rooms — Spaces1" },
      {
        name: "description",
        content:
          "Join live audio Spaces: design clinics, photography workshops, and creator conversations happening right now.",
      },
      { property: "og:title", content: "Live Audio Rooms — Spaces1" },
      {
        property: "og:description",
        content: "Live audio rooms for creators: join, listen, or host your own Space.",
      },
    ],
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
}: {
  space: Space;
  index: number;
  onJoin: (space: Space) => void;
  onRemind: (spaceId: string) => void;
  isReminded: boolean;
  [key: string]: any;
}) {
  const host = getProfile(space.host_id);
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

  const isRecorded = Boolean(space.recorded || (!space.live && !space.startsIn));

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
                ? `${compact(space.listeners || 42)} replays`
                : "Reminder available"}
          </p>
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
    </article>
  );
}

const tabs = ["Live now", "Upcoming", "Recorded"] as const;

function SpacesPage() {
  const search = Route.useSearch();
  const { currentPlan, planDetails, isPro, isUltra } = usePlan();
  const [tab, setTab] = useState<(typeof tabs)[number]>("Live now");
  const [allSpaces, setAllSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSpace, setActiveSpace] = useState<Space | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [reminders, setReminders] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");

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

  useEffect(() => {
    setLoading(true);
    getSpaces()
      .then((data) => {
        if (data?.spaces && data.spaces.length > 0) setAllSpaces(data.spaces);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Keep the list in sync as rooms open, fill up and close
  useRealtime(
    (event: any) => {
      if (event.type === "space:created" && event.space?.id) {
        setAllSpaces((prev) =>
          prev.some((s) => s.id === event.space.id) ? prev : [event.space, ...prev],
        );
      } else if (event.type === "space:ended" && event.spaceId) {
        setAllSpaces((prev) =>
          prev.map((s) => (s.id === event.spaceId ? { ...s, live: false, listeners: 0 } : s)),
        );
        setActiveSpace((cur) => (cur && cur.id === event.spaceId ? null : cur));
      } else if (event.type === "space:listeners" && event.spaceId) {
        setAllSpaces((prev) =>
          prev.map((s) => (s.id === event.spaceId ? { ...s, listeners: event.listeners } : s)),
        );
      }
    },
    ["space:created", "space:ended", "space:listeners"],
  );

  // Auto-open space if spaceId is provided in URL
  // Open only once per link; list refreshes must not reopen a closed room.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!search.spaceId || autoOpened.current === search.spaceId || allSpaces.length === 0) return;
    const found = allSpaces.find((s) => s.id === search.spaceId);
    if (found) {
      autoOpened.current = search.spaceId;
      setActiveSpace((cur) => (cur?.id === found.id ? cur : found));
    }
  }, [search.spaceId, allSpaces]);

  function handleRemind(spaceId: string) {
    setReminders((prev) => {
      const next = !prev[spaceId];
      toast(
        next ? "Reminder set! We'll notify you when this Space goes live." : "Reminder removed",
      );
      return { ...prev, [spaceId]: next };
    });
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
        topic: topicDraft,
        gradient: gradientDraft,
        live: !isScheduled,
        startsAt: isScheduled ? new Date(`${scheduledDate}T${scheduledTime}`).toISOString() : null,
      });

      const newSpace: Space = {
        ...res.space,
        live: !isScheduled,
        startsIn: isScheduled ? startsInText : undefined,
      };

      setAllSpaces((prev) => [newSpace, ...prev]);
      setShowCreateModal(false);
      setTitleDraft("");

      if (isScheduled) {
        toast.success(`Space scheduled for ${startsInText}! Added to your Upcoming calendar.`);
        setTab("Upcoming");
      } else {
        toast.success("Space created! You are now live.");
        setActiveSpace(newSpace);
      }
    } catch (err: any) {
      toast.error("Failed to create Space: " + (err.message || "Error"));
    } finally {
      setCreating(false);
    }
  }

  const isRecordedSpace = (s: (typeof allSpaces)[number]) =>
    Boolean(s.recorded || (!s.live && !s.startsIn));

  const filtered = allSpaces.filter((s) => {
    if (tab === "Live now" && !s.live) return false;
    if (tab === "Upcoming" && (s.live || isRecordedSpace(s))) return false;
    if (tab === "Recorded" && !isRecordedSpace(s)) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return s.title.toLowerCase().includes(q) || s.topic.toLowerCase().includes(q);
    }
    return true;
  });

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
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-brand to-brand-pink py-3 text-sm font-bold text-white transition-all duration-300 hover:shadow-glow active:scale-[0.98]"
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
              className="flex items-center gap-2 rounded-full bg-gradient-to-r from-brand to-brand-pink px-5 py-2.5 text-sm font-bold text-white transition-all duration-300 hover:shadow-glow active:scale-95"
            >
              <Radio className="h-4 w-4" /> Go live
            </button>
          }
        />

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
                  onJoin={(sp) => setActiveSpace(sp)}
                  onRemind={handleRemind}
                  isReminded={Boolean(reminders[s.id])}
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

      {/* Create Space Dialog */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 sm:p-4 animate-in fade-in duration-200">
          <div
            className="glass-panel relative w-full max-w-md max-h-[92vh] overflow-y-auto rounded-2xl sm:rounded-3xl p-5 sm:p-6 shadow-2xl border border-border/80 bg-card/95"
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
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                  Topic / Category
                </label>
                <select
                  value={topicDraft}
                  onChange={(e) => setTopicDraft(e.target.value)}
                  className="w-full rounded-2xl bg-foreground/5 px-4 py-2.5 text-sm outline-none border border-transparent focus:border-brand/40 cursor-pointer"
                >
                  <option value="Design & Craft">Design & Craft</option>
                  <option value="AI & Generative">AI & Generative</option>
                  <option value="Photography">Photography</option>
                  <option value="Product & Tech">Product & Tech</option>
                  <option value="Sound Design">Sound Design</option>
                  <option value="Open Mic">Open Mic</option>
                </select>
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
