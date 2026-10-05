import { createFileRoute, Link } from "@tanstack/react-router";
import { canonicalLink, ogUrlMeta, ORG_NAME } from "@/lib/seo";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Flame,
  TrendingUp,
  Users,
  Search,
  X,
  Loader2,
  Image as ImageIcon,
  Heart,
  MessageCircle,
  Repeat2,
  ArrowUpRight,
  Play,
} from "lucide-react";
import { AppShell, Panel, PageHeader } from "@/components/social/AppShell";
import { PostCard } from "@/components/social/PostCard";
import { FeedSkeleton } from "@/components/social/PostSkeleton";
import { FollowButton, DefaultRail } from "@/components/social/RightRail";
import { Avatar } from "@/components/social/Avatar";
import { UserBadge } from "@/components/social/UserBadge";
import { compact } from "@/lib/formatters";
import { currentUser, profileRegistry, getProfile } from "@/lib/profile-service";
import type { Post, Profile, Topic } from "@/lib/types";
import { getPostsPage, getCreatorsPage, globalSearch, getTopics } from "@/lib/api-client";
import { getWhoToFollow } from "@/lib/recommendations.functions";
import { cn, withTimeout, PAGE_REQUEST_TIMEOUT_MS, isVideoUrl, firstMediaUrl } from "@/lib/utils";

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
      { title: `Explore — Discover Creators & Topics on ${ORG_NAME}` },
      {
        name: "description",
        content:
          "Explore trending tags, rising creators, media posts, and the topics moving fastest across Spaces right now.",
      },
      { property: "og:title", content: `Explore — Discover Creators & Topics on ${ORG_NAME}` },
      {
        property: "og:description",
        content: `Trending tags, rising creators, and the topics moving fastest on ${ORG_NAME}.`,
      },
      // Every `?q=`/filter variant rolls up here on purpose: the result list is
      // rendered client-side from the same endpoint, so a parameterised copy is a
      // duplicate, not a page. This is also the URL the WebSite SearchAction in
      // `index.tsx` points at.
      ogUrlMeta("/explore"),
    ],
    links: [canonicalLink("/explore")],
  }),
  component: ExplorePage,
});

const filters = ["Top", "People", "Topics", "Media"] as const;

// Chunk sizes: one small page is fetched/rendered at a time — the wide 100-row
// pulls used to dominate explore's payload for lists that show 10-12 rows.
const EXPLORE_POSTS_CHUNK = 30;
const EXPLORE_TOP_STEP = 10;
const EXPLORE_PEOPLE_CHUNK = 12;
// Topics arrive one page at a time now — the full trending-tag set can be large,
// so the Topics tab renders a bounded first batch and reveals more on demand.
const TOPICS_STEP = 12;
// "All trends" rail reuses the SAME bounded count as the feed right rail (the
// shared TRENDING_RAIL_LIMIT from RightRail) so the teaser list is consistent
// everywhere; "View more topics" leads to the full paginated topic set.

// A grid video that previews itself without a click: it autoplays (muted, so
// browsers permit it) while ~60% visible and pauses when scrolled away, mirroring
// ModernVideoPlayer's viewport rule so off-screen tiles don't keep decoding.
// The wrapping <Link> stays intact — tapping still opens the full post.
function VideoPreviewTile({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.6 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [src]);
  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      loop
      autoPlay
      preload="metadata"
      className="h-full w-full object-cover"
    />
  );
}

