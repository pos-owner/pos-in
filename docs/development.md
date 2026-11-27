# Development

## Setup

Use Node.js 22.18 or newer (`.nvmrc` pins 24).

```bash
npm ci
cp .dev.vars.example .dev.vars   # optional: local values for settings and secrets
npm run dev:api                  # terminal 1: wrangler dev + local D1 at http://localhost:8787
npm run dev                      # terminal 2: Vite with hot reload at http://localhost:5173
```

`npm run dev:api` syncs and applies the migrations to the local D1 database, then starts `wrangler dev`. Workers AI has no local emulator, and its binding would force a Cloudflare login. So by default the script starts Wrangler from a generated `wrangler.dev.jsonc` (git-ignored) that leaves the AI binding out, and meter-photo reading reports itself unavailable. To call the real Workers AI service, log in with `npm run cf:login` and run `npm run dev:api -- --ai`.

Vite proxies `/api` to `http://localhost:8787`. Set `POS_API` to point the proxy somewhere else.

To check production behaviour (service worker, install prompt, static headers, SPA fallback), run `npm run preview`. It builds the app and serves `dist/` through the local Worker on port 8787.

### Local data

The local D1 database lives in `.wrangler/state/`. Deleting that folder resets it.

```bash
npx wrangler d1 execute DB --local --command "SELECT id, email FROM users"
npm run cf:backup -- --local
```

To run the daily cycle locally, start Wrangler with `--test-scheduled` and call the scheduled endpoint, or call the API with the `CRON_SECRET` value from `.dev.vars`:

```bash
npm run dev:api -- --test-scheduled
curl "http://localhost:8787/__scheduled?cron=30+0+*+*+*"
curl -X POST http://localhost:8787/api/cron/daily -H "x-cron-secret: local-cron-secret"
```

## Conventions

- **TypeScript everywhere.** The browser, the Worker, shared code and tests share one `tsconfig.json`. `npm run check` type-checks all of them.
- **Explicit `.ts` extensions** in Worker, shared and test imports. Node runs the tests with type stripping, so `enum` and `namespace` are not allowed.
- **Bindings and settings:** use `bindings()` and `env("NAME")` from `worker/server/core/bindings.ts`. Never pass the Worker `env` object through domain code.
- **No interactive transactions:** D1 doesn't support them. Keep related writes consistent with guarded single statements, `db.batch()`, or triggers.
- **Headers:** API security headers live in `worker/server/core/secure.ts`, and static file headers in `public/_headers`.
- **Secrets** go in `wrangler secret put` (production) or `.dev.vars` (local), never in `wrangler.jsonc`.
- **Dependencies:** every imported package must be listed in `package.json`, or `tests/unit/dependencies.test.ts` fails.
- **Formatting:** Prettier with a 120-character line width. Run `npm run format` before committing.
- **Translations:** English strings are the keys in `src/i18n/hi.json`. Any string missing there falls back to English.
- **Dark mode:** display preferences are data attributes on `<html>` (`src/lib/display.ts`). Dark-mode rules must cover both `@media (prefers-color-scheme: dark)` with `:root:not([data-theme="light"])`, and `:root[data-theme="dark"]`.

## Database schema changes

`worker/db/schema.ts` is the source of truth. A migration lives in two forms:

```text
worker/db/schema.ts
  → drizzle/<timestamp>_<name>/migration.sql + snapshot.json   (drizzle-kit generate)
  → migrations/<timestamp>_<name>.sql                          (scripts/migrations.mjs, read by Wrangler)
```

```bash
npm run db:generate        # writes the Drizzle migration and syncs migrations/
npm run db:migrate:local   # apply it to the local database
npm test
```

For hand-written SQL such as triggers or data fixes, start from an empty migration with `npx drizzle-kit generate --config drizzle.d1.config.ts --custom --name <verb_noun>`, write the SQL, then run `npm run db:sync`. Separate statements with `--> statement-breakpoint`.

Commit the schema change, the Drizzle folder and the flat migration together. Don't edit generated files by hand, and never change a migration that has already been applied to a shared database. Keep migrations additive (new tables, nullable or defaulted columns), so the previous Worker version keeps working while a deploy rolls out.

## Tests

```bash
npm test          # all tests
npm run verify    # type-check, format check, tests, production build and Worker dry run
```

- `tests/unit/` covers pure logic: rent and pro-rating, allocation, billing rules, access rules, formatting, i18n, device naming, push endpoint validation and the launch snapshot.
- `tests/api/` drives the real Hono app in Node against Miniflare's local D1, with every migration applied. Each test file gets its own empty database. `tests/helpers/app.ts` provides `startApp()`, signed-in clients and raw SQL access, and `tests/helpers/workspace.ts` builds a sample workspace.

`npm run smoke` runs read-only checks against a running app (local by default, or pass a URL). `--write` also creates a throwaway account, so use it only on a local or staging database.
