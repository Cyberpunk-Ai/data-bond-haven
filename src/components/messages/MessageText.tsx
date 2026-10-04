import { Fragment, useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractUrls, isOwnMediaUrl, OWN_MEDIA_RE, tokenizeBody } from "@/lib/message-helpers";
import { LONG_MESSAGE_CLAMP_CLASS, LONG_MESSAGE_THRESHOLD } from "@/lib/message-constants";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { AttachmentBubble } from "./AttachmentBubble";

type Segment = { kind: "text"; value: string } | { kind: "media"; value: string };

/**
 * Split a body into ordered segments: our own media/attachment references come
 * out tagged as `media` (so the bubble can render the file inline), everything
 * else stays `text`. Matching is order-preserving so a caption that wraps a link
 * keeps reading top-to-bottom.
 */
function splitOwnMedia(body: string): Segment[] {
  const re = new RegExp(OWN_MEDIA_RE.source, "g");
  const segments: Segment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match.index > last) segments.push({ kind: "text", value: body.slice(last, match.index) });
    segments.push({ kind: "media", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < body.length) segments.push({ kind: "text", value: body.slice(last) });
  return segments;
}

/**
 * Renders a text message: preserves newlines, highlights `@mentions` and
 * `#hashtags`, autolinks genuine external URLs, collapses an over-long body
 * behind "Show more", and shows one rich preview card for the first real link.
 *
 * A URL that points at our own storage is never printed as a raw path — it is
 * handed to `AttachmentBubble`, so the reader sees the photo/file itself, not an
 * `/api/public/media/…` route they can't act on.
 */
export function MessageText({
  body,
  isMine,
  endsGroup = true,
  onImageOpen,
}: {
  body: string;
  isMine: boolean;
  endsGroup?: boolean;
  onImageOpen?: (src: string) => void;
}) {
  const isLong = body.length > LONG_MESSAGE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);
  // Reset when a different message reuses this component slot.
  useEffect(() => {
    setExpanded(!isLong);
  }, [body, isLong]);

  const segments = useMemo(() => splitOwnMedia(body), [body]);
  // Only a genuine external link earns a preview card; our own media renders
  // inline instead, so it must not fire the (SSRF-vetted) preview fetch either.
  const firstUrl = useMemo(() => extractUrls(body).find((url) => !isOwnMediaUrl(url)), [body]);

  const clampClass =
    isLong && !expanded ? cn(LONG_MESSAGE_CLAMP_CLASS, "overflow-hidden") : undefined;

  return (
    <div className="space-y-2">
      <div className={clampClass}>
        {segments.map((segment, idx) => {
          if (segment.kind === "media") {
            return (
              <div key={`media-${idx}`} className="my-1 first:mt-0 last:mb-0">
                <AttachmentBubble
                  body={segment.value}
                  isMine={isMine}
                  endsGroup={endsGroup}
                  onImageOpen={onImageOpen ?? (() => {})}
                />
              </div>
            );
          }
          return (
            <div
              key={`text-${idx}`}
              className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-relaxed sm:text-sm"
            >
              {tokenizeBody(segment.value).map((token, tokenIdx) => {
                if (token.type === "url") {
                  return (
                    <a
                      key={tokenIdx}
                      href={token.value}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        "inline-flex items-center gap-1 break-all font-semibold underline underline-offset-3 transition-opacity hover:opacity-80",
                        isMine
                          ? "text-white decoration-white/70 hover:text-white/90"
                          : "text-brand underline decoration-brand/60 hover:text-brand-dark",
                      )}
                      title={token.value}
                    >
                      <span>{token.value}</span>
                      <ExternalLink className="inline h-3.5 w-3.5 shrink-0 opacity-80" />
                    </a>
                  );
                }
                if (token.type === "mention" || token.type === "hashtag") {
                  return (
                    <span
                      key={tokenIdx}
                      className={cn(
                        "rounded px-0.5 font-semibold",
                        isMine ? "bg-white/20 text-white" : "bg-brand/10 text-brand",
                      )}
                    >
                      {token.value}
                    </span>
                  );
                }
                return <Fragment key={tokenIdx}>{token.value}</Fragment>;
              })}
            </div>
          );
        })}
      </div>

      {isLong && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className={cn(
            "-mt-1 cursor-pointer text-[11px] font-bold underline underline-offset-2 opacity-80 transition-opacity hover:opacity-100",
            isMine ? "text-white decoration-white/60" : "text-brand decoration-brand/50",
          )}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      {/* A single rich preview for the first genuine external link. */}
      {firstUrl && <LinkPreviewCard url={firstUrl} isMine={isMine} />}
    </div>
  );
}
