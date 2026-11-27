/**
 * Response hardening for every API response (applied in worker/index.ts). Static assets get their headers from
 * public/_headers instead.
 */

/** True for `/api` and everything under `/api/` (the only paths the Worker code answers). */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** Adds the security headers every API response carries, and `no-store` unless a route chose its own caching. */
export function secure(res: Response): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("x-frame-options", "DENY");
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  return out;
}
