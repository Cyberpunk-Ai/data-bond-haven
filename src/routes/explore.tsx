import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import {
  Flame,
  TrendingUp,
  Users,
  Hash,
  Search,
  X,
  Loader2,
  Sparkles,
  Image as ImageIcon,
  Heart,
  MessageCircle,
  Repeat2,
  ArrowUpRight,
} from "lucide-react";
import { AppShell, Panel, PageHeader } from "@/components/social/AppShell";
import { PostCard } from "@/components/social/PostCard";
import { FeedSkeleton } from "@/components/social/PostSkeleton";
import { FollowButton, RailFooter } from "@/components/social/RightRail";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { compact } from "@/lib/formatters";
import { currentUser, profileRegistry, getProfile } from "@/lib/profile-service";
import type { Post, Profile, Topic, TrendingTag } from "@/lib/types";
import { getPosts, getUsers, globalSearch, getTopics, getTrendingTags } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/explore")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { tag?: string; q?: string; tab?: string } => ({
    tag: search.tag ? String(search.tag) : undefined,
    q: search.q ? String(search.q) : undefined,
    tab: search.tab ? String(search.tab) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Explore — Discover Creators & Topics on Spaces1" },
      {
        name: "description",
        content:
          "Explore trending tags, rising creators, media posts, and the topics moving fastest across Spaces right now.",
      },
      { property: "og:title", content: "Explore — Discover Creators & Topics on Spaces1" },
      {
        property: "og:description",
        content: "Trending tags, rising creators, and the topics moving fastest on Spaces1.",
      },
    ],
  }),
  component: ExplorePage,
});

const filters = ["Top", "People", "Topics", "Media"] as const;

