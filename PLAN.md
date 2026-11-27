# Polish plan

1. **Done:** Walk every owner, tenant and staff screen in a real browser (light, dark, phone and desktop widths). No runtime errors or failed requests were found.
2. **Done:** Colour contrast meets WCAG AA. New `--accent-fill`, `--green-fill`, `--red-fill` and `--purple-fill` tokens sit behind white text, and the text tokens are darker in light mode and lighter in dark mode.
3. **Done:** One `<main>` landmark per screen (`Page` renders `main`), headings in the right order in empty states, and one shared priority label and pill (`PriorityPill`, `priorityLabel`).
4. **Done:** The owner Home "Collect" button shrinks to a round + while scrolling and is translated.
5. **Done:** The last contrast fixes. Tinted buttons use `--accent-press`, pills inside banners sit on the card background so their `-text` colour keeps 4.5:1, the Statements balance uses `--orange-text`, and inline `var(--red)`/`var(--accent)` text in ChargeSheet, Invites, Recurring, Properties and NotificationSection uses the `-text`/`-press` tokens.
6. **Done:** The tenant Profile screen renders the name as its `h1`.
7. **Done:** Hindi coverage. Every screen calls `useT()` (or `tr()` outside components) for the text it renders, and `src/i18n/hi.json` has about 1,000 new entries (1,270 in total).
8. **Remaining:** Deploy. `npm run check`, `npm run format:check` and `npm test` (114 tests) pass. Still to do with Cloudflare credentials: `npm run deploy:dry`, then `npm run cf:setup` (fills in the D1 `database_id`, still the zero placeholder in `wrangler.jsonc`), `npm run cf:secret -- CRON_SECRET` and `npm run deploy`. In GitHub Actions, add the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets; until then the deploy job skips with a notice. Everything stays on Cloudflare's free plan: Workers, D1, Queues, Cron and Workers AI.
