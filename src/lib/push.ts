import { api } from "./api";

/*
 * Web Push in the browser. The service worker (with public/push-sw.js) shows the notifications;
 * this file asks for permission and keeps the server's subscription for this browser in step.
 */

export type PushState = "unsupported" | "denied" | "off" | "on";

function pushSupported() {
  return (
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  );
}

/** iPhone and iPad only allow Web Push once pOS is added to the Home Screen. */
export function needsInstallForPush() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone && !("PushManager" in window);
}

async function registration() {
  // The service worker registers a little after launch (main.tsx); wait for it rather than failing.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("The app is still installing. Try again in a moment.")), 8000),
    ),
  ]);
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub && Notification.permission === "granted" ? "on" : "off";
  } catch {
    return "off";
  }
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Asks for permission (must run from a tap), subscribes this browser and tells the server. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration();
  const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key (a reset deployment) can't receive our pushes.
  const current = sub?.options.applicationServerKey;
  if (sub && current) {
    const a = new Uint8Array(current);
    const b = keyBytes(publicKey);
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api("/api/push/subscribe", { body: sub.toJSON() });
  return "on";
}

export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api("/api/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return Notification.permission === "denied" ? "denied" : "off";
}

/**
 * Re-sends this browser's subscription after sign-in, so a browser shared by two people pushes to whoever is
 * signed in now (the server moves the subscription to them).
 */
export async function resyncPush() {
  if ((await pushState()) !== "on") return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await api("/api/push/subscribe", { body: sub.toJSON() }).catch(() => undefined);
}
