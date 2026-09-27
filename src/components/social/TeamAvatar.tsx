import { Avatar } from "@/components/social/Avatar";
import { cn } from "@/lib/utils";

type TeamAvatarSize = "sm" | "md" | "lg";

/**
 * The team's brand mark — always a *perfect circle* with a card-coloured gap
 * between the gradient ring and the content, exactly like the personal
 * avatar's `ring-4 ring-card`. Without that gap the tile blended straight into
 * the cover-gradient "aura" on the team profile and looked like a squircle
 * next to a person's round avatar.
 *
 * Renders the uploaded logo when there is one, otherwise the team's emoji on a
 * card-coloured disc.
 */
export function TeamAvatar({
  name,
  emoji,
  avatarUrl,
  size = "md",
  halo = false,
  className,
}: {
  name: string;
  emoji?: string;
  avatarUrl?: string | null;
  /** sm = composer, md = post cards / modals, lg = profile header. */
  size?: TeamAvatarSize;
  /** White ring + shadow, for avatars that overlap a cover gradient. */
  halo?: boolean;
  className?: string;
}) {
  const box =
    size === "lg"
      ? "h-20 w-20 sm:h-24 sm:w-24"
      : size === "md"
        ? "h-11 w-11"
        : "h-9 w-9";
  const emojiText = size === "lg" ? "text-3xl" : size === "md" ? "text-lg" : "text-base";

  return (
    <span
      title={name}
      className={cn(
        "relative inline-flex shrink-0 aspect-square items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-pink p-[3px]",
        box,
        halo && "ring-4 ring-card shadow-lg",
        className,
      )}
    >
      <span
        className={cn(
          "flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-card",
          emojiText,
        )}
      >
        {avatarUrl ? (
          <Avatar name={name} src={avatarUrl} className="h-full w-full text-xs" />
        ) : (
          <span aria-hidden>{emoji ?? "✨"}</span>
        )}
      </span>
    </span>
  );
}
