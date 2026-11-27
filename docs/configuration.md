# Configuration

Bindings and plain-text settings live in `wrangler.jsonc`. Secrets are set with `npm run cf:secret -- NAME` (production) or in `.dev.vars` (local, git-ignored; start from `.dev.vars.example`). Server code reads bindings with `bindings()` and settings with `env("NAME")`.

## Bindings

| Name          | Type           | Required | Purpose                                       |
| ------------- | -------------- | -------- | --------------------------------------------- |
| `DB`          | D1 database    | Yes      | All application data, photos and generated keys |
| `ASSETS`      | Static assets  | Yes      | The PWA build in `dist/`                      |
| `DAILY_QUEUE` | Queue producer | Yes      | One daily-cycle message per workspace         |
| `AI`          | Workers AI     | No       | Reads meter photos                            |
| `EMAIL`       | Send Email     | No       | Password-reset email                          |

## Settings (`vars`)

| Name             | Default                                   | Purpose                                                        |
| ---------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `SIGNUPS`        | `open`                                    | `closed` stops new owner accounts; invites still work          |
| `APP_URL`        | Request origin                            | Public address for reset links and push; also read at build time for the share image |
| `METER_AI`       | `on`                                      | `off` hides meter-photo reading                                |
| `METER_AI_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` | Workers AI vision model                                        |
| `EMAIL_FROM`     | Unset                                     | Sender address for reset email                                 |
| `VAPID_SUBJECT`  | `APP_URL`                                 | Contact for push services (`mailto:` or HTTPS URL)             |

## Secrets

| Name                                    | Required | When unset                                   |
| --------------------------------------- | -------- | -------------------------------------------- |
| `CRON_SECRET`                           | Yes      | `POST /api/cron/daily` returns 403           |
| `SIGNING_SECRET`                        | No       | A key is generated and stored in D1          |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | No (set both or neither) | A key pair is generated and stored in D1 |

## Password-reset email

Optional. Without it, owners create reset links for staff and tenants in the app, and `npm run cf:reset-link` covers the owner. To enable it, set up a Cloudflare Email Service sending domain, then add `"send_email": [{ "name": "EMAIL" }]` and set `EMAIL_FROM` and `APP_URL`.

## Web Push

The Worker implements VAPID and payload encryption with Web Crypto. Browsers fetch the public key from `/api/push/key` and subscribe through `/api/push/subscribe`; `public/push-sw.js` shows notifications. Changing the VAPID keys means every device has to subscribe again.

## Workers AI

With the `AI` binding, a user can photograph a meter and get a suggested reading, which they must confirm before it's saved. Set `METER_AI=off` to turn it off without removing the binding.

## Build-time and local settings

- `APP_URL` at build time makes the `og:image` URL absolute (WhatsApp needs this).
- `POS_API` changes the Vite dev proxy target (default `http://localhost:8787`).
- `D1_LOCATION` sets the region hint used by `npm run cf:setup`.
