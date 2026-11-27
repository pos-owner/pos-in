/**
 * Route-test harness: runs the real Hono API (`worker/server/routes.ts`) in Node against Miniflare's local D1
 * (the same SQLite engine `wrangler dev` uses), with every migration in `migrations/` applied.
 * Each test file gets its own Miniflare instance, so its database starts empty. Nothing leaves the machine.
 * Not named *.test.ts, so `npm test` only runs it through the route tests.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { setBindings } from "../../worker/server/core/bindings.ts";
import { sha256 } from "../../worker/server/core/password.ts";

interface TestUser {
  id: string;
  email: string;
  name: string;
}

export interface Client {
  get: (path: string) => Promise<Res>;
  post: (path: string, body?: unknown) => Promise<Res>;
  patch: (path: string, body?: unknown) => Promise<Res>;
  del: (path: string) => Promise<Res>;
  upload: (path: string, bytes: Uint8Array, type: string) => Promise<Res>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Res {
  status: number;
  body: any;
  headers: Headers;
}

/** Applies `migrations/*.sql` in order, one statement per `--> statement-breakpoint`, like wrangler does. */
async function applyMigrations(d1: D1Database) {
  const dir = join(import.meta.dirname, "../../migrations");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) {
    const text = await readFile(join(dir, name), "utf8");
    for (const raw of text.split("--> statement-breakpoint")) {
      // Drop comment-only lines so a chunk that is just a header comment isn't sent as an empty statement.
      const stmt = raw
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (stmt) await d1.prepare(stmt).run();
    }
  }
}

export async function startApp() {
  // Miniflare 5 takes build-output configs; the converter accepts the familiar flat options.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
      compatibilityDate: "2026-11-01",
      d1Databases: { DB: "pos-test" },
    }),
  );
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await d1.prepare("PRAGMA foreign_keys = ON").run();
  await applyMigrations(d1);
  setBindings({ DB: d1, CRON_SECRET: "test-cron-secret", SIGNING_SECRET: "test-signing-secret" });

  const { default: api } = await import("../../worker/server/routes.ts");

  /** Runs SQL straight against D1 and returns the rows (`?` placeholders). */
  async function sql<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> {
    const r = await d1
      .prepare(query)
      .bind(...params)
      .all<T>();
    return r.results;
  }
  /** Runs one statement (a trigger with its BEGIN ... END body counts as one). */
  async function run(query: string, ...params: unknown[]) {
    await d1
      .prepare(query)
      .bind(...params)
      .run();
  }

  async function call(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { "x-pos-client": "1", ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await api.request(path, { method, headers, body: payload });
    const type = res.headers.get("content-type") ?? "";
    const parsed = type.includes("json")
      ? await res.json()
      : type.includes("pdf")
        ? new Uint8Array(await res.arrayBuffer())
        : await res.text();
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /**
   * Creates an account (no password needed in tests) with a live session and returns an API client that sends the
   * session token as a bearer token. The account is written before the client's first request goes out.
   */
  function signIn(user: TestUser): Client {
    const token = `token-${user.id}-${crypto.randomUUID()}`;
    const ready = (async () => {
      const now = Date.now();
      await d1
        .prepare(
          "insert or ignore into users (id, email, name, password_hash, created_at, password_changed_at) values (?, ?, ?, 'p2$test', ?, ?)",
        )
        .bind(user.id, user.email, user.name, now, now)
        .run();
      await d1
        .prepare("insert into sessions (token_hash, user_id, created_at, expires_at, seen_at) values (?, ?, ?, ?, ?)")
        .bind(await sha256(token), user.id, now, now + 86_400_000, now)
        .run();
    })();
    const send = async (method: string, p: string, b?: unknown) => {
      await ready;
      return call(token, method, p, b);
    };
    return {
      get: (p) => send("GET", p),
      post: (p, b) => send("POST", p, b ?? {}),
      patch: (p, b) => send("PATCH", p, b ?? {}),
      del: (p) => send("DELETE", p),
      upload: (p, bytes, type) => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(bytes)], "photo", { type }));
        return send("POST", p, form);
      },
    };
  }

  async function close() {
    await mf.dispose();
  }

  /** The raw session token from a response's Set-Cookie (sign up, sign in, password change, reset). */
  function sessionToken(res: Res): string {
    const m = /(?:^|[\s,])(?:__Host-)?pos_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
    if (!m) throw new Error("no session cookie in the response");
    return decodeURIComponent(m[1]);
  }

  return { api, d1, sql, run, call, signIn, sessionToken, close };
}
export type TestApp = Awaited<ReturnType<typeof startApp>>;
