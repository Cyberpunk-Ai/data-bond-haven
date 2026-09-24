import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppShell, Panel } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { TimeAgo } from "@/components/social/TimeAgo";
import { DefaultRail } from "@/components/social/RightRail";
import { compact } from "@/lib/formatters";
import { getSharedProfile } from "@/lib/share.functions";

export const Route = createFileRoute("/u/$username")({
  loader: ({ params }) => getSharedProfile({ data: { username: params.username } }),
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [{ title: "Profile unavailable — Spaces1" }, { name: "robots", content: "noindex" }],
      };
    }
    const title = `${loaderData.displayName} (@${loaderData.username}) — Spaces1`;
    const description =
      loaderData.bio || `Follow @${loaderData.username} on Spaces1 for posts and live audio rooms.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "profile" },
        { name: "twitter:card", content: "summary" },
      ],
    };
  },
  component: PublicProfilePage,
});

function PublicProfilePage() {
  const profile = Route.useLoaderData();

  return (
    <AppShell title="Profile" right={<DefaultRail />}>
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <Link
          to="/explore"
          className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Explore
        </Link>

        {!profile ? (
          <Panel className="flex flex-col items-center gap-3 py-14 text-center">
            <p className="text-lg font-bold">We couldn't find that account</p>
            <p className="text-sm text-muted-foreground">The username may have changed.</p>
          </Panel>
        ) : (
          <>
            <Panel className="space-y-4 p-5 sm:p-6">
              <div className="flex items-center gap-4">
                <Avatar
                  name={profile.displayName}
                  src={profile.avatarUrl ?? undefined}
                  className="h-16 w-16 text-lg"
                />
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-black">{profile.displayName}</h1>
                  <p className="truncate text-sm text-muted-foreground">@{profile.username}</p>
                  <p className="mt-1 text-sm font-semibold">
                    {compact(profile.followers)}{" "}
                    <span className="font-normal text-muted-foreground">followers</span>
                  </p>
                </div>
              </div>
              {profile.bio && <p className="text-sm leading-relaxed">{profile.bio}</p>}
              <Link
                to="/profile"
                search={{ user: profile.username }}
                className="inline-flex rounded-full bg-gradient-to-r from-brand to-brand-pink px-5 py-2.5 text-sm font-bold text-white"
              >
                Open full profile
              </Link>
            </Panel>

            <div className="space-y-3">
              {profile.posts.map((p) => (
                <Link
                  key={p.id}
                  to="/post/$id"
                  params={{ id: p.id }}
                  className="glass-panel block rounded-3xl p-4 shadow-soft transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lift"
                >
                  <p className="line-clamp-4 text-sm leading-relaxed">{p.content}</p>
                  <TimeAgo iso={p.createdAt} className="mt-2 block text-xs text-muted-foreground" />
                </Link>
              ))}
              {profile.posts.length === 0 && (
                <Panel className="py-10 text-center text-sm text-muted-foreground">
                  No posts yet.
                </Panel>
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
