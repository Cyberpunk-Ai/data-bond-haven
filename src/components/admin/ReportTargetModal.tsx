import { useEffect, useState } from "react";
import {
  ExternalLink,
  Eye,
  FileText,
  Heart,
  Loader2,
  MessageSquare,
  Radio,
  Repeat2,
  ShieldX,
  User,
  X,
} from "lucide-react";
import { getCommentById, getPostById, getSpace, getStories } from "@/lib/api-client";
import { fetchProfile, getProfile } from "@/lib/profile-service";
import { useAuthorizedMediaUrl } from "@/lib/media-access";
import { Avatar } from "@/components/social/Avatar";
import type { ModerationReport, Post, Profile, Space, Story } from "@/lib/types";
import { cn } from "@/lib/utils";
import { splitMediaList } from "@/lib/media-list";

interface ReportTargetModalProps {
  report: ModerationReport;
  onClose: () => void;
}

type Loaded =
  | { kind: "post"; post: Post }
  | { kind: "user"; profile: Profile }
  | { kind: "comment"; comment: Record<string, any> }
  | { kind: "story"; story: Story }
  | { kind: "space"; space: Space }
  | { kind: "removed" }
  | { kind: "unsupported" };

/**
 * Click-to-view from the moderation queue: loads the *live* reported object
 * (post, profile, comment, story or space) so a moderator can see exactly
 * what members saw before deciding to remove, warn or dismiss. Read-only by
 * design — every action still lives on the report card itself.
 */
