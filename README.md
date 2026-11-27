# pOS

pOS is an installable web app for property owners in India. Rent, tenants, UPI payments, maintenance, utility meters, expenses and documents live in one place, and owners, staff and tenants each get their own view.

The whole product runs on Cloudflare's free tier: a single Worker serves the React PWA and the API, D1 stores the data and photos, and a Cron Trigger with a Queue runs the daily rent cycle.

## Features

- **Owners** manage properties, units, leases, tenants, rent charges, late fees, payment claims, receipts, rental agreements, move-out settlements, recurring expenses, reports, rent statements, invitations and backups.
- **Staff** work on their assigned units: maintenance requests, expenses and meter readings.
- **Tenants** see their rent and payment history, pay by UPI and tap "I have paid", read their lease, download receipts and statements, and raise maintenance requests.
- **Everyone** gets offline navigation with a sync queue, an installable app, Web Push notifications, English and Hindi, display and accessibility settings, quick search (Ctrl+K), and PDF documents drawn in the browser.
- **Anyone** can check a receipt at `/verify` to see whether it is genuine.

## Tech stack

| Layer    | Technology                                                                 |
| -------- | -------------------------------------------------------------------------- |
| Frontend | React 19, React Router 7, Vite 8, `vite-plugin-pwa` (Workbox)              |
| API      | Hono 4 on Cloudflare Workers                                               |
| Database | Cloudflare D1 (SQLite) with Drizzle ORM and Drizzle Kit migrations         |
| Jobs     | Cron Trigger at 00:30 UTC (06:00 IST), fanned out through Cloudflare Queues |
| AI       | Workers AI vision model reads meter photos (optional)                      |
| PDFs     | `pdf-lib` and `qrcode-generator`, rendered on the device                   |
| Tests    | `node:test` with Miniflare's local D1                                      |

## Quick start

You need Node.js 22.18 or newer. CI uses Node 24, the version pinned in `.nvmrc`.

```bash
npm ci
cp .dev.vars.example .dev.vars   # optional local settings
npm run dev:api                  # terminal 1: Worker and local D1 on http://localhost:8787
npm run dev                      # terminal 2: Vite on http://localhost:5173
```

Open http://localhost:5173 and create an owner account. Vite proxies `/api` to the local Worker, so the browser sees a single origin, just as it does in production. You don't need a Cloudflare login for local development.

## Deploy to Cloudflare

```bash
npm run cf:login                 # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npm run cf:setup                 # creates the D1 database and queue, writes database_id into wrangler.jsonc
npm run cf:secret -- CRON_SECRET # protects the manual daily-run endpoint
npm run deploy                   # builds, applies D1 migrations, publishes the Worker
```

The app is then live at `https://pos.<your-subdomain>.workers.dev`. Every push to `main` can deploy automatically through GitHub Actions. See [Deployment](docs/deployment.md).

## Scripts

| Command                                       | What it does                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run dev` / `npm run dev:api`             | Vite dev server / local Worker with local D1                                |
| `npm run preview`                             | Production build served through the local Worker                            |
| `npm run check`                               | TypeScript type-check of the app, Worker, shared code and tests             |
| `npm run format` / `npm run format:check`     | Prettier                                                                    |
| `npm test`                                    | Unit and API tests                                                          |
| `npm run verify`                              | Type-check, format check, tests, production build and a Worker dry run      |
| `npm run db:generate`                         | New Drizzle migration from `worker/db/schema.ts`, copied to `migrations/`   |
| `npm run db:migrate:local` / `db:migrate:remote` | Apply D1 migrations locally or in production                             |
| `npm run deploy` / `npm run deploy:dry`       | Deploy, or bundle without publishing                                        |
| `npm run smoke -- <url>`                      | Read-only health, asset and header checks against a running app            |
| `npm run cf:tail`                             | Stream production logs                                                      |
| `npm run cf:backup`                           | Export the production database to `backups/`                                |
| `npm run cf:reset-link -- <email> --url <app>` | Make a one-time password reset link when email is not set up              |
| `npm run cf:rollback`                         | Roll the Worker back to the previous version                                |

## Project layout

```text
src/            React PWA: screens by role, shared components, client libraries, styles, Hindi strings
worker/         Cloudflare Worker: entry point, Hono routes, domain logic, Drizzle schema
shared/         Code used by both browser and Worker (PDF layouts, login-key derivation)
drizzle/        Drizzle migrations and schema snapshot (generated)
migrations/     Flat copies of the migrations that Wrangler applies (generated)
public/         Static files: icons, share image, security headers, push service worker
scripts/        Local development, Cloudflare setup, backups, smoke test, migration sync
tests/          Unit tests and API tests against a local D1
docs/           Architecture, development, deployment, configuration and operations guides
```

## Documentation

- [Architecture](docs/architecture.md): how requests, data, jobs and offline support work
- [Development](docs/development.md): local setup, code layout, conventions, schema changes, tests
- [Deployment](docs/deployment.md): first deploy, GitHub Actions, custom domain, go-live checklist, free-plan limits
- [Configuration](docs/configuration.md): bindings, settings, secrets, email, Web Push, Workers AI
- [Operations](docs/operations.md): health, logs, backups, recovery, rollbacks, troubleshooting
