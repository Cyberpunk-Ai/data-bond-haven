import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Collapses long text to a few lines with a clean "… Read more" toggle.
 * Used anywhere a person can write more than fits comfortably.
 */
export function ClampText({
  text,
  lines = 4,
  limit = 260,
  className,
  render,
}: {
  text: string;
  lines?: 3 | 4 | 5;
  limit?: number;
  className?: string;
  render?: (value: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const body = render ? render(text) : text;
  const isLong = text.length > limit || text.split("\n").length > lines + 2;

  if (!isLong) return <p className={cn("whitespace-pre-wrap break-words", className)}>{body}</p>;

  const clamp = { 3: "line-clamp-3", 4: "line-clamp-4", 5: "line-clamp-5" }[lines];

  return (
    <div>
      <p className={cn("whitespace-pre-wrap break-words", !expanded && clamp, className)}>{body}</p>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-0.5 text-xs font-semibold text-brand transition-opacity hover:opacity-80"
      >
        {expanded ? "Show less" : "… Read more"}
      </button>
    </div>
  );
}
