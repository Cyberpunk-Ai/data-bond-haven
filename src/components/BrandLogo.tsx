import { cn } from "@/lib/utils";

/**
 * Spaces1 brand mark.
 *
 * Renders the official logo asset (white mark on black) so it stays pixel-exact
 * everywhere it appears. Pass a sizing `className` (e.g. "h-9 w-9").
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt="Spaces1"
      width={512}
      height={512}
      draggable={false}
      className={cn("aspect-square rounded-xl object-cover", className)}
    />
  );
}
