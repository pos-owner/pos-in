# Architecture

pOS is a React Progressive Web App backed by a Hono API. Both are deployed as one Cloudflare Worker with static assets, a D1 database, a Cron Trigger and a Queue.

```text
Browser ── /, /tenants, /verify/… ──▶ Cloudflare static assets (dist/) ──▶ React app
Browser ── /api/* ──────────────────▶ worker/index.ts ──▶ Hono routes ──▶ domain logic ──▶ D1
Cron 00:30 UTC ──▶ worker/index.ts ──▶ DAILY_QUEUE (one message per workspace) ──▶ daily rent cycle
```

## Requests

`wrangler.jsonc` runs the Worker only for `/api/*` (`assets.run_worker_first`). Every other path is a static file. Unknown paths get `index.html`, which lets client-side routes deep-link. Page loads, scripts, styles, fonts and icons never start the Worker, so they cost nothing against the Workers request quota.

The browser always calls the API on its own origin, so the session cookie is first-party and CORS doesn't apply. On each request, `worker/index.ts` hands the bindings to `setBindings()`, dispatches to the Hono app in `worker/server/routes.ts`, and adds the API security headers from `worker/server/core/secure.ts`. Static files get their headers from `public/_headers`.

### Server layout

| Path                           | Responsibility                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `worker/server/routes.ts`      | Hono app, workspace, property, tenant, rent, payment, request and expense endpoints     |
| `worker/server/*Routes.ts`     | Endpoint groups: auth, billing, documents, exports, leases, notifications, payments, tools |
| `worker/server/core/`          | Platform services: bindings and settings, auth and access rules, HTTP helpers, rate limits, signing, photo storage, mail, Web Push |
| `worker/server/domain/`        | Business logic: charges, allocation, payments, fees, leases, meters, settlements, statements, reports, notifications, the daily cycle |
| `worker/server/pdf/`           | Data for receipts, agreements and other printable documents                             |
| `worker/db/`                   | Drizzle schema (source of truth for every table) and the D1 connection                  |

Domain code reads bindings through `bindings()` and settings through `env()`, and never takes the Worker `env` object as an argument.

## Accounts and access

Accounts use email and password. To keep sign-in inside the Workers Free plan's 10 ms CPU budget, the browser stretches the password with 100,000 rounds of PBKDF2 (`shared/loginKey.ts`) and sends only the resulting key. The Worker hashes that key again with a random salt. Sessions are random tokens in an HTTP-only cookie, and D1 stores only their SHA-256 hash.

There are three roles. An **owner** has a workspace. **Staff** and **tenants** join a workspace through an invitation link with a PIN. `worker/server/core/access.ts` scopes every query to the caller's workspace and role.

## Data

D1 (binding `DB`) holds every table: accounts, sessions, workspaces, the rent ledger, documents, notifications, rate-limit counters and generated keys.

- **Photos** are stored as base64 text in the `photo_data` table. Browsers load them through short-lived HMAC-signed URLs (`/api/photos/:key`). The browser compresses each photo to about 450 KB, and the API rejects anything over 1.2 MB, which keeps each photo well inside D1's 2 MB row limit.
- **Money invariants** are enforced inside the database. D1 has no interactive transactions, so writes use guarded single statements, `db.batch()` (one implicit transaction), and SQLite triggers. For example, a confirmed payment can never take a month above what it costs, and a late fee adds itself to its charge.
- **PDFs** are drawn on the device. The API returns document data as JSON, and `shared/pdf/` lays out receipts, agreements, settlements, statements and reports with `pdf-lib`. The libraries load only when a PDF is first opened.

## Daily rent cycle

The Cron Trigger fires at `30 0 * * *` (06:00 IST). The scheduled handler lists owner workspaces, sends one `DAILY_QUEUE` message per workspace in batches of 100, and prunes expired sessions, reset links and rate-limit counters.

Each queue message runs `runDailyForOwner` (`worker/server/domain/daily.ts`), which:

1. creates rent charges that have come due, pro-rating partial months,
2. ends tenancies past their move-out or end date,
3. records the rent-reminder queue,
4. applies late fees,
5. generates recurring expenses,
6. raises lease-expiry alerts,
7. sends pending Web Push notifications.

Steps 4 to 7 are independent, so a failure in one is logged and the rest still run. A message that throws is retried after five minutes. The consumer takes one workspace per invocation (`max_batch_size: 1`), which keeps each run under the Free plan's limit of 50 D1 queries per invocation.

`POST /api/cron/daily` runs the cycle on demand. It needs the `x-cron-secret` header, and `?owner=<id>` limits the run to one workspace.

## PWA and offline

Vite builds the app into `dist/`, and `vite-plugin-pwa` generates the manifest and a Workbox service worker. The service worker precaches the app shell, scripts, styles and icons, but never API responses. On launch, the app paints from a small snapshot of the last session (`src/lib/launch.ts`) and refreshes it from the API.

Meter readings, maintenance requests and expenses made offline go into an IndexedDB outbox (`src/lib/outbox.ts`). The outbox syncs them when the device reconnects, and an idempotency key on each entry prevents duplicates. `public/push-sw.js` shows push notifications and opens the right screen when one is tapped.

## Frontend layout

| Path              | Contents                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `src/App.tsx`     | Routes and the role-based app shell; tool screens are lazy-loaded                          |
| `src/screens/`    | `auth`, `owner`, `staff`, `tenant`, `shared` (several roles), `tools` (receipts, meters, automations, reports, statements, QR codes) and `public` (receipt verification) |
| `src/components/` | UI kit, icons, quick search, photo picker, install prompt, notification bell              |
| `src/lib/`        | API client and cache, auth, offline outbox, push, i18n, formatting, PDFs, display settings |
| `src/styles/`     | `global.css` imports the design system partials; screen styles are imported by screens    |
| `src/i18n/hi.json`| Hindi translations, keyed by the English text                                              |
