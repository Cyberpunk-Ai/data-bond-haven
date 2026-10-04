/**
 * The reader-side rule behind Settings > Privacy > "Filter sensitive content".
 *
 * A post earns `is_sensitive` in the database — three separate people reporting
 * it as "Inappropriate or sensitive media", or a staff member deciding it (see
 * `20261003000003_sensitive_content.sql`). What happens next is a *reader*
 * choice, and this is the whole of it: whether to blur, for whom, and what to
 * say. The post is never removed and never hidden from anybody else.
 *
 * The three escapes are deliberate, and each one is a bug prevented:
 *  - the author never sees their own media blurred (they did not flag
 *    themselves, and a preview you cannot look at is not a preview);
 *  - a post that is already revealed stays revealed for as long as it is on
 *    screen, which is the caller's state, not a rule here;
 *  - an absent flag reads as not sensitive, so a feed query that did not select
 *    the column shows the media rather than smearing every post in the list.
 */

import { appConfig } from "@/lib/config";

export interface SensitivityLike {
  is_sensitive?: boolean | null;
  /** Who decided it: 'community' or 'staff'. Only ever used for the wording. */
  sensitive_source?: string | null;
  user_id?: string | null;
}

export function shouldBlurSensitive(opts: {
  post: SensitivityLike | null | undefined;
  filterEnabled: boolean;
  /** The signed-in profile id, or null/`"guest"` when nobody is signed in. */
  viewerId?: string | null;
  /** This reader already tapped "reveal" on this card. */
  revealed?: boolean;
}): boolean {
  const { post, filterEnabled, viewerId, revealed } = opts;
  if (revealed) return false;
  if (!filterEnabled) return false;
  if (!post?.is_sensitive) return false;
  if (viewerId && viewerId !== "guest" && post.user_id === viewerId) return false;
  return true;
}

/** What the veil says, in the reader's language rather than the moderator's. */
export function sensitiveMediaNotice(source?: string | null): string {
  return source === "staff"
    ? "This media was marked sensitive by our moderators."
    : `This media was flagged as sensitive by people on ${appConfig.brand.name}.`;
}

/** The two buttons the veil offers. Only one of them is the happy path. */
export function sensitiveRevealLabel(revealed: boolean): string {
  return revealed ? "Hide again" : "Tap to reveal";
}
