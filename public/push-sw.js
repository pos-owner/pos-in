/*
 * Web Push for pOS (milestone 5). The generated service worker (vite-plugin-pwa / Workbox) loads this file with
 * importScripts, so it runs in the same worker that caches the app shell. The Worker sends an encrypted JSON
 * payload: { title, body, url, tag, id } (see worker/server/domain/notifications.ts).
 */
/* eslint-disable no-restricted-globals */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "pOS";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/monochrome-512.png",
    data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/notifications", id: data.id },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/notifications";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open pOS window when there is one, otherwise open the app on that screen.
      for (const client of all) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              client.postMessage({ type: "pos:navigate", url });
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

/* The browser rotated the subscription: tell pOS about the new one so pushes keep arriving. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const sub =
        event.newSubscription ||
        (old && old.options ? await self.registration.pushManager.subscribe(old.options) : null);
      if (!sub) return;
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-pos-client": "1" },
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
