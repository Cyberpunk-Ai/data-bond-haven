import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Bookmark, Search, X } from "lucide-react";
import { AppShell, PageHeader, Panel } from "@/components/social/AppShell";
import { PostCard } from "@/components/social/PostCard";
import { FeedSkeleton } from "@/components/social/PostSkeleton";
import { DefaultRail } from "@/components/social/RightRail";
import type { Post } from "@/lib/types";
import { getProfile } from "@/lib/profile-service";
import { getBookmarks, getPosts } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/bookmarks")({
  head: () => ({
    meta: [
      { title: "Bookmarks — Spaces1" },
      {
        name: "description",
        content:
          "Your saved posts on Spaces1. Keep the essays, frames and threads worth returning to in one private, searchable collection.",
      },
      { property: "og:title", content: "Bookmarks — Spaces1" },
      {
        property: "og:description",
        content: "A private collection of the posts you saved on Spaces1.",
      },
    ],
  }),
  component: BookmarksPage,
});

const collections = ["All saves", "Design", "Reading", "Inspiration", "Generative AI"] as const;

function BookmarksPage() {
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState<(typeof collections)[number]>("All saves");
  const [allPosts, setAllPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  function fetchBookmarksList() {
    setLoading(true);
    getBookmarks()
      .then((data) => {
        setAllPosts(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        console.warn("Failed to fetch bookmarks:", err);
        setAllPosts([]);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchBookmarksList();
  }, []);

  const saved = allPosts.filter((p) => p.bookmarkedByMe);

  const visible = saved.filter((p) => {
    if (collection !== "All saves") {
      const matchCol =
        p.tags.some((t) => t.toLowerCase() === collection.toLowerCase()) ||
        (collection === "Design" && p.content.toLowerCase().includes("design")) ||
        (collection === "Inspiration" && p.content.toLowerCase().includes("inspiration")) ||
        (collection === "Generative AI" &&
          (p.content.toLowerCase().includes("ai") || p.tags.includes("ai")));
      if (!matchCol) return false;
    }

    const q = query.trim().toLowerCase();
    if (!q) return true;
    const author = getProfile(p.user_id);
    return (
      p.content.toLowerCase().includes(q) ||
      author.display_name.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <AppShell title="Bookmarks" right={<DefaultRail />}>
      <div className="mx-auto max-w-2xl space-y-5">
        <PageHeader
          title="Bookmarks"
          subtitle={`${saved.length} saved posts — only visible to you`}
        />

        <div className="glass-panel flex items-center gap-2 rounded-full px-4 py-3 shadow-soft transition-shadow duration-300 focus-within:shadow-glow relative">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your saves by keyword, author or tag..."
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground pr-6"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="rounded-full p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          {collections.map((c) => (
            <button
              key={c}
              onClick={() => setCollection(c)}
              className={cn(
                "shrink-0 rounded-full px-4 py-2 text-sm font-bold transition-all duration-300 active:scale-95",
                collection === c
                  ? "bg-gradient-to-r from-brand to-brand-pink text-white shadow-soft"
                  : "border border-border text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              {c}
            </button>
          ))}
        </div>

        {loading ? (
          <FeedSkeleton />
        ) : (
          <div className="space-y-5">
            {visible.map((p, i) => (
              <PostCard
                key={p.id}
                post={p}
                index={i}
                onDeleted={(id) => setAllPosts((prev) => prev.filter((x) => x.id !== id))}
              />
            ))}

            {visible.length === 0 && (
              <Panel className="flex flex-col items-center gap-3 py-14 text-center">
                <Bookmark className="h-8 w-8 text-muted-foreground" />
                <p className="font-bold">No saves match that search</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Tap the bookmark icon on any post to keep it here for later.
                </p>
              </Panel>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
