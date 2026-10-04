import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WorkspaceBadgeProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
  showTooltip?: boolean;
}

const sizeMap = {
  xs: "h-3.5 w-3.5 min-w-[0.875rem]",
  sm: "h-4 w-4 min-w-[1rem]",
  md: "h-4.5 w-4.5 min-w-[1.125rem]",
  lg: "h-5 w-5 min-w-[1.25rem]",
  xl: "h-6 w-6 min-w-[1.5rem]",
};

/**
 * Identity badge for a team workspace, sitting in the same visual family as
 * UserBadge's Plus (violet→pink) and Pro (amber→orange) chips: a small filled
 * circle with its own teal→cyan gradient and a people glyph, so "this is a
 * shared brand account" reads instantly on team posts, tips and the team
 * profile without the old uppercase "TEAM" pill.
 */
export function WorkspaceBadge({
  size = "sm",
  className,
  showTooltip = true,
}: WorkspaceBadgeProps) {
  const title = "👥 Team Workspace";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full select-none transition-transform hover:scale-110",
        "bg-gradient-to-tr from-teal-500 via-emerald-400 to-cyan-500 text-white shadow-sm ring-1 ring-cyan-300/40",
        sizeMap[size] || sizeMap.sm,
        className,
      )}
      title={showTooltip ? title : undefined}
      aria-label={title}
    >
      <Users className="h-[58%] w-[58%]" strokeWidth={2.6} />
    </span>
  );
}
