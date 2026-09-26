/**
 * Global system-notification bridge.
 *
 * Mounted once at the app root (inside IncomingCallProvider). Subscribes to
 * the recipient-scoped `notifications` change feed — the same rows the
 * in-app bell uses — and mirrors each new one into an OS notification, but
 * only while the app itself is *not* visible/focused (otherwise the in-app
 * toast + badge already cover it).
 *
 * Every alert honours the account's Settings → Notifications toggles:
 *   notify_system   master switch for OS alerts        (default on)
 *   notify_messages direct messages                    (default on)
 *   notify_likes    likes / reposts / story likes      (existing toggle)
 *   notify_followers new followers                     (existing toggle)
 *   notify_mentions comments / replies / mentions      (existing toggle)
 *   notify_tips     received tips                      (default on)
 *   notify_spaces   live-space alerts                  (existing toggle)
 *   notify_sounds   play a chime with the alert        (default on)
 *   notify_preview  show message text in the alert     (default on)
 */
import { useEffect } from "react";

import { supabase } from "@/integrations/supabase/client";
import { getPreferences } from "@/lib/preferences-state";
import {
  ensureNotificationsWorker,
  notificationsSupported,
  showSystemNotification,
} from "@/lib/browser-notifications";

/** notification.type → preferences toggle that gates it. */
const CATEGORY_TOGGLES: Record<string, string> = {
  message: "notify_messages",
  like: "notify_likes",
  repost: "notify_likes",
  story_like: "notify_likes",
  follow: "notify_followers",
  comment: "notify_mentions",
  reply: "notify_mentions",
  mention: "notify_mentions",
  tip: "notify_tips",
  space: "notify_spaces",
  space_live: "notify_spaces",
};

const TITLES: Record<string, string> = {
  message: "New message",
  like: "Someone liked your post",
  repost: "Someone reposted you",
  story_like: "Someone liked your story",
  follow: "New follower",
  comment: "New comment",
  reply: "New reply",
  mention: "You were mentioned",
  tip: "You received a tip",
  space: "Space update",
  space_live: "A Space is live",
};

function routeFor(n: { type?: string; link?: string | null; post_id?: string | null }): string {
  if (n.link) return n.link;
  if (n.type === "message") return "/messages";
  if (n.post_id) return `/post/${n.post_id}`;
  return "/notifications";
}

/** The app only needs an OS alert when the user isn't looking at it. */
function appOutOfSight(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "hidden" || !document.hasFocus();
}

export function useDesktopNotifications(userId?: string | null): void {
  useEffect(() => {
    if (typeof window === "undefined" || !userId) return undefined;
    if (!notificationsSupported()) return undefined;
    void ensureNotificationsWorker();

    const channel = supabase
      .channel(`system-notifications-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `recipient_id=eq.${userId}`,
        },
        (payload: { new?: Record<string, unknown> }) => {
          const n = payload.new as
            | { id: string; type: string; body?: string; link?: string | null; post_id?: string | null }
            | undefined;
          if (!n?.id) return;
          const toggles = getPreferences().toggles;
          const on = (key: string, fallback: boolean) => toggles[key] ?? fallback;
          if (!on("notify_system", true)) return;
          const categoryToggle = CATEGORY_TOGGLES[n.type];
          if (categoryToggle && !on(categoryToggle, true)) return;
          // Own actions echo back as rows sometimes; never alert on those.
          if (!appOutOfSight()) return;

          const showBody = on("notify_preview", true) ? n.body : undefined;
          // The OS itself plays the alert sound (our chime would double it).
          void showSystemNotification({
            id: n.id,
            tag: `spaces-notif-${n.id}`,
            title: TITLES[n.type] ?? "New notification",
            body: showBody,
            url: routeFor(n),
            silent: !on("notify_sounds", true),
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);
}
