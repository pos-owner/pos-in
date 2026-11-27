# Operations

## Health and logs

`GET /api/health` returns `{ "ok": true, "db": true }` when D1 answers, or 503 if it doesn't.

```bash
npm run cf:tail                    # live logs
npx wrangler tail --status error
npx wrangler deployments list
npm run smoke -- https://your-app.example   # read-only checks
```

## Backups

```bash
npm run cf:backup                  # production SQL export into backups/
npm run cf:backup -- --schema      # structure only
```

Exports include photos, personal data and generated keys, so store them securely outside Cloudflare. D1 Time Travel also offers point-in-time recovery. Owners can export their own workspace in the app under More → Export & backup.

To restore, import the export into an empty database with `npx wrangler d1 execute <database> --remote --file <backup.sql>`, check the data, then point `database_id` at it.

## Rollback

`npm run cf:rollback` restores the previous Worker version. A rollback does not undo D1 migrations, which is why migrations stay additive.

## Emergency password reset

```bash
npm run cf:reset-link -- owner@example.com --url https://pos.example.com
```

The link works once and expires after one hour. Share it through a trusted channel.

## Incident response

- Revoke sessions in Settings → Security → Signed-in devices, or delete rows from `sessions`.
- Rotating `SIGNING_SECRET` invalidates existing photo links. Rotating the VAPID keys means devices have to subscribe again.
- Keep logs and a backup before you repair any data.

## Troubleshooting

| Symptom                           | Check                                                              |
| --------------------------------- | ------------------------------------------------------------------ |
| Auth or account errors on deploy  | `npm run cf:whoami`, token scopes, `CLOUDFLARE_ACCOUNT_ID`         |
| Invalid D1 id or missing queue    | Run `npm run cf:setup`                                             |
| Migration failed                  | The Worker was not published; fix forward with a new migration     |
| `/api/health` returns 503         | `DB` binding and D1 logs                                           |
| No rent charges were created      | Cron Trigger, queue consumer and daily-cycle logs                  |
| `/api/cron/daily` returns 403     | `CRON_SECRET` and the `x-cron-secret` header                       |
| Photo upload rejected             | Must be JPEG, PNG or WebP, at most 1.2 MB                          |
| Meter scan unavailable            | `AI` binding and `METER_AI` (local dev omits AI by default)        |
| API returns 429                   | A rate limit was hit; wait for its window to expire                |
