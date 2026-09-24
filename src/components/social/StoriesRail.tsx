import { Plus } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { Avatar } from "@/components/social/Avatar";
import { getStories } from "@/lib/api-client";
import { appConfig } from "@/lib/config";
import { getProfile, currentUser } from "@/lib/profile-service";
import { useRealtime } from "@/lib/realtime";
import type { Story } from "@/lib/types";
import { cn } from "@/lib/utils";

const StoryModal = lazy(() =>
  import("@/components/social/StoryModal").then((m) => ({ default: m.StoryModal })),
);
const StoryCreatorModal = lazy(() =>
  import("@/components/social/StoryCreatorModal").then((m) => ({ default: m.StoryCreatorModal })),
);

type StoryGroup = { userId: string; stories: Story[] };

/** Horizontal stories rail: grouped per author, opens the viewer or the creator. */
export function StoriesRail() {
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [creatorOpen, setCreatorOpen] = useState(false);

  useEffect(() => {
    if (!appConfig.features.stories) {
      setLoading(false);
      return;
    }
    getStories()
      .then((rows) => setStories(rows.filter((s) => new Date(s.expires_at).getTime() > Date.now())))
      .catch(() => setStories([]))
      .finally(() => setLoading(false));
  }, []);

  useRealtime({
    "story:created": (story: Story) => setStories((prev) => [story, ...prev]),
    "story:deleted": ({ id }: { id: string }) =>
      setStories((prev) => prev.filter((s) => s.id !== id)),
  });

  const groups = useMemo<StoryGroup[]>(() => {
    const byUser = new Map<string, Story[]>();
    for (const story of stories) {
      byUser.set(story.user_id, [...(byUser.get(story.user_id) ?? []), story]);
    }
    return Array.from(byUser, ([userId, items]) => ({ userId, stories: items }));
  }, [stories]);

  const flattened = useMemo(() => groups.flatMap((g) => g.stories), [groups]);

  if (!appConfig.features.stories) return null;

  return (
    <section aria-label="Stories" className="mb-5">
      <div className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          onClick={() => setCreatorOpen(true)}
          className="group flex w-[4.75rem] shrink-0 flex-col items-center gap-1.5"
        >
          <span className="relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-brand/50 bg-brand/5 transition-transform duration-300 group-hover:scale-105">
            <Plus className="h-5 w-5 text-brand" />
          </span>
          <span className="truncate text-[0.68rem] font-semibold text-muted-foreground">
            Your story
          </span>
        </button>

        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="w-[4.75rem] shrink-0 animate-pulse">
                <div className="h-16 w-16 rounded-full bg-foreground/10" />
                <div className="mx-auto mt-2 h-2.5 w-12 rounded bg-foreground/10" />
              </div>
            ))
          : groups.map((group, idx) => {
              const author = getProfile(group.userId) ?? currentUser;
              const firstIndex = flattened.findIndex((s) => s.id === group.stories[0]?.id);
              return (
                <button
                  key={`story-rail-${group.userId}-${idx}`}
                  onClick={() => setViewerIndex(Math.max(0, firstIndex))}
                  className="group flex w-[4.75rem] shrink-0 flex-col items-center gap-1.5"
                >
                  <span
                    className={cn(
                      "rounded-full bg-gradient-to-tr from-brand via-brand-pink to-amber-400 p-[2px]",
                      "transition-transform duration-300 group-hover:scale-105",
                    )}
                  >
                    <span className="block rounded-full bg-background p-[2px]">
                      <Avatar
                        name={author.display_name}
                        src={author.avatar_url}
                        className="h-14 w-14 text-xs"
                      />
                    </span>
                  </span>
                  <span className="w-full truncate text-center text-[0.68rem] font-semibold">
                    {author.display_name?.split(" ")[0] || author.username}
                  </span>
                </button>
              );
            })}
      </div>

      <Suspense fallback={null}>
        {viewerIndex !== null ? (
          <StoryModal
            stories={flattened}
            initialIndex={viewerIndex}
            isOpen
            onClose={() => setViewerIndex(null)}
            onStoryDeleted={(id) => setStories((prev) => prev.filter((s) => s.id !== id))}
          />
        ) : null}
        {creatorOpen ? (
          <StoryCreatorModal
            isOpen
            onClose={() => setCreatorOpen(false)}
            onStoryCreated={(story) => setStories((prev) => [story, ...prev])}
          />
        ) : null}
      </Suspense>
    </section>
  );
}