export function ReportTargetModal({ report, onClose }: ReportTargetModalProps) {
  const [state, setState] = useState<"loading" | "ready">("loading");
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setLoaded(null);
    void (async () => {
      try {
        if (report.target_type === "post") {
          const post = await getPostById(report.target_id);
          if (cancelled) return;
          setLoaded(post ? { kind: "post", post } : { kind: "removed" });
        } else if (report.target_type === "user") {
          const profile = await fetchProfile(report.target_id);
          if (cancelled) return;
          setLoaded(profile ? { kind: "user", profile } : { kind: "removed" });
        } else if (report.target_type === "comment") {
          const comment = await getCommentById(report.target_id);
          if (cancelled) return;
          setLoaded(comment ? { kind: "comment", comment } : { kind: "removed" });
        } else if (report.target_type === "story") {
          // Stories self-destruct after 24h; getStories only returns live ones
          // visible to the signed-in staff account's network.
          const stories = await getStories();
          if (cancelled) return;
          const story = stories.find((s) => s.id === report.target_id);
          setLoaded(story ? { kind: "story", story } : { kind: "removed" });
        } else if (report.target_type === "space") {
          const { space } = await getSpace(report.target_id);
          if (cancelled) return;
          setLoaded(space ? { kind: "space", space } : { kind: "removed" });
        } else {
          setLoaded({ kind: "unsupported" });
        }
      } catch {
        if (!cancelled) setLoaded({ kind: "unsupported" });
      } finally {
        if (!cancelled) setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [report.id, report.target_type, report.target_id]);

  // Deep link out to the public page for the target, where supported.
  const external = getExternalLink(loaded, report);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Reported ${report.target_type} preview`}
    >
      <div
        className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 rounded-xl bg-foreground/5 px-2.5 py-1 text-[0.7rem] font-bold capitalize text-foreground">
            <TargetGlyph type={report.target_type} />
            Reported {report.target_type}
          </span>
          <div className="flex items-center gap-2">
            {external && (
              <a
                href={external.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-2xl border border-border bg-background/60 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-foreground/5"
              >
                <ExternalLink className="h-3.5 w-3.5 text-brand" />
                {external.label}
              </a>
            )}
            <button
              onClick={onClose}
              aria-label="Close preview"
              className="rounded-full p-1.5 text-muted-foreground hover:bg-muted cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {state === "loading" && (
          <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-brand" />
            Loading the reported {report.target_type}…
          </div>
        )}

        {state === "ready" && loaded?.kind === "removed" && (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/70 bg-foreground/5 py-10 text-center">
            <ShieldX className="h-8 w-8 text-rose-500/80" />
            <p className="text-sm font-bold text-foreground">This content is no longer available</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              It was likely removed by the author or a moderator after the report came in. The
              reported snapshot below is all that remains.
            </p>
          </div>
        )}

        {state === "ready" && loaded?.kind === "unsupported" && (
          <div className="rounded-2xl border border-border/70 bg-foreground/5 p-4 text-xs text-muted-foreground">
            Live preview isn&apos;t available for this target type. Use the reported snapshot shown
            on the report card.
          </div>
        )}

        {state === "ready" && loaded?.kind === "post" && <PostBody post={loaded.post} />}
        {state === "ready" && loaded?.kind === "user" && <UserBody profile={loaded.profile} />}
        {state === "ready" && loaded?.kind === "comment" && (
          <CommentBody comment={loaded.comment} />
        )}
        {state === "ready" && loaded?.kind === "story" && <StoryBody story={loaded.story} />}
        {state === "ready" && loaded?.kind === "space" && <SpaceBody space={loaded.space} />}

        {/* Reported snapshot stays visible underneath so moderators keep the
            reporter's context (preview text, reason, details) next to the live
            content. */}
        <div className="mt-4 rounded-2xl border border-border/80 bg-foreground/5 p-3.5">
          <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-wider text-muted-foreground">
            As reported — {report.reason}
          </p>
          <p className="text-xs font-medium italic text-foreground">
            &quot;{report.target_preview || "(no snapshot stored on this report)"}&quot;
          </p>
          {report.details && (
            <p className="mt-1.5 text-[0.7rem] text-muted-foreground">Note: {report.details}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function TargetGlyph({ type }: { type: string }) {
  const cls = "h-3 w-3 text-brand";
  if (type === "post") return <FileText className={cls} />;
  if (type === "user") return <User className={cls} />;
  if (type === "comment") return <MessageSquare className={cls} />;
  if (type === "space") return <Radio className={cls} />;
  return <Eye className={cls} />;
}

function getExternalLink(loaded: Loaded | null, report: ModerationReport) {
  if (!loaded) return null;
  if (loaded.kind === "post") return { href: `/post/${report.target_id}`, label: "Open post page" };
  if (loaded.kind === "user" && loaded.profile.username)
    return { href: `/u/${loaded.profile.username}`, label: "Open profile" };
  if (loaded.kind === "comment" && loaded.comment.post_id)
    return { href: `/post/${loaded.comment.post_id}`, label: "Open thread" };
  return null;
}

/** Post media is public-folder bytes, but multi-attachment columns are
 *  comma-joined and DM/story folders need the signed-token path — the shared
 *  hook handles both rules the same way AdminContentTab does. */
function PreviewMedia({ url, label }: { url: string; label: string }) {
  const { src } = useAuthorizedMediaUrl(url);
  if (!src) return null;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block">
      <img
        src={src}
        alt={label}
        loading="lazy"
        decoding="async"
        className="max-h-[22rem] w-full rounded-2xl border border-border/60 bg-black/40 object-contain"
      />
      <span className="mt-1 flex items-center gap-1 text-[0.68rem] text-muted-foreground hover:text-brand">
        <ExternalLink className="h-3 w-3" /> Open full size
      </span>
    </a>
  );
}

function splitMedia(csv: string | null | undefined): string[] {
  return splitMediaList(csv);
}

function PostBody({ post }: { post: Post }) {
  const author = getProfile(post.user_id);
  const media = splitMedia(post.media_url || post.image_url);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <Avatar name={author.display_name} src={author.avatar_url} className="h-9 w-9 text-xs" />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{author.display_name || "Unknown member"}</p>
          <p className="truncate text-xs text-muted-foreground">
            {author.username ? `@${author.username}` : `${post.user_id.slice(0, 8)}…`} ·{" "}
            {new Date(post.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      {post.image_gradient && !media.length && (
        <div
          className={cn(
            "flex min-h-[7rem] items-center justify-center rounded-2xl bg-gradient-to-br p-5 text-center text-sm font-bold text-white",
            post.image_gradient,
          )}
        >
          {post.content}
        </div>
      )}

      {post.content && !post.image_gradient && (
        <p className="whitespace-pre-wrap break-words text-sm font-medium text-foreground">
          {post.content}
        </p>
      )}

      {media.map((url, i) => (
        <PreviewMedia key={url + i} url={url} label={`Post attachment ${i + 1}`} />
      ))}

      {post.poll && (
        <div className="space-y-2 rounded-2xl border border-border/70 p-3.5">
          <p className="text-xs font-bold">{post.poll.question}</p>
          {post.poll.options.map((opt) => {
            const pct =
              post.poll && post.poll.totalVotes > 0
                ? Math.round(((opt.votes || 0) / post.poll.totalVotes) * 100)
                : 0;
            return (
              <div key={opt.id} className="space-y-1">
                <div className="flex justify-between text-[0.7rem]">
                  <span>{opt.text}</span>
                  <span className="text-muted-foreground">{pct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          <p className="text-[0.68rem] text-muted-foreground">
            {post.poll.totalVotes ?? 0} votes {post.poll.closed ? "· closed" : ""}
          </p>
        </div>
      )}

      {post.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {post.tags.map((t) => (
            <span
              key={t}
              className="rounded-lg bg-brand/10 px-2 py-0.5 text-[0.68rem] font-semibold text-brand"
            >
              #{t}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Heart className="h-3.5 w-3.5" /> {post.likeCount}
        </span>
        <span className="flex items-center gap-1">
          <MessageSquare className="h-3.5 w-3.5" /> {post.commentCount}
        </span>
        <span className="flex items-center gap-1">
          <Repeat2 className="h-3.5 w-3.5" /> {post.repostCount}
        </span>
        <span className="flex items-center gap-1">
          <Eye className="h-3.5 w-3.5" /> {post.viewCount}
        </span>
      </div>
    </div>
  );
}

function UserBody({ profile }: { profile: Profile }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar
          name={profile.display_name}
          src={profile.avatar_url}
          className="h-12 w-12 text-sm"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">
            {profile.display_name}
            {profile.verified && (
              <span className="ml-1.5 rounded-md bg-brand/15 px-1.5 py-0.5 text-[0.6rem] font-bold text-brand">
                VERIFIED
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">@{profile.username}</p>
        </div>
      </div>
      {profile.bio && <p className="text-xs text-foreground">{profile.bio}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.7rem] text-muted-foreground">
        {profile.location && <span>📍 {profile.location}</span>}
        {profile.website && <span className="break-all">🔗 {profile.website}</span>}
      </div>
      <div className="flex items-center gap-3 border-t border-border/60 pt-3 text-xs">
        <span className="font-bold text-foreground">{profile.followers ?? 0}</span>
        <span className="text-muted-foreground">followers</span>
        <span className="font-bold text-foreground">{profile.following ?? 0}</span>
        <span className="text-muted-foreground">following</span>
        {profile.plan && (
          <span className="ml-auto rounded-lg bg-foreground/5 px-2 py-0.5 text-[0.68rem] font-bold uppercase text-muted-foreground">
            {profile.plan} plan
          </span>
        )}
        {profile.status && profile.status !== "active" && (
          <span className="rounded-lg bg-rose-500/15 px-2 py-0.5 text-[0.68rem] font-bold uppercase text-rose-600">
            {profile.status}
          </span>
        )}
      </div>
    </div>
  );
}

function CommentBody({ comment }: { comment: Record<string, any> }) {
  const author = getProfile(String(comment.user_id ?? ""));
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <Avatar name={author.display_name} src={author.avatar_url} className="h-8 w-8 text-xs" />
        <div className="min-w-0">
          <p className="truncate text-xs font-bold">{author.display_name || "Unknown member"}</p>
          <p className="text-[0.68rem] text-muted-foreground">
            {comment.created_at ? new Date(comment.created_at).toLocaleString() : ""}
          </p>
        </div>
      </div>
      <p className="whitespace-pre-wrap break-words rounded-2xl border border-border/70 bg-foreground/5 p-3.5 text-sm">
        {String(comment.content ?? "")}
      </p>
    </div>
  );
}

function StoryBody({ story }: { story: Story }) {
  const media = splitMedia(story.media_url || story.image_url)[0];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {story.user_name || getProfile(story.user_id).display_name} ·{" "}
        {new Date(story.created_at).toLocaleString()} · expires{" "}
        {new Date(story.expires_at).toLocaleString()}
      </p>
      {media ? (
        <PreviewMedia url={media} label="Story media" />
      ) : story.gradient ? (
        <div
          className={cn(
            "flex min-h-[10rem] items-center justify-center rounded-2xl bg-gradient-to-br p-5 text-center text-sm font-bold text-white",
            story.gradient,
          )}
        >
          {story.text || story.caption}
        </div>
      ) : null}
      {(story.text || story.caption) && !story.gradient && (
        <p className="whitespace-pre-wrap break-words text-sm font-medium">
          {story.text || story.caption}
        </p>
      )}
      <div className="flex gap-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Eye className="h-3.5 w-3.5" /> {story.view_count ?? 0} views
        </span>
        <span className="flex items-center gap-1">
          <Heart className="h-3.5 w-3.5" /> {story.likes_count ?? 0}
        </span>
        {story.location && <span>📍 {story.location}</span>}
      </div>
    </div>
  );
}

function SpaceBody({ space }: { space: Space }) {
  return (
    <div className="space-y-3">
      <div
        className={cn(
          "flex min-h-[6rem] items-end rounded-2xl bg-gradient-to-br p-4",
          space.gradient || "from-slate-700 to-slate-900",
        )}
      >
        <p className="text-base font-extrabold text-white drop-shadow">{space.title}</p>
      </div>
      {space.topic && <p className="text-xs text-foreground">{space.topic}</p>}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Radio
            className={cn("h-3.5 w-3.5", space.live ? "text-emerald-500" : "text-muted-foreground")}
          />
          {space.live ? "LIVE right now" : "Ended"}
        </span>
        <span>🎙 {space.host_name || getProfile(space.host_id).display_name}</span>
        <span>{space.listeners ?? 0} listeners</span>
      </div>
    </div>
  );
}
