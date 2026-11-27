# Deployment

pOS deploys as one Cloudflare Worker. `npm run deploy` builds the PWA into `dist/`, applies pending D1 migrations with `wrangler d1 migrations apply DB --remote`, then publishes the Worker. If a migration fails, the Worker is not published.

## First deployment

You need a Cloudflare account and Node.js 22.18 or newer.

```bash
npm ci
npm run cf:login        # interactive; in CI use CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npm run cf:whoami
npm run cf:setup
npm run cf:secret -- CRON_SECRET
npm run deploy
```

`npm run cf:setup` creates (or finds) the D1 database `pos` and the queue `pos-daily`, and writes the database id into `wrangler.jsonc`. It's safe to run again. The database is created with the `apac` location hint. To choose another region, set `D1_LOCATION` to `wnam`, `enam`, `weur`, `eeur`, `apac` or `oc`. The region is fixed once the database is created.

Commit the updated `wrangler.jsonc`, so local commands and CI target the same database.

Open `https://pos.<your-subdomain>.workers.dev`, create the first owner account and finish onboarding. `https://pos.<your-subdomain>.workers.dev/api/health` should return `{ "ok": true, "db": true }`.

If public owner sign-ups aren't wanted, set `"SIGNUPS": "closed"` in `wrangler.jsonc` once the owner accounts exist, then deploy again. Invited staff and tenants can always join.

## GitHub Actions

`.github/workflows/cloudflare.yml` runs on pull requests, on pushes to `main`, and on demand:

| Event                        | Jobs                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Pull request                 | `npm ci`, type-check, format check, tests, `npm run deploy:dry`                  |
| Push to `main` or manual run | The same checks, then `npm run cf:setup`, `npm run deploy` and a smoke test       |

Add these to the repository under **Settings → Secrets and variables → Actions**:

| Name                    | Kind     | Value                                                                    |
| ----------------------- | -------- | ------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | Secret   | API token with Workers Scripts, D1 and Queues edit permissions for the account |
| `CLOUDFLARE_ACCOUNT_ID` | Secret   | The Cloudflare account id                                                |
| `APP_URL`               | Variable | Optional public URL. It makes the link-preview image absolute and enables the post-deploy smoke test |

The deploy job uses the `production` environment, so you can require reviewers there. Deploys never run in parallel. Worker secrets such as `CRON_SECRET` are set once with Wrangler or in the dashboard. The workflow does not manage them.

## Custom domain

The domain must be a zone in the same Cloudflare account. Add a route in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "pos.example.com", "custom_domain": true }]
```

Set `"APP_URL": "https://pos.example.com"` in `vars`, then deploy. Cloudflare creates the DNS record and certificate. Once the domain works, you can set `"workers_dev": false`. Session cookies are tied to the host, so people sign in again on the new address.

Serve pOS from the root of a subdomain, not from a path: the app and its service worker expect to live at `/`. `public/_headers` sends HSTS with `includeSubDomains`. Check that this suits the other subdomains of the zone.

## Go-live checklist

**Account**

- [ ] Two-factor authentication is on for every Cloudflare account member.
- [ ] The D1 location hint is right for your users. It can't be changed later.
- [ ] The API token used by CI is scoped to this account and nothing more.

**Configuration**

- [ ] `CRON_SECRET` is set to a long random value.
- [ ] `APP_URL` is set when a custom domain is used.
- [ ] `SIGNUPS` is `closed` if public owner sign-ups aren't wanted.
- [ ] Optional features are decided: meter-photo AI (`METER_AI`), password-reset email (`EMAIL` and `EMAIL_FROM`).
- [ ] No secret values appear in `wrangler.jsonc`, the repository or CI logs.

**Verify**

- [ ] `npm run verify` passes.
- [ ] `npm run db:list` shows every migration applied.
- [ ] `/api/health` reports `ok: true`.
- [ ] The dashboard shows the `30 0 * * *` Cron Trigger and the `pos-daily` consumer.
- [ ] `npm run smoke -- https://your-app.example` passes.
- [ ] An owner can onboard, add a property and unit, and invite a tenant.
- [ ] A tenant payment claim can be confirmed, and its receipt verifies at `/verify`.
- [ ] Photo upload, push notifications and the installed app work on a real phone.
- [ ] A database backup has been taken (`npm run cf:backup`) and stored outside Cloudflare.

## Free plan limits

pOS is designed to run on the Workers Free plan with no paid add-ons. These are Cloudflare's published free allowances at the time of writing. Check the current limits before relying on them.

| Resource                 | Free allowance                         | How pOS stays inside it                                                                      |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Worker requests          | 100,000 per day                        | Only `/api/*` runs the Worker; static files are free asset requests                         |
| Worker CPU               | 10 ms per invocation                   | Passwords are stretched and PDFs drawn in the browser; photos are stored as text             |
| D1 queries / subrequests | 50 per invocation                      | Routes batch their queries; the queue consumer handles one workspace per invocation          |
| Worker size              | 3 MB compressed                        | The React app is static assets; `npm run deploy:dry` shows the bundle size                   |
| D1 storage               | 500 MB per database, 5 GB per account  | Photos are compressed to about 450 KB on the device                                          |
| D1 rows                  | 5 M read, 100 k written per day        | Indexed, workspace-scoped queries; the daily cycle touches only due records                  |
| Queues                   | 10,000 operations per day              | About three operations per workspace per day                                                 |
| Cron Triggers            | 5 per account                          | One trigger                                                                                  |
| Workers AI               | 10,000 neurons per day                 | Used only when someone scans a meter photo; `METER_AI=off` disables it                       |
| Workers Logs             | 200,000 events per day                 | Lower `observability.head_sampling_rate` in `wrangler.jsonc` on a busy deployment            |

When a free daily allowance runs out, Cloudflare returns errors for the rest of the UTC day; it does not bill you. The Workers Paid plan raises every limit with no code changes. Keep the queue bound: without `DAILY_QUEUE`, the cron runs every workspace in a single invocation and hits the 50-query limit very quickly.
