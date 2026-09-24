import React from "react";
import { type PlanTier } from "@/lib/plans";
import { usePlan } from "@/lib/plan-state";
import { cn } from "@/lib/utils";

export interface UserBadgeProps {
  plan?: PlanTier | "ultra" | string | null;
  verified?: boolean;
  isMe?: boolean;
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

export function UserBadge({
  plan,
  verified = true,
  isMe = false,
  size = "sm",
  className,
  showTooltip = true,
}: UserBadgeProps) {
  const { currentPlan } = usePlan();

  // If this badge represents the logged-in user, use active state from usePlan
  let effectivePlan: PlanTier = "free";
  if (isMe) {
    effectivePlan = currentPlan;
  } else if (plan) {
    effectivePlan = plan === "ultra" ? "pro" : (plan as PlanTier);
  }

  // If not verified and on free tier, do not display badge
  const isVerifiedUser = verified || effectivePlan === "plus" || effectivePlan === "pro";
  if (!isVerifiedUser) {
    return null;
  }

  let gradientClasses = "bg-sky-500 text-white shadow-xs";
  let title = "Verified Account";

  if (effectivePlan === "pro") {
    gradientClasses =
      "bg-gradient-to-tr from-amber-500 via-amber-400 to-orange-500 text-white shadow-sm ring-1 ring-amber-300/40";
    title = "👑 Pro Studio Creator";
  } else if (effectivePlan === "plus") {
    gradientClasses =
      "bg-gradient-to-tr from-violet-600 via-purple-500 to-pink-500 text-white shadow-sm ring-1 ring-pink-300/30";
    title = "✨ Plus Creator";
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full select-none transition-transform hover:scale-110",
        sizeMap[size] || sizeMap.sm,
        gradientClasses,
        className,
      )}
      title={showTooltip ? title : undefined}
      aria-label={title}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className="h-full w-full p-[18%]"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="3.5 8.5 6.5 11.5 12.5 5" />
      </svg>
    </span>
  );
}
