import { useEffect, useState } from "react";
import { ExternalLink, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { getLinkPreview, type LinkPreview } from "@/lib/link-preview.functions";

/**
 * A small cache so re-rendering a thread (or the same link appearing twice)
 * never refires the server fetch. `resolved` is per-URL and survives component
 * remounts; `pending` collapses concurrent requests for one URL into a call.
 */
const resolved = new Map<string, LinkPreview | null>();
const pending = new Map<string, Promise<LinkPreview | null>>();

function loadPreview(url: string): Promise<LinkPreview | null> {
  const existing = pending.get(url);
  if (existing) return existing;
  const promise = getLinkPreview({ data: { url } })
    .then((meta) => {
      const value = meta?.ok ? meta : null;
      resolved.set(url, value);
      pending.delete(url);
      return value;
    })
    .catch(() => {
      resolved.set(url, null);
      pending.delete(url);
      return null;
    });
  pending.set(url, promise);
  return promise;
}

/**
 * A rich link preview for the first URL in a message.
 *
 * Best-effort by contract: while the fetch runs we render nothing, and a page
 * with no useful metadata renders nothing either — the plain, clickable link in
 * the bubble text above is always the fallback, so a preview card can only ever
 * add to the message, never replace or break it.
 */
export function LinkPreviewCard({ url, isMine }: { url: string; isMine: boolean }) {
  const [meta, setMeta] = useState<LinkPreview | null | undefined>(
    () => resolved.get(url) ?? undefined,
  );

  useEffect(() => {
    if (resolved.has(url)) {
      setMeta(resolved.get(url) ?? null);
      return;
    }
    let alive = true;
    setMeta(null);
    void loadPreview(url).then((value) => {
      if (alive) setMeta(value);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  // Still loading, or no useful metadata: leave the plain link as the only signal.
  if (meta === undefined || meta === null) return null;

  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Not an absolute URL — show it as typed.
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "group/link flex flex-col overflow-hidden rounded-xl border text-left transition-all",
        isMine
          ? "border-white/20 bg-black/20 text-white hover:bg-black/30"
          : "border-border/60 bg-background/90 text-foreground shadow-xs hover:bg-background",
      )}
    >
      {meta.image ? (
        <img
          src={meta.image}
          alt=""
          loading="lazy"
          className="h-32 w-full bg-muted object-cover"
          onError={(e) => {
            // A dead thumbnail shouldn't leave a grey band; collapse it away.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : null}
      <div className="flex items-start gap-2.5 p-2.5">
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold",
            isMine ? "bg-white/20 text-white" : "bg-brand/10 text-brand",
          )}
        >
          <Globe className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-xs font-bold">{meta.title || host}</span>
          </div>
          {meta.description ? (
            <p
              className={cn(
                "mt-0.5 line-clamp-2 text-[11px]",
                isMine ? "text-white/80" : "text-muted-foreground",
              )}
            >
              {meta.description}
            </p>
          ) : null}
          <div
            className={cn(
              "mt-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide",
              isMine ? "text-white/60" : "text-muted-foreground",
            )}
          >
            <span className="truncate">{host}</span>
            <ExternalLink className="h-3 w-3 shrink-0 opacity-60 group-hover/link:opacity-100" />
          </div>
        </div>
      </div>
    </a>
  );
}
