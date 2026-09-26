// Service worker powering system notifications (desktop / Android / iOS).
//
// Two delivery paths share this file:
//   1. `push`            — future real Web Push (needs a VAPID push relay).
//                          Wired up now so enabling it later is server-only.
//   2. reg.showNotification() called from the app (src/lib/browser-notifications.ts)
//        while the tab is hidden/unfocused — messages, calls and engagement
//        reach the OS notification center even though the browser is in the
//        background.
//
// notificationclick focuses the app at the right route; call notifications
// carry Answer/Decline actions which are relayed to the app via postMessage.

const ICON = "/icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Spaces1", options: { body: event.data ? event.data.text() : "" } };
  }
  const { title = "Spaces1", options = {}, url = "/" } = data || {};
  event.waitUntil(
    self.registration.showNotification(title, {
      icon: ICON,
      badge: ICON,
      data: { url },
      ...options,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const action = event.action;
  const data = notification.data || {};

  // Answer / Decline on an incoming-call notification: relay to the app
  // instead of navigating. The modal/state lives in IncomingCallProvider.
  if (action === "answer" || action === "decline") {
    notification.close();
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((list) => {
        for (const client of list) {
          client.postMessage({ type: "call-notification-action", action, callId: data.callId });
        }
      }),
    );
    return;
  }

  notification.close();
  event.waitUntil(
    (async () => {
      const targetUrl = new URL(data.url || "/", self.location.origin).href;
      const list = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      const existing = list.find((c) => c.url.startsWith(new URL(targetUrl).origin));
      if (existing) {
        await existing.focus();
        try {
          if (typeof existing.navigate === "function" && existing.url !== targetUrl) {
            await existing.navigate(targetUrl);
          }
        } catch {
          /* cross-origin/opener restrictions — focusing is still useful */
        }
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
