import { toast } from "sonner";

import { hydrateAuthors } from "@/lib/api-client";
import { getProfile, currentUserId } from "@/lib/profile-service";
import { useRealtime } from "@/lib/realtime";

/**
 * Notification ids already toasted this session. Module-level so the toast
 * fires exactly once per notification even if several components react to the
 * same live event (the bell, the notifications page, this hook).
 */
const toasted = new Map<string, number>();

function markToasted(id: string): boolean {
  const now = Date.now();
  for (const [k, t] of toasted) if (now - t > 120_000) toasted.delete(k);
  if (toasted.has(id)) return false;
  toasted.set(id, now);
  return true;
}

/**
 * Mounted once by the AppShell: every notification the database addresses to
 * the signed-in user arrives through the realtime change feed and pops a toast
 * anywhere in the app — not only while the notifications page is open.
 */
export function useNotificationToasts() {
  useRealtime((event: any) => {
    if (event?.type !== "notification") return;
    const notif = event.notification ?? (event.recipient_id ? event : null);
    if (!notif?.id || notif.recipient_id !== currentUserId) return;
    if (!markToasted(String(notif.id))) return;

    // Resolve the actor first so the toast reads "Ada sent you a tip of $5.00"
    // instead of a bare uuid, then show it. No actor (payouts, system notices)
    // falls back to the platform name.
    void hydrateAuthors([notif.actor_id]).finally(() => {
      const who = notif.actor_id ? getProfile(notif.actor_id).display_name : "Spaces1";
      toast.info(`${who} ${notif.body ?? ""}`.trim(), {
        description: undefined,
        duration: 5000,
      });
    });
  }, []);
}
