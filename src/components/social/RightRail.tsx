import { useCurrentUserId } from "@/hooks/useCurrentUserId";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Search, TrendingUp, Radio, Plus, Check } from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { Panel } from "@/components/social/AppShell";
import { InfoModal } from "@/components/social/InfoModal";
import { compact } from "@/lib/formatters";
import { currentUserId } from "@/lib/profile-service";
import type { Profile, Space, TrendingTag } from "@/lib/types";
import {
  toggleFollowUser,
  isFollowing,
  getTrendingTags,
  getUsers,
  getSpaces,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export function SearchBox({ placeholder = "Search Spaces" }: { placeholder?: string }) {
  const [val, setVal] = useState("");
  const navigate = useNavigate();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (val.trim()) {
      navigate({ to: "/explore", search: { q: val.trim() } });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="group relative">
      <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-brand" />
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={placeholder}
        className="glass-panel h-12 w-full rounded-full pl-11 pr-4 text-sm outline-none transition-all duration-300 focus:shadow-soft focus:ring-2 focus:ring-brand/30"
      />
    </form>
  );
}

export function FollowButton({
  initial = false,
  targetUserId,
}: {
  initial?: boolean;
  targetUserId?: string;
}) {
  const [following, setFollowing] = useState(initial);
  const [loading, setLoading] = useState(false);
  const viewerId = useCurrentUserId();

  // Read the saved follow state so it survives a refresh (re-run once sign-in is known).
  useEffect(() => {
    if (!targetUserId || viewerId === "guest") return;
    let alive = true;
    isFollowing(targetUserId)
      .then((v) => alive && setFollowing(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [targetUserId, viewerId]);

  async function handleToggle() {
    if (!targetUserId || loading) return;
    const prev = following;
    setFollowing(!prev);
    setLoading(true);
    try {
      const res = await toggleFollowUser(targetUserId);
      setFollowing(res.following);
    } catch (err: any) {
      setFollowing(prev);
      toast.error(err?.message || "Couldn't update follow. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition-all duration-300 active:scale-95",
        following
          ? "bg-foreground/5 text-muted-foreground hover:bg-foreground/10"
          : "bg-gradient-to-r from-brand to-brand-pink text-white hover:shadow-glow",
      )}
    >
      {following ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
      {following ? "Following" : "Follow"}
    </button>
  );
}

export function TrendingPanel() {
  const [tags, setTags] = useState<TrendingTag[]>([]);

  useEffect(() => {
    getTrendingTags()
      .then((res) => {
        if (res?.trendingTags && res.trendingTags.length > 0) {
          setTags(res.trendingTags);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <Panel>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <TrendingUp className="h-4 w-4 text-brand" /> Trending now
        </h2>
        <Link
          to="/explore"
          className="text-xs font-bold text-brand hover:underline hover:text-brand-pink transition-colors"
        >
          View More
        </Link>
      </div>
      <ul className="space-y-1">
        {tags.slice(0, 4).map((t) => {
          const cleanTag = t.tag.replace(/^#/, "");
          return (
            <li key={t.tag}>
              <Link
                to="/explore"
                search={{ tag: cleanTag }}
                className="group block rounded-2xl px-3 py-2 transition-colors duration-300 hover:bg-foreground/5"
              >
                <p className="text-[11px] text-muted-foreground">{t.category}</p>
                <p className="font-bold text-sm group-hover:text-brand transition-colors">
                  #{cleanTag}
                </p>
                <p className="text-[11px] text-muted-foreground">{t.count}</p>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 pt-2 border-t border-border/40 text-center">
        <Link
          to="/explore"
          className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          See all trending topics →
        </Link>
      </div>
    </Panel>
  );
}

export function SuggestionsPanel() {
  const [people, setPeople] = useState<Profile[]>([]);

  useEffect(() => {
    getUsers()
      .then((res) => {
        if (res?.profiles && res.profiles.length > 0) {
          const seen = new Set<string>();
          const unique = res.profiles.filter((p) => {
            if (!p?.id || p.id === currentUserId || seen.has(p.id)) return false;
            seen.add(p.id);
            return true;
          });
          setPeople(unique.slice(0, 4));
        }
      })
      .catch(() => {});
  }, []);

  return (
    <Panel>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold">Who to follow</h2>
        <Link
          to="/explore"
          className="text-xs font-bold text-brand hover:underline hover:text-brand-pink transition-colors"
        >
          View More
        </Link>
      </div>
      <ul className="space-y-3">
        {people.slice(0, 4).map((p, idx) => (
          <li key={`who-to-follow-${p.id}-${idx}`} className="flex items-center gap-3">
            <Link
              to="/profile"
              search={{ id: p.id, user: p.username }}
              className="shrink-0 transition-transform duration-200 hover:scale-105 active:scale-95"
            >
              <Avatar name={p.display_name} src={p.avatar_url} className="h-10 w-10 text-xs" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate">
                <Link
                  to="/profile"
                  search={{ id: p.id, user: p.username }}
                  className="truncate text-sm font-bold hover:text-brand hover:underline transition-colors"
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
                @{p.username} · {compact(p.followers)} followers
              </Link>
            </div>
            <FollowButton targetUserId={p.id} />
          </li>
        ))}
      </ul>
      <div className="mt-3 pt-2 border-t border-border/40 text-center">
        <Link
          to="/explore"
          className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          Discover more creators →
        </Link>
      </div>
    </Panel>
  );
}

export function LiveSpacesPanel() {
  const [live, setLive] = useState<Space[]>([]);

  useEffect(() => {
    getSpaces()
      .then((res) => {
        if (res?.spaces && res.spaces.length > 0) {
          setLive(res.spaces.filter((s) => s.live));
        }
      })
      .catch(() => {});
  }, []);

  return (
    <Panel>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
          </span>
          Live Spaces
        </h2>
        <Link
          to="/spaces"
          className="text-xs font-bold text-brand hover:underline hover:text-brand-pink transition-colors"
        >
          View More
        </Link>
      </div>
      <ul className="space-y-2.5">
        {live.slice(0, 4).map((s) => (
          <li key={s.id}>
            <Link
              to="/spaces"
              search={{ spaceId: s.id }}
              className="group block overflow-hidden rounded-2xl p-2.5 transition-colors duration-300 hover:bg-foreground/5"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white group-hover:scale-105 transition-transform",
                    s.gradient,
                  )}
                >
                  <Radio className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-xs sm:text-sm font-semibold leading-snug group-hover:text-brand transition-colors">
                    {s.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                    {compact(s.listeners)} listening
                  </p>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-3 pt-2 border-t border-border/40 text-center">
        <Link
          to="/spaces"
          className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          Explore all audio rooms →
        </Link>
      </div>
    </Panel>
  );
}

export function RailFooter() {
  const links = ["About", "Help", "Privacy", "Terms", "Guidelines", "Status"];
  const [selectedInfo, setSelectedInfo] = useState<string | null>(null);

  return (
    <>
      <p className="px-4 text-xs leading-relaxed text-muted-foreground">
        {links.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setSelectedInfo(l)}
            className="mr-2 cursor-pointer transition-colors hover:text-brand bg-transparent border-0 p-0 text-xs text-muted-foreground"
          >
            {l}
          </button>
        ))}
        <span className="mt-2 block">© 2026 Spaces1</span>
      </p>

      <InfoModal
        type={selectedInfo}
        isOpen={Boolean(selectedInfo)}
        onClose={() => setSelectedInfo(null)}
      />
    </>
  );
}

export function DefaultRail() {
  return (
    <div className="space-y-5">
      <SearchBox />
      <TrendingPanel />
      <LiveSpacesPanel />
      <SuggestionsPanel />
      <RailFooter />
    </div>
  );
}
