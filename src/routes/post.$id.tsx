import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Heart, MessageCircle, Eye } from "lucide-react";
import { AppShell, Panel } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { TimeAgo } from "@/components/social/TimeAgo";
import { DefaultRail } from "@/components/social/RightRail";
import { PostCard } from "@/components/social/PostCard";
import { compact } from "@/lib/formatters";
import { getSharedPost } from "@/lib/share.functions";
import { getPostById } from "@/lib/api-client";
import type { Post } from "@/lib/types";

export const Route = createFileRoute("/post/$id")({
  loader: ({ params }) => getSharedPost({ data: { id: params.id } }),
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [{ title: "Post unavailable — Spaces1" }, { name: "robots", content: "noindex" }],
      };
    }
    const snippet = loaderData.content.slice(0, 150) || "A post on Spaces1";
    const title = `${loaderData.author.displayName} on Spaces1`;
    return {
      meta: [
        { title },
        { name: "description", content: snippet },
        { property: "og:title", content: title },
        { property: "og:description", content: snippet },
        { property: "og:type", content: "article" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  component: PostPage,
});

function PostPage() {
  const post = Route.useLoaderData();
  const { id } = Route.useParams();
  // In-app viewers get the full interactive card (like/comment/repost/save);
  // the loader's share DTO is only the crawler/anonymous fallback.
  const [fullPost, setFullPost] = useState<Post | null>(null);

  useEffect(() => {
    let active = true;
    getPostById(id)
      .then((p) => {
        if (active && p) setFullPost(p);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <AppShell title="Post" right={<DefaultRail />}>
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <Link
          to="/feed"
          className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to feed
        </Link>

        {fullPost ? (
          <PostCard post={fullPost} />
        ) : !post ? (
          <Panel className="flex flex-col items-center gap-3 py-14 text-center">
            <p className="text-lg font-bold">This post isn't available</p>
            <p className="text-sm text-muted-foreground">
              It may have been deleted or made private.
            </p>
          </Panel>
        ) : (
          <Panel className="space-y-4 p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <Avatar name={post.author.displayName} src={post.author.avatarUrl ?? undefined} />
              <div className="min-w-0">
                <Link
                  to="/u/$username"
                  params={{ username: post.author.username }}
                  className="block truncate font-bold hover:underline"
                >
                  {post.author.displayName}
                </Link>
                <p className="truncate text-sm text-muted-foreground">
                  @{post.author.username} · <TimeAgo iso={post.createdAt} />
                </p>
              </div>
            </div>

            <p className="whitespace-pre-wrap text-[0.975rem] leading-relaxed">{post.content}</p>

            {post.mediaUrl ? (
              <img
                src={post.mediaUrl}
                alt=""
                className="w-full rounded-2xl border border-border object-cover"
              />
            ) : post.gradient ? (
              <div className={`h-52 w-full rounded-2xl bg-gradient-to-br ${post.gradient}`} />
            ) : null}

            <div className="flex items-center gap-6 border-t border-border pt-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Heart className="h-4 w-4" /> {compact(post.likeCount)}
              </span>
              <span className="flex items-center gap-1.5">
                <MessageCircle className="h-4 w-4" /> {compact(post.commentCount)}
              </span>
              <span className="flex items-center gap-1.5">
                <Eye className="h-4 w-4" /> {compact(post.viewCount)}
              </span>
            </div>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