function ExplorePage() {
  const search = Route.useSearch();
  const [filter, setFilter] = useState<(typeof filters)[number]>(() => {
    if (search.tab && filters.includes(search.tab as any)) {
      return search.tab as (typeof filters)[number];
    }
    return "Top";
  });
  const [searchQuery, setSearchQuery] = useState(search.q || "");
  const [debouncedQuery, setDebouncedQuery] = useState(search.q || "");
  const [selectedTag, setSelectedTag] = useState<string | null>(search.tag || null);
  const [allPosts, setAllPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [matchedPeople, setMatchedPeople] = useState<Profile[]>(() => {
    const cached = Object.values(profileRegistry).filter((p) => p.id && p.id !== currentUser.id);
    return cached;
  });
  const [topicList, setTopicList] = useState<Topic[]>([]);
  const [tagsList, setTagsList] = useState<TrendingTag[]>([]);

  // Sync state if search params change
  useEffect(() => {
    if (search.tag !== undefined) {
      setSelectedTag(search.tag || null);
    }
    if (search.q !== undefined) {
      setSearchQuery(search.q || "");
      setDebouncedQuery(search.q || "");
    }
    if (search.tab && filters.includes(search.tab as any)) {
      setFilter(search.tab as (typeof filters)[number]);
    }
  }, [search.tag, search.q, search.tab]);

  useEffect(() => {
    getPosts()
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setAllPosts(data);
      })
      .catch(() => {});

    getUsers()
      .then((res) => {
        if (res?.profiles && res.profiles.length > 0) {
          setMatchedPeople(res.profiles.filter((p) => p.id && p.id !== currentUser.id));
        }
      })
      .catch(() => {});

    getTopics()
      .then((res) => {
        if (res?.topics) setTopicList(res.topics);
      })
      .catch(() => {});

    getTrendingTags()
      .then((res) => {
        if (res?.trendingTags) setTagsList(res.trendingTags);
      })
      .catch(() => {});
  }, []);

  // Debounce user input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const term = debouncedQuery.trim();
    if (!term) {
      // Query cleared: restore the full feed and people list rather than
      // leaving the previous search's results on screen.
      setLoading(true);
      getPosts()
        .then((data) => {
          if (Array.isArray(data)) setAllPosts(data);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
      getUsers()
        .then((res) => {
          if (res?.profiles && res.profiles.length > 0) {
            setMatchedPeople(res.profiles.filter((p) => p.id && p.id !== currentUser.id));
          }
        })
        .catch(() => {});
      return;
    }

    let active = true;
    setLoading(true);
    globalSearch(term)
      .then((results) => {
        if (!active) return;
        if (results.posts) setAllPosts(results.posts);
        if (results.profiles) {
          setMatchedPeople(results.profiles.filter((p) => p.id && p.id !== currentUser.id));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [debouncedQuery]);

  // Client-side quick filter for creators when query changes
  const filteredCreators = useMemo(() => {
    // The profile cache is keyed by both id and username, so the same person can
    // appear twice — dedupe before rendering.
    const seen = new Set<string>();
    const people = matchedPeople.filter((p) => {
      if (!p?.id || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    const q = searchQuery.trim().toLowerCase().replace(/^@/, "");
    if (!q) return people;
    return people.filter(
      (p) =>
        p.username.toLowerCase().includes(q) ||
        p.display_name.toLowerCase().includes(q) ||
        (p.bio && p.bio.toLowerCase().includes(q)),
    );
  }, [matchedPeople, searchQuery]);

  // Filter posts based on search, selected tag, and tab
  const filteredPosts = useMemo(() => {
    return allPosts.filter((p) => {
      if (selectedTag && !p.tags.some((t) => t.toLowerCase() === selectedTag.toLowerCase())) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchContent = p.content.toLowerCase().includes(q);
        const matchTag = p.tags.some((t) => t.toLowerCase().includes(q));
        if (!matchContent && !matchTag) return false;
      }
      if (filter === "Media") {
        return Boolean(p.image_gradient || p.image_url || p.media_url);
      }
      return true;
    });
  }, [allPosts, selectedTag, searchQuery, filter]);

  const sortedTopPosts = useMemo(() => {
    return [...filteredPosts].sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  }, [filteredPosts]);

  const mediaPosts = useMemo(() => {
    return allPosts.filter((p) => {
      const hasMedia = Boolean(p.image_gradient || p.image_url || p.media_url);
      if (!hasMedia) return false;
      if (selectedTag && !p.tags.some((t) => t.toLowerCase() === selectedTag.toLowerCase())) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          p.content.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [allPosts, selectedTag, searchQuery]);

  function handleSelectTopic(topicName: string) {
    setSelectedTag(topicName.toLowerCase());
    setFilter("Top");
  }

  return (
    <AppShell
      title="Explore"
      right={
        <div className="space-y-5">
          <Panel>
            <h2 className="mb-4 flex items-center gap-2 text-lg font-bold">
              <Hash className="h-4 w-4 text-brand" /> All trends
            </h2>
            <ul className="space-y-1">
              {tagsList.map((t, i) => {
                const cleanTag = t.tag.replace("#", "");
                const isSelected = selectedTag === cleanTag;
                return (
                  <li key={t.tag}>
                    <button
                      onClick={() => {
                        setSelectedTag(isSelected ? null : cleanTag);
                        if (!isSelected) setFilter("Top");
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-all cursor-pointer",
                        isSelected
                          ? "bg-brand/15 text-brand font-bold shadow-xs"
                          : "hover:bg-foreground/5 text-foreground",
                      )}
                    >
                      <span className="w-4 text-sm font-bold text-muted-foreground">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold text-sm">{t.tag}</p>
                        <p className="text-xs text-muted-foreground">{t.count}</p>
                      </div>
                      {isSelected && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-brand/20 text-brand">
                          Active
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>
          <RailFooter />
        </div>
      }
    >
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          title="Explore"
          subtitle="What the community is creating and talking about right now."
        />

        {/* Search Bar */}
        <div className="group relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-brand" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search people, topics, tags, and posts..."
            className="glass-panel h-12 w-full rounded-full pl-11 pr-10 text-sm outline-none transition-all duration-300 focus:shadow-soft focus:ring-2 focus:ring-brand/30"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Active Tag Filter Pill */}
        {selectedTag && (
          <div className="flex items-center gap-2 animate-in fade-in">
            <span className="text-xs text-muted-foreground font-medium">Filtering by tag:</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/15 px-3 py-1 text-xs font-bold text-brand shadow-xs">
              #{selectedTag}
              <button
                onClick={() => setSelectedTag(null)}
                className="hover:text-foreground rounded-full p-0.5 hover:bg-brand/20 transition-colors cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
            <button
              onClick={() => setSelectedTag(null)}
              className="text-xs text-muted-foreground hover:underline ml-1 cursor-pointer"
            >
              Clear filter
            </button>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="flex gap-1.5 sm:gap-2 overflow-x-auto pb-1 [scrollbar-width:none] touch-pan-x">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "shrink-0 rounded-full px-4 sm:px-5 py-2 text-xs sm:text-sm font-bold transition-all duration-300 active:scale-95 min-h-[38px] sm:min-h-[42px] flex items-center justify-center cursor-pointer",
                filter === f
                  ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                  : "glass-panel text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "Media" ? (
                <span className="flex items-center gap-1.5">
                  <ImageIcon className="h-3.5 w-3.5" /> Media
                </span>
              ) : f === "Topics" ? (
                <span className="flex items-center gap-1.5">
                  <Flame className="h-3.5 w-3.5" /> Topics
                </span>
              ) : f === "People" ? (
                <span className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> People
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" /> Top
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Topics Section (Render if Top or Topics tab) */}
        {(filter === "Top" || filter === "Topics") && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Flame className="h-4 w-4 text-brand-orange" /> Topics for you
              </h2>
              {filter === "Top" && topicList.length > 3 && (
                <button
                  type="button"
                  onClick={() => setFilter("Topics")}
                  className="text-xs font-bold text-brand hover:underline cursor-pointer"
                >
                  View all ({topicList.length})
                </button>
              )}
            </div>

            <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {(filter === "Top" ? topicList.slice(0, 3) : topicList).map((t, i) => (
                <button
                  key={t.name}
                  onClick={() => handleSelectTopic(t.name)}
                  style={{ animationDelay: `${i * 50}ms` }}
                  className="group animate-in fade-in slide-in-from-bottom-3 relative overflow-hidden rounded-3xl p-5 text-left shadow-soft duration-700 fill-mode-both transition-all hover:-translate-y-1 hover:shadow-lift cursor-pointer"
                >
                  <span
                    className={cn(
                      "absolute inset-0 bg-gradient-to-br transition-transform duration-700 group-hover:scale-110",
                      t.gradient || "from-violet-600 to-indigo-800",
                    )}
                  />
                  <span className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
                  <span className="relative block">
                    <span className="flex items-center justify-between">
                      <span className="text-lg font-bold text-white tracking-tight">{t.name}</span>
                      <ArrowUpRight className="h-4 w-4 text-white/70 group-hover:text-white group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                    </span>
                    <span className="block text-xs font-medium text-white/80 mt-1">
                      {t.posts} active posts
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Creators / People Section (Render if Top or People tab) */}
        {(filter === "Top" || filter === "People") && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Users className="h-4 w-4 text-brand" />{" "}
                {filter === "People" ? "All Creators & Designers" : "Rising creators"}
              </h2>
              {filter === "Top" && filteredCreators.length > 4 && (
                <button
                  type="button"
                  onClick={() => setFilter("People")}
                  className="text-xs font-bold text-brand hover:underline cursor-pointer"
                >
                  View all ({filteredCreators.length})
                </button>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {loading && filteredCreators.length === 0 ? (
                [1, 2, 3, 4].map((n) => (
                  <div key={n} className="glass-panel animate-pulse rounded-3xl p-5 h-36" />
                ))
              ) : filteredCreators.length > 0 ? (
                (filter === "Top" ? filteredCreators.slice(0, 4) : filteredCreators).map((p, i) => (
                  <div
                    key={p.id}
                    style={{ animationDelay: `${i * 50}ms` }}
                    className="glass-panel animate-in fade-in slide-in-from-bottom-3 rounded-3xl p-5 shadow-soft duration-700 fill-mode-both transition-all hover:-translate-y-1 hover:shadow-lift flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start gap-3">
                        <Link
                          to="/profile"
                          search={{ id: p.id, user: p.username }}
                          className="shrink-0 transition-transform hover:scale-105 active:scale-95"
                        >
                          <Avatar
                            name={p.display_name}
                            src={p.avatar_url}
                            className="h-12 w-12 text-sm"
                          />
                        </Link>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 truncate">
                            <Link
                              to="/profile"
                              search={{ id: p.id, user: p.username }}
                              className="truncate font-bold text-foreground hover:text-brand hover:underline transition-colors"
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
                        <FollowButton targetUserId={p.id} />
                      </div>
                      <p className="mt-3 line-clamp-2 text-xs sm:text-sm text-muted-foreground leading-relaxed">
                        {p.bio || "Digital creator & visual explorer on Spaces1"}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="col-span-1 sm:col-span-2 py-8 text-center glass-panel rounded-3xl p-6">
                  <p className="text-sm text-muted-foreground">
                    {searchQuery.trim()
                      ? `No creators found matching "${searchQuery}".`
                      : "No creators found in this category."}
                  </p>
                </div>
              )}

              {filter === "Top" && filteredCreators.length > 4 && (
                <div className="col-span-1 sm:col-span-2 flex justify-center mt-1">
                  <button
                    type="button"
                    onClick={() => setFilter("People")}
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/5 px-6 py-2.5 text-xs font-bold text-brand transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-soft"
                  >
                    View all {filteredCreators.length} creators
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Media Grid Section (Render if Media tab) */}
        {filter === "Media" && (
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <ImageIcon className="h-4 w-4 text-brand-pink" /> Visual & Media stream
            </h2>

            {loading ? (
              <FeedSkeleton />
            ) : mediaPosts.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {mediaPosts.map((p, i) => {
                  const author = getProfile(p.user_id);
                  return (
                    <article
                      key={p.id}
                      style={{ animationDelay: `${i * 60}ms` }}
                      className="glass-panel overflow-hidden rounded-3xl shadow-soft hover:shadow-lift transition-all hover:-translate-y-1 flex flex-col justify-between"
                    >
                      {/* Media Header / Visual */}
                      {p.image_url || p.media_url ? (
                        <div className="relative aspect-video w-full overflow-hidden bg-black/10">
                          <img
                            src={p.image_url || p.media_url || ""}
                            alt={p.content}
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover transition-transform duration-500 hover:scale-105"
                          />
                        </div>
                      ) : p.image_gradient ? (
                        <div
                          className={cn(
                            "relative aspect-video w-full flex items-center justify-center p-6 bg-gradient-to-br text-white text-center font-bold text-base shadow-inner",
                            p.image_gradient,
                          )}
                        >
                          <span className="line-clamp-3">{p.content}</span>
                        </div>
                      ) : null}

                      {/* Card Body */}
                      <div className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Link to="/profile" search={{ id: author.id, user: author.username }}>
                              <Avatar
                                name={author.display_name}
                                src={author.avatar_url}
                                className="h-7 w-7 text-xs"
                              />
                            </Link>
                            <Link
                              to="/profile"
                              search={{ id: author.id, user: author.username }}
                              className="text-xs font-bold text-foreground hover:text-brand truncate"
                            >
                              {author.display_name}
                            </Link>
                          </div>
                          <p className="text-xs text-foreground/90 line-clamp-2">{p.content}</p>
                        </div>

                        {/* Stats footer */}
                        <div className="flex items-center justify-between pt-2 border-t border-border/50 text-[11px] text-muted-foreground font-semibold">
                          <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1">
                              <Heart className="h-3.5 w-3.5 text-rose-500 fill-rose-500/20" />{" "}
                              {compact(p.likeCount || 0)}
                            </span>
                            <span className="flex items-center gap-1">
                              <MessageCircle className="h-3.5 w-3.5 text-brand" />{" "}
                              {compact(p.commentCount || 0)}
                            </span>
                            <span className="flex items-center gap-1">
                              <Repeat2 className="h-3.5 w-3.5 text-emerald-500" />{" "}
                              {compact(p.repostCount || 0)}
                            </span>
                          </div>
                          {p.tags.length > 0 && (
                            <span className="text-brand font-bold truncate max-w-[100px]">
                              #{p.tags[0]}
                            </span>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <Panel className="text-center py-12">
                <ImageIcon className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-60" />
                <p className="font-bold">No media posts found</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Posts with images, video, and gradient banners will appear here.
                </p>
              </Panel>
            )}
          </section>
        )}

        {/* Top Posts Feed (Render if Top tab) */}
        {filter === "Top" && (
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <TrendingUp className="h-4 w-4 text-brand-pink" /> Top posts today
            </h2>
            <div className="space-y-5">
              {loading ? (
                <FeedSkeleton />
              ) : (
                <>
                  {sortedTopPosts.slice(0, 10).map((p, i) => (
                    <PostCard key={p.id} post={p} index={i} />
                  ))}
                  {sortedTopPosts.length === 0 && (
                    <Panel className="text-center py-10">
                      <p className="text-sm text-muted-foreground">
                        No posts matching your criteria.
                      </p>
                    </Panel>
                  )}
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
