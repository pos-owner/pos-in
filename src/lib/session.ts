/*
 * The pOS API is served by the same Cloudflare Worker as this app, so every call is same-origin: the session lives in
 * an HttpOnly cookie the browser sends by itself, and no token ever touches JavaScript. `npm run dev` proxies /api
 * to `wrangler dev` (see vite.config.ts).
 */

/** Absolute URL for an API path such as `/api/me` (also used for signed `/api/photos/...` links). */
export function apiUrl(path: string): string {
  return path;
}

/** A password-reset link (`/?reset=<token>`) opened on this page load, read before the URL is cleaned. */
function readResetToken(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("reset") ?? "";
}
export const resetToken = readResetToken();

/** Removes the reset token from the address bar so it doesn't stay in history or get shared by accident. */
export function clearResetFromUrl() {
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("reset")) return;
    u.searchParams.delete("reset");
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  } catch {
    /* nothing to clean */
  }
}

export interface AuthConfig {
  /** "Forgot password?" emails are set up on this deployment. */
  email: boolean;
  /** New owners may sign up. */
  signups: boolean;
  minPassword: number;
}
