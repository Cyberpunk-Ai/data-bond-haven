import { appConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

/**
 * The product's brand mark.
 *
 * Renders the official logo asset (white mark on black) so it stays pixel-exact
 * everywhere it appears. Pass a sizing `className` (e.g. "h-9 w-9").
 *
 * `srcSet`/`sizes` are not decoration. The shell paints this in a 24-40px slot
 * on every screen of the app, and with only a `src` the browser downloads the
 * 512px file (~17 KB) to fill it. Declaring the slot lets it take the 192px
 * render (~3.5 KB) instead, which is still crisp at 2x on a phone. The largest
 * slot in the app is `h-10` (40px), which is what `sizes` promises.
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      srcSet="/icon-192.png 192w, /logo.png 512w"
      sizes="40px"
      alt={appConfig.brand.name}
      width={512}
      height={512}
      decoding="async"
      draggable={false}
      className={cn("aspect-square rounded-xl object-cover", className)}
    />
  );
}
