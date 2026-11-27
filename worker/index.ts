/**
 * pOS on Cloudflare: one Worker serves the React app (static assets) and the whole API.
 *
 *  - fetch      /api/*  → Hono API (worker/server/routes.ts). Everything else is a static asset from dist/, with the
 *               single-page-app fallback (wrangler.jsonc `assets`). The Worker only runs for /api/* requests.
 *  - scheduled  Cron Trigger at 00:30 UTC (06:00 IST): the daily rent cycle. With the DAILY_QUEUE binding it sends
 *               one message per workspace, so each one runs (and retries) on its own; otherwise it runs inline.
 *  - queue      Consumer for DAILY_QUEUE.
 *
 * Bindings: D1 (DB), Workers AI (AI), Queues (DAILY_QUEUE), static assets (ASSETS), optional EMAIL.
 * Deploy: `npm run deploy` (see docs/deployment.md). D1 migrations are applied by Wrangler before the Worker is published.
 */
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import api from "./server/routes.ts";
import { setBindings, type Bindings } from "./server/core/bindings.ts";
import { isApiPath, secure } from "./server/core/secure.ts";
import { ownerIds, pruneExpired, runDailyCycle, runDailyForOwner } from "./server/domain/daily.ts";

async function scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
  setBindings(env);
  const queue = env.DAILY_QUEUE;
  if (!queue) {
    ctx.waitUntil(runDailyCycle().then((r) => console.log("daily cycle", JSON.stringify(r))));
    return;
  }
  const ids = await ownerIds();
  // sendBatch takes at most 100 messages.
  for (let i = 0; i < ids.length; i += 100) {
    await queue.sendBatch(ids.slice(i, i + 100).map((ownerId) => ({ body: { ownerId } })));
  }
  ctx.waitUntil(pruneExpired().then((n) => console.log(`daily cycle queued ${ids.length} workspaces, pruned ${n}`)));
}

async function queue(batch: MessageBatch<{ ownerId: string }>, env: Bindings) {
  setBindings(env);
  for (const msg of batch.messages) {
    try {
      const r = await runDailyForOwner(msg.body.ownerId);
      console.log("daily cycle", msg.body.ownerId, JSON.stringify(r));
      msg.ack();
    } catch (e) {
      console.error("daily cycle failed for a workspace; retrying", e);
      msg.retry({ delaySeconds: 300 });
    }
  }
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    setBindings(env);
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) {
      return secure(await api.fetch(request, env, ctx as never));
    }
    // Only reached if `run_worker_first` is widened; normal asset requests never start the Worker.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
  scheduled,
  queue,
};