function ExplorePage() {
  const search = Route.useSearch();
  const [filter, setFilter] = useState<(typeof filters)[number]>(() => {
    if (search.tab && (filters as readonly string[]).includes(search.tab)) {
      return search.tab as (typeof filters)[number];
    }
    return "Top";
  });
  const [searchQuery, setSearchQuery] = useState(search.q || "");
  const [debouncedQuery, setDebouncedQuery] = useState(search.q || "");
  const [selectedTag, setSelectedTag] = useState<string | null>(search.tag || null);
  const [allPosts, setAllPosts] = useState<Post[]>([]);
  // Load-first so the initial paint keeps the skeleton instead of flashing an
  // empty result set before the fetch effects resolve.
  const [loading, setLoading] = useState(true);
  const [matchedPeople, setMatchedPeople] = useState<Profile[]>(() => {
    const cached = Object.values(profileRegistry).filter((p) => p.id && p.id !== currentUser.id);
    return cached;
  });
  const [topicList, setTopicList] = useState<Topic[]>([]);
  // Topics/creators arrive asynchronously; these drive a calm skeleton so
  // shifting between the tabs (and the users behind them) settles in rather
  // than flashing an empty grid before the fetch lands.
  const [topicsLoading, setTopicsLoading] = useState(true);
  const [peopleLoading, setPeopleLoading] = useState(true);
  // Topics paging: how many exist in total and whether the next page is loading.
  const [topicsTotal, setTopicsTotal] = useState(0);
  const [loadingMoreTopics, setLoadingMoreTopics] = useState(false);
  // Progressive-reveal counters + the post cursor for "load more" chunks.
  const [topVisible, setTopVisible] = useState(EXPLORE_TOP_STEP);
  const [peopleVisible, setPeopleVisible] = useState(EXPLORE_PEOPLE_CHUNK);
  const [mediaVisible, setMediaVisible] = useState(EXPLORE_PEOPLE_CHUNK);
  const [postsCursor, setPostsCursor] = useState<string | null>(null);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const [loadingMorePeople, setLoadingMorePeople] = useState(false);
  const [peopleExhausted, setPeopleExhausted] = useState(false);
  // How far we have walked the creator directory (independent of the ranker's
  // list, which only seeds the first chunk).
  const peopleWalkRef = useRef(0);

  // Sync state if search params change
  useEffect(() => {
    if (search.tag !== undefined) {
      setSelectedTag(search.tag || null);
    }
    if (search.q !== undefined) {
      setSearchQuery(search.q || "");
      setDebouncedQuery(search.q || "");
    }
    if (search.tab && (filters as readonly string[]).includes(search.tab)) {
      setFilter(search.tab as (typeof filters)[number]);
    }
  }, [search.tag, search.q, search.tab]);

  // Signed-in visitors get the personalised "who to follow" ranker (same
  // affinity/graph/interest signals that drive the For-you feed); guests and
  // any ranker failure fall back to the plain creator directory. Both paths
  // load ONE chunk; "Load more creators" walks the directory from here.
  function loadPeople(isActive?: () => boolean) {
    const ok = () => !isActive || isActive();
    setPeopleLoading(true);
    const apply = (profiles: Profile[]) => {
      if (!ok()) return;
      setMatchedPeople(profiles.filter((p) => p.id && p.id !== currentUser.id));
      setPeopleVisible(EXPLORE_PEOPLE_CHUNK);
      setPeopleExhausted(false);
      peopleWalkRef.current = 0;
    };
    const clear = () => {
      if (ok()) setPeopleLoading(false);
    };
    const fromDirectory = () =>
      getCreatorsPage({ limit: EXPLORE_PEOPLE_CHUNK * 2 }).then((profiles) => {
        if (ok() && profiles.length > 0) apply(profiles);
      });
    // Personalised ranker for signed-in visitors, directory for guests; either
    // way the terminal `finally` clears the skeleton, so a failure can never
    // strand a loading state.
    const chain =
      currentUser.id && currentUser.id !== "guest"
        ? getWhoToFollow({ data: { limit: EXPLORE_PEOPLE_CHUNK * 2 } })
            .then((res) => {
              const list = ((res?.profiles ?? []) as Profile[]).filter((p) => p?.id);
              if (list.length) {
                if (ok()) apply(list);
                return;
              }
              return fromDirectory();
            })
            .catch(fromDirectory)
        : fromDirectory();
    Promise.resolve(chain)
      .catch(() => {})
      .finally(clear);
  }

  // Walks the directory one small page at a time, skipping rows already in the
  // list (the ranker's first chunk overlaps the directory). Stops when the
  // server hands back a short page — the directory is exhausted.
  async function loadMoreCreators() {
    setLoadingMorePeople(true);
    try {
      const existing = new Set(matchedPeople.map((p) => p.id));
      const fresh: Profile[] = [];
      for (let guard = 0; guard < 3 && fresh.length < EXPLORE_PEOPLE_CHUNK; guard++) {
        const chunk = await withTimeout(
          getCreatorsPage({ limit: EXPLORE_PEOPLE_CHUNK, offset: peopleWalkRef.current }),
          PAGE_REQUEST_TIMEOUT_MS,
        );
        peopleWalkRef.current += chunk.length;
        for (const p of chunk) {
          if (!p.id || p.id === currentUser.id || existing.has(p.id)) continue;
          if (fresh.some((f) => f.id === p.id)) continue;
          existing.add(p.id);
          fresh.push(p);
        }
        if (chunk.length < EXPLORE_PEOPLE_CHUNK) break;
      }
      // "Exhausted" only means something after a *successful* short walk. A
      // failed or timed-out request used to set it too, hiding the button and
      // silently ending the directory weeks of creators early.
      if (fresh.length === 0) setPeopleExhausted(true);
      else setMatchedPeople((prev) => [...prev, ...fresh]);
      setPeopleVisible((v) => v + EXPLORE_PEOPLE_CHUNK);
    } catch (err) {
      console.warn("Load more creators failed:", err);
    } finally {
      setLoadingMorePeople(false);
    }
  }

  useEffect(() => {
    // No post fetch here: the query/tag effect below runs on mount too and
    // used to make this a duplicate 100-row request on every page view.
    loadPeople();

    getTopics({ limit: TOPICS_STEP, offset: 0 })
      .then((res) => {
        if (res?.topics) {
          setTopicList(res.topics);
          setTopicsTotal(res.total ?? res.topics.length);
        }
      })
      .catch(() => {})
      .finally(() => setTopicsLoading(false));
  }, []);

  // Reveal the next page of topics and append it, deduping by name in case the
  // bounded trending set shifted between calls.
  async function loadMoreTopics() {
    if (loadingMoreTopics) return;
    setLoadingMoreTopics(true);
    try {
      const res = await getTopics({ limit: TOPICS_STEP, offset: topicList.length });
      if (res?.topics?.length) {
        setTopicList((prev) => {
          const seen = new Set(prev.map((t) => t.name));
          return [...prev, ...res.topics.filter((t) => !seen.has(t.name))];
        });
      }
      setTopicsTotal(res.total ?? topicsTotal);
    } catch (err) {
      console.warn("Load more topics failed:", err);
    } finally {
      setLoadingMoreTopics(false);
    }
  }

  // Debounce user input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const term = debouncedQuery.trim();
    let active = true;
    setLoading(true);
    setTopVisible(EXPLORE_TOP_STEP);
    setMediaVisible(EXPLORE_PEOPLE_CHUNK);

    // Free-text search wins: pull matching posts/people from the server.
    if (term) {
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
    }

    // No query: load the selected tag's posts from the server (so clicking a
    // trend/topic opens the relevant results, not just the cached feed), or the
    // first feed chunk when nothing is selected. Older pages come via the
    // "Show more" cursor instead of an up-front 100-row pull.
    getPostsPage({ limit: EXPLORE_POSTS_CHUNK, tag: selectedTag ?? undefined })
      .then((page) => {
        if (!active) return;
        if (page.posts.length > 0) setAllPosts(page.posts);
        setPostsCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    loadPeople(() => active);
    return () => {
      active = false;
    };
  }, [debouncedQuery, selectedTag]);

  // "Show more" for the ranked Top list: reveal the next slice from the pool
  // we already hold, and only hit the server when the pool runs dry.
  async function loadMoreTopPosts() {
    if (sortedTopPosts.length > topVisible) {
      setTopVisible((v) => v + EXPLORE_TOP_STEP);
      return;
    }
    if (!postsCursor || loadingMorePosts) return;
    setLoadingMorePosts(true);
    try {
      const page = await withTimeout(
        getPostsPage({
          limit: EXPLORE_POSTS_CHUNK,
          tag: selectedTag ?? undefined,
          before: postsCursor ?? undefined,
        }),
        PAGE_REQUEST_TIMEOUT_MS,
      );
      if (page.posts.length)
        setAllPosts((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...page.posts.filter((p) => !seen.has(p.id))];
        });
      setPostsCursor(page.nextCursor);
      setTopVisible((v) => v + EXPLORE_TOP_STEP);
    } catch (err) {
      // Keep the cursor — a blip should not end the "Show more" trail.
      console.warn("Load more top posts failed:", err);
    } finally {
      setLoadingMorePosts(false);
    }
  }

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
    // Hot board: weighted engagement cooled by age, so "Top" surfaces what is
    // trending now instead of mirroring the newest page or raw like totals
    // (a 3-week-old post with 500 likes loses to today's 80-like breakout).
    const now = Date.now();
    const hotScore = (p: Post) => {
      const ageHours = Math.max(0.25, (now - new Date(p.created_at).getTime()) / 3_600_000);
      const engagement =
        (p.likeCount ?? 0) * 3 + (p.commentCount ?? 0) * 4 + (p.repostCount ?? 0) * 5;
      return (engagement + 5) / Math.pow(ageHours, 0.6);
    };
    return [...filteredPosts].sort(
      (a, b) => hotScore(b) - hotScore(a) || (b.likeCount ?? 0) - (a.likeCount ?? 0),
    );
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
    // Topic cards show "#tag" but posts store bare tags — strip the "#" so the
    // server `contains(tags, [tag])` filter actually matches.
    const clean = topicName.replace(/^#/, "").trim().toLowerCase();
    setSelectedTag(clean);
    setFilter("Top");
  }

  return (
    <AppShell title="Explore" right={<DefaultRail />}>
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
                  View all
                </button>
              )}
            </div>

            <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {topicsLoading && topicList.length === 0
                ? [1, 2, 3].map((n) => (
                    <div key={n} className="animate-pulse rounded-3xl bg-foreground/10 h-[104px]" />
                  ))
                : (filter === "Top" ? topicList.slice(0, 3) : topicList).map((t, i) => (
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
                          <span className="text-lg font-bold text-white tracking-tight">
                            {t.name}
                          </span>
                          <ArrowUpRight className="h-4 w-4 text-white/70 group-hover:text-white group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                        </span>
                        <span className="block text-xs font-medium text-white/80 mt-1">
                          {t.posts} active posts
                        </span>
                      </span>
                    </button>
                  ))}
            </div>

            {/* Topics tab pages through the trending set; Top keeps the 3-preview. */}
            {filter === "Topics" && topicList.length < topicsTotal && (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  disabled={loadingMoreTopics}
                  onClick={() => void loadMoreTopics()}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/5 px-6 py-2.5 text-xs font-bold text-brand transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-soft disabled:opacity-60 disabled:hover:scale-100"
                >
                  {loadingMoreTopics ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Flame className="h-3.5 w-3.5" />
                  )}
                  Load more topics
                </button>
              </div>
            )}
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
                  View all creators
                </button>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {(loading || peopleLoading) && filteredCreators.length === 0 ? (
                [1, 2, 3, 4].map((n) => (
                  <div key={n} className="glass-panel animate-pulse rounded-3xl p-5 h-36" />
                ))
              ) : filteredCreators.length > 0 ? (
                (filter === "Top"
                  ? filteredCreators.slice(0, 4)
                  : filteredCreators.slice(0, peopleVisible)
                ).map((p, i) => (
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
                        {p.bio || `Digital creator & visual explorer on ${ORG_NAME}`}
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
                    View all creators
                  </button>
                </div>
              )}

              {/* People tab: the directory arrives one chunk at a time. */}
              {filter === "People" && !peopleExhausted && filteredCreators.length > 0 && (
                <div className="col-span-1 sm:col-span-2 flex justify-center mt-1">
                  <button
                    type="button"
                    disabled={loadingMorePeople}
                    onClick={() => void loadMoreCreators()}
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/5 px-6 py-2.5 text-xs font-bold text-brand transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-soft disabled:opacity-60 disabled:hover:scale-100"
                  >
                    {loadingMorePeople ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Users className="h-3.5 w-3.5" />
                    )}
                    Load more creators
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
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {mediaPosts.slice(0, mediaVisible).map((p, i) => {
                    const author = getProfile(p.user_id);
                    // media_url can hold several comma-joined attachments — the
                    // thumbnail uses the first, and we must know whether that
                    // first is a video so it previews instead of rendering a
                    // broken <img src="....mp4">.
                    const thumbSrc = firstMediaUrl(p.image_url || p.media_url);
                    const isVideo =
                      isVideoUrl(thumbSrc) ||
                      (p as unknown as { media_type?: string }).media_type === "video";
                    return (
                      <article
                        key={p.id}
                        style={{ animationDelay: `${i * 60}ms` }}
                        className="glass-panel overflow-hidden rounded-3xl shadow-soft hover:shadow-lift transition-all hover:-translate-y-1 flex flex-col justify-between"
                      >
                        {/* Media Header / Visual — clickable, opens the actual post */}
                        <Link
                          to="/post/$id"
                          params={{ id: p.id }}
                          aria-label="Open post"
                          className="group/media relative block"
                        >
                          {thumbSrc ? (
                            <div className="relative aspect-video w-full overflow-hidden bg-black/10">
                              {isVideo ? (
                                <>
                                  <VideoPreviewTile src={thumbSrc} />
                                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10">
                                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 ring-1 ring-white/30 backdrop-blur-sm transition-transform duration-300 group-hover/media:scale-110">
                                      <Play className="h-5 w-5 translate-x-[1px] fill-white text-white" />
                                    </span>
                                  </span>
                                </>
                              ) : (
                                <img
                                  src={thumbSrc}
                                  alt={p.content}
                                  loading="lazy"
                                  decoding="async"
                                  className="h-full w-full object-cover transition-transform duration-500 group-hover/media:scale-105"
                                />
                              )}
                            </div>
                          ) : p.image_gradient ? (
                            <div
                              className={cn(
                                "relative aspect-video w-full flex items-center justify-center p-6 bg-gradient-to-br text-white text-center font-bold text-base shadow-inner transition-transform duration-500 group-hover/media:scale-[1.02]",
                                p.image_gradient,
                              )}
                            >
                              <span className="line-clamp-3">{p.content}</span>
                            </div>
                          ) : null}
                        </Link>

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
                            <Link
                              to="/post/$id"
                              params={{ id: p.id }}
                              className="text-xs text-foreground/90 line-clamp-2 hover:text-brand transition-colors"
                            >
                              {p.content}
                            </Link>
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
                {mediaVisible < mediaPosts.length && (
                  <div className="flex justify-center mt-1">
                    <button
                      type="button"
                      onClick={() => setMediaVisible((v) => v + EXPLORE_PEOPLE_CHUNK)}
                      className="inline-flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/5 px-6 py-2.5 text-xs font-bold text-brand transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-soft"
                    >
                      <ImageIcon className="h-3.5 w-3.5" /> Load more media
                    </button>
                  </div>
                )}
              </>
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
                  {/* Top tab reveals 10 posts per tap; the server is only asked
                   for a fresh chunk once the loaded pool runs out. */}
                  {sortedTopPosts.slice(0, topVisible).map((p, i) => (
                    <PostCard key={p.id} post={p} index={i} />
                  ))}
                  {sortedTopPosts.length === 0 && (
                    <Panel className="text-center py-10">
                      <p className="text-sm text-muted-foreground">
                        No posts matching your criteria.
                      </p>
                    </Panel>
                  )}
                  {(topVisible < sortedTopPosts.length || postsCursor) && (
                    <div className="flex justify-center pt-1">
                      <button
                        type="button"
                        disabled={loadingMorePosts}
                        onClick={() => void loadMoreTopPosts()}
                        className="inline-flex items-center gap-2 rounded-full border border-border bg-card hover:bg-foreground/5 px-6 py-2.5 text-xs font-bold text-brand transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-soft disabled:opacity-60 disabled:hover:scale-100"
                      >
                        {loadingMorePosts ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <TrendingUp className="h-3.5 w-3.5" />
                        )}
                        Show more top posts
                      </button>
                    </div>
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
