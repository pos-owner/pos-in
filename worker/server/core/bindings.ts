import type { Ai, D1Database, Queue } from "@cloudflare/workers-types";

/**
 * Cloudflare bindings declared in wrangler.jsonc. The Worker entry (worker/index.ts) hands them over with
 * `setBindings(env)` on every request, cron run and queue batch. An isolate always serves one deployment, so
 * every call sees the same bindings object. Tests call `setBindings` with Miniflare's D1.
 */
export interface Bindings {
  /** D1: every table (worker/db/schema.ts), including photos (maintenance, comments, meter photos). */
  DB: D1Database;
  /** Workers AI: reads meter photos. Optional; without it people type the reading. */
  AI?: Ai;
  /** Queue: the daily cycle fans out one message per workspace (optional; without it the cron runs inline). */
  DAILY_QUEUE?: Queue<{ ownerId: string }>;
  /** Static assets (the React build in dist/). */
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  /** Plain-text settings (vars and secrets). */
  [name: string]: unknown;
}

let current: Bindings | null = null;

export function setBindings(env: Bindings) {
  current = env;
}

export function bindings(): Bindings {
  if (!current) throw new Error("Cloudflare bindings are not set (setBindings was never called).");
  return current;
}

/** True once a binding of that name is present (optional ones such as AI). */
export function hasBinding(name: string): boolean {
  return !!current && current[name] != null;
}

/**
 * Reads a plain-text setting: a `vars` entry in wrangler.jsonc or a secret (`wrangler secret put NAME`). Falls back
 * to `process.env` so Node tools and tests can set values too.
 */
export function env(name: string): string | undefined {
  let v: unknown;
  try {
    v = bindings()[name];
  } catch {
    v = undefined;
  }
  if (typeof v !== "string")
    v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
