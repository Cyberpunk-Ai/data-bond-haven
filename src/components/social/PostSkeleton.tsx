import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface PostSkeletonProps {
  className?: string;
  hasMedia?: boolean;
}

export function PostSkeleton({ className, hasMedia = false }: PostSkeletonProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/50 bg-background/50 p-4 shadow-sm md:p-5",
        className,
      )}
    >
      {/* Author Header */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-28 rounded-md" />
            <Skeleton className="h-3 w-4 rounded-full" />
            <Skeleton className="h-3 w-16 rounded-md" />
          </div>
          <Skeleton className="h-3 w-20 rounded-md" />
        </div>
        <Skeleton className="h-8 w-8 rounded-full" />
      </div>

      {/* Content lines */}
      <div className="mt-4 space-y-2.5">
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-[92%] rounded-md" />
        <Skeleton className="h-4 w-[65%] rounded-md" />
      </div>

      {/* Optional Media Block */}
      {hasMedia && <Skeleton className="mt-4 h-[240px] w-full rounded-2xl md:h-[320px]" />}

      {/* Action Buttons Footer */}
      <div className="mt-5 flex items-center justify-between border-t border-border/30 pt-3">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-7 w-7 rounded-full" />
            <Skeleton className="h-3.5 w-6 rounded-md" />
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-7 w-7 rounded-full" />
            <Skeleton className="h-3.5 w-6 rounded-md" />
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-7 w-7 rounded-full" />
            <Skeleton className="h-3.5 w-6 rounded-md" />
          </div>
        </div>
        <Skeleton className="h-7 w-7 rounded-full" />
      </div>
    </div>
  );
}

export function FeedSkeleton() {
  return (
    <div className="space-y-5">
      <PostSkeleton />
      <PostSkeleton hasMedia />
      <PostSkeleton />
    </div>
  );
}
