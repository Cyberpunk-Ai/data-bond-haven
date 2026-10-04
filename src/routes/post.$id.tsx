import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Heart, MessageCircle, Eye } from "lucide-react";
import { AppShell, Panel } from "@/components/social/AppShell";
import { Avatar } from "@/components/social/Avatar";
import { TimeAgo } from "@/components/social/TimeAgo";
import { DefaultRail } from "@/components/social/RightRail";
import { PostCard } from "@/components/social/PostCard";
import { PostDetailSkeleton } from "@/components/social/PostSkeleton";
import { compact } from "@/lib/formatters";
import { getSharedPost } from "@/lib/share.functions";
import { pagePreviewMeta } from "@/lib/og-meta";
import {
  NOINDEX_META,
  ORG_NAME,
  breadcrumbJsonLd,
  brandedTitle,
  canonicalLink,
  jsonLdBlock,
  ogUrlMeta,
  postJsonLd,
} from "@/lib/seo";
import { getPostById } from "@/lib/api-client";
import { firstMediaUrl, isVideoUrl } from "@/lib/utils";
import type { Post } from "@/lib/types";

export const Route = createFileRoute("/post/$id")({
  // `.catch` keeps a failed intent-preload from surfacing as an unhandled
  // rejection; a null loaderData renders the "unavailable" head/body below.
  loader: ({ params }) => getSharedPost({ data: { id: params.id } }).catch(() => null),
  head: ({ loaderData }) => {
    if (!loaderData) {
      // Deleted, private or never existed. `noindex` is the part that matters:
      // without it every stale link target on the internet becomes an indexed
      // soft-404, which is how a domain loses crawl trust.
      return {
        meta: [{ title: brandedTitle("Post unavailable") }, ...NOINDEX_META],
      };
    }
    const snippet = loaderData.content.slice(0, 150) || `A post on ${ORG_NAME}`;
    const title = `${loaderData.author.displayName} on ${ORG_NAME}`;
    const path = `/post/${loaderData.id}`;
    return {
      meta: [
        { title },
        { name: "description", content: snippet },
        { property: "og:title", content: title },
        { property: "og:description", content: snippet },
        { property: "og:type", content: "article" },
        { property: "article:published_time", content: loaderData.createdAt },
        { name: "twitter:card", content: "summary_large_image" },
        // A post that carries a photo previews that photo, because that is what
        // the link is actually about; a text-only post keeps the site card.
        // Private objects (story/DM/replay keys) are refused by
        // `previewImageUrl`, so a share can never advertise bytes the reader is
        // not entitled to fetch.
        ...pagePreviewMeta(loaderData.mediaUrl, snippet),
        ogUrlMeta(path),
        // One block for the posting and the trail (home → author → post), in
        // `meta` because `script:ld+json` is the entry the router renders as a
        // real `<script>` inside `<head>`.
        jsonLdBlock(
          postJsonLd({
            id: loaderData.id,
            content: loaderData.content,
            authorName: loaderData.author.displayName,
            authorUsername: loaderData.author.username,
            createdAt: loaderData.createdAt,
            likeCount: loaderData.likeCount,
            commentCount: loaderData.commentCount,
          }),
          breadcrumbJsonLd([
            { name: ORG_NAME, path: "/" },
            {
              name: `@${loaderData.author.username}`,
              path: `/u/${encodeURIComponent(loaderData.author.username)}`,
            },
            { name: "Post", path },
          ]),
        ),
      ],
      links: [canonicalLink(path)],
    };
  },
  component: PostPage,
  // The share loader itself gets a matching skeleton, so an in-app tap on a
  // post never flashes an empty page while the server function round-trips.
  pendingComponent: PostPagePending,
});

function PostPagePending() {
  return (
    <AppShell title="Post" right={<DefaultRail />}>
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to feed
        </span>
        <PostDetailSkeleton />
      </div>
    </AppShell>
  );
}

function PostPage() {
  const post = Route.useLoaderData();
  const { id } = Route.useParams();
  // The share DTO's media column is the raw stored value: several comma-joined
  // urls for a multi-image post, and a video url looks exactly like an image one
  // until you check the extension. Rendering it straight into an <img src> gave
  // a broken thumbnail for every multi-image post, so the fallback view goes
  // through the same two rules the interactive card uses.
  const shareMedia = firstMediaUrl(post?.mediaUrl);
  // In-app viewers get the full interactive card (like/comment/repost/save);
  // the loader's share DTO is only the crawler/anonymous fallback.
  const [fullPost, setFullPost] = useState<Post | null>(null);
  const [loadingFull, setLoadingFull] = useState(true);

  useEffect(() => {
    let active = true;
    setLoadingFull(true);
    getPostById(id)
      .then((p) => {
        if (active && p) setFullPost(p);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingFull(false);
      });
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
          <div className="animate-in fade-in duration-300">
            <PostCard post={fullPost} />
          </div>
        ) : loadingFull ? (
          <PostDetailSkeleton hasMedia={Boolean(post?.mediaUrl || post?.gradient)} />
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
                  to="/profile"
                  search={{ user: post.author.username }}
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

            {shareMedia ? (
              isVideoUrl(shareMedia) ? (
                // Sound on demand, no autoplay: this view is what an anonymous
                // or not-yet-loaded visitor gets, and autoplaying audio there is
                // how a shared link becomes noise.
                <video
                  src={shareMedia}
                  controls
                  playsInline
                  muted
                  preload="metadata"
                  className="w-full rounded-2xl border border-border bg-black"
                />
              ) : (
                <img
                  src={shareMedia}
                  alt={`Image attached to this post by ${post.author.displayName}`}
                  loading="lazy"
                  decoding="async"
                  className="w-full rounded-2xl border border-border object-cover"
                />
              )
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
