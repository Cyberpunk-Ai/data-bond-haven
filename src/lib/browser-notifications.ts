/**
 * System (OS-level) notifications for the signed-in user.
 *
 * The app shows toasts/badges in the foreground; this module is what makes
 * the app feel like the social apps on the phone or desktop: when the tab is
 * hidden or the window is unfocused, new messages, calls and engagement land
 * in the OS notification center instead. Everything is gated by the
 * per-account preference toggles (Settings → Notifications) and the browser
 * permission, and goes through the service worker (public/sw.js) so clicks
 * focus the right route and call alerts get Answer/Decline buttons.
 */

export type SystemNotification = {
  /** Notification tag — later alerts with the same tag replace this one. */
  tag?: string;
  /** Arbitrary stable id (e.g. call id) surfaced back on action clicks. */
  id?: string;
  title: string;
  body?: string;
  /** In-app route to open when the notification is clicked. */
  url?: string;
  /** Keep the alert on screen until dismissed/clicked (calls). */
  requireInteraction?: boolean;
  /** True suppresses the OS sound (we may play our own chime instead). */
  silent?: boolean;
  actions?: Array<{ action: string; title: string }>;
};

export function notificationsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator
  );
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

let swRegistration: Promise<ServiceWorkerRegistration | null> | undefined;

/** Registers /sw.js once; failures are tolerated (in-app UI still works). */
export function ensureNotificationsWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!swRegistration) {
    swRegistration = navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch(() => null);
  }
  return swRegistration;
}

/**
 * Asks for OS permission (must run inside a user gesture — the settings
 * toggle handler does exactly that). Returns the resulting state.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  await ensureNotificationsWorker();
  if (Notification.permission === "default") {
    try {
      // Prefer the modern callback-style promise where available.
      const result = await new Promise<NotificationPermission>((resolve) => {
        const maybe = Notification.requestPermission(resolve);
        if (maybe && typeof (maybe as Promise<NotificationPermission>).then === "function") {
          void (maybe as Promise<NotificationPermission>).then(resolve).catch(() => resolve("denied"));
        }
      });
      return result;
    } catch {
      return Notification.permission;
    }
  }
  return Notification.permission;
}

/** Shows an OS notification through the service worker (direct fallback). */
export async function showSystemNotification(n: SystemNotification): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  const options: NotificationOptions = {
    body: n.body,
    tag: n.tag ?? (n.id ? `spaces-${n.id}` : undefined),
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    requireInteraction: n.requireInteraction,
    // `silent: true` is honored broadly; `silent: false` is just the default.
    silent: n.silent,
    data: { url: n.url ?? "/", callId: n.id },
  } as NotificationOptions;
  try {
    const reg = await ensureNotificationsWorker();
    if (reg) {
      const actions = (n.actions ?? []).map((a) => ({ ...a, icon: "/icon-192.png" }));
      // NotificationAction isn't in the DOM lib TS loads — inline the shape.
      await reg.showNotification(n.title, {
        ...options,
        actions,
      } as NotificationOptions & { actions?: Array<{ action: string; title: string; icon?: string }> });
    } else if (typeof window !== "undefined") {
      new Notification(n.title, options);
    }
  } catch {
    /* platform refused (mobile browsers without actions, etc.) — ignore */
  }
}

/**
 * Short two-tone chime for notification arrival. Deliberately not a ringtone
 * — calls already ring through IncomingCallProvider. Autoplay policies can
 * block audio before any user gesture; failing silently is fine.
 */
export function playNotifyChime(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const play = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.start(t);
      osc.stop(t + 0.3);
    };
    play(660, 0);
    play(880, 0.12);
    setTimeout(() => void ctx.close().catch(() => {}), 900);
  } catch {
    /* blocked or unsupported */
  }
}
