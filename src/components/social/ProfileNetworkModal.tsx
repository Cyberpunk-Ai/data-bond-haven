import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { X, Users, Loader2 } from "lucide-react";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { FollowButton } from "@/components/social/RightRail";
import { getProfileNetworkPage, NETWORK_PAGE_SIZE } from "@/lib/api-client";
import { compact } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/types";

interface ProfileNetworkModalProps {
  profileId: string;
  username: string;
  initialView: "followers" | "following";
  /** Authoritative headline numbers from the profiles row, shown on the tabs. */
  counts: { followers: number; following: number };
  viewerId: string | null;
  /** Bumped by the page on follow realtime events so an open list re-reads. */
  refreshNonce?: number;
  onClose: () => void;
}

/**
 * The follower/following rosters, opened from the profile stats instead of a
 * tab. The list is fetched in batches (NETWORK_PAGE_SIZE edges at a time,
 * newest relationship first) so a huge follow graph never ships in one
 * request — "Load more" walks older entries rather than re-fetching the lot.
 */
export function ProfileNetworkModal({
  profileId,
  username,
  initialView,
  counts,
  viewerId,
  refreshNonce = 0,
  onClose,
}: ProfileNetworkModalProps) {
  const [view, setView] = useState<"followers" | "following">(initialView);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [more, setMore] = useState(false);
  const [offset, setOffset] = useState(NETWORK_PAGE_SIZE);

  // First batch (and any re-read after a follow event) restarts the walk.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setProfiles([]);
    setMore(false);
    getProfileNetworkPage(profileId, view, 0)
      .then((res) => {
        if (!alive) return;
        setProfiles(res.profiles);
        setMore(res.more);
        setOffset(NETWORK_PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [profileId, view, refreshNonce]);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getProfileNetworkPage(profileId, view, offset);
      // Dedupe by id: a follow created between batches can shift the offset
      // window and hand back an entry we already rendered.
      setProfiles((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...res.profiles.filter((p) => !seen.has(p.id))];
      });
      setMore(res.more);
      setOffset((o) => o + NETWORK_PAGE_SIZE);
    } catch {
      /* keep the button for another try */
    } finally {
      setLoadingMore(false);
    }
  }

  // Escape closes, matching every other modal on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${username}'s network`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85dvh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-border/60 bg-background shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-3.5">
          <h2 className="truncate text-sm font-extrabold sm:text-base">
            @{username}&rsquo;s network
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="px-5 pt-4">
          <div className="glass-panel flex items-center gap-1 rounded-full p-1">
            {(["followers", "following"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  "flex-1 rounded-full px-3 py-2 text-xs sm:text-sm font-bold capitalize transition-all duration-300 cursor-pointer min-h-[38px]",
                  view === v
                    ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v} · {compact(counts[v] || 0)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="glass-panel animate-pulse rounded-2xl p-3.5 h-[68px]" />
              ))}
            </div>
          ) : profiles.length > 0 ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {profiles.map((p) => (
                  <div
                    key={p.id}
                    className="glass-panel flex items-center gap-3 rounded-2xl p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lift"
                  >
                    <Link
                      to="/profile"
                      search={{ id: p.id, user: p.username }}
                      className="shrink-0 transition-transform hover:scale-105 active:scale-95"
                      onClick={onClose}
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
                          onClick={onClose}
                          className="truncate text-sm font-bold hover:text-brand transition-colors"
                        >
                          {p.display_name}
                        </Link>
                        <UserBadge plan={p.plan} verified={p.verified} size="xs" />
                      </div>
                      <Link
                        to="/profile"
                        search={{ id: p.id, user: p.username }}
                        onClick={onClose}
                        className="block truncate text-xs text-muted-foreground hover:text-brand transition-colors"
                      >
                        @{p.username}
                      </Link>
                    </div>
                    {p.id !== viewerId && <FollowButton targetUserId={p.id} />}
                  </div>
                ))}
              </div>

              {/* Next batch — only offered while the last page came back full. */}
              {more && (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="mx-auto flex cursor-pointer items-center gap-2 rounded-full border border-border/60 px-5 py-2.5 text-xs font-bold text-muted-foreground transition-colors hover:border-brand/50 hover:text-foreground disabled:opacity-60"
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                    </>
                  ) : (
                    `Load ${NETWORK_PAGE_SIZE} more`
                  )}
                </button>
              )}
            </div>
          ) : (
            <div className="py-10 text-center">
              <Users className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-60" />
              <p className="font-bold">No {view === "followers" ? "followers" : "following"} yet</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                {view === "followers"
                  ? `@${username} has no followers yet.`
                  : `@${username} isn't following anyone yet.`}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
