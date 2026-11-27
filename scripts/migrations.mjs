// Copies Drizzle migrations into the flat layout Wrangler reads. Safe to re-run: files are only written when their
// content changed.
//
//   drizzle/<timestamp>_<name>/migration.sql   written by `drizzle-kit generate` (with its snapshot)
//     ↓
//   migrations/<timestamp>_<name>.sql          applied by `wrangler d1 migrations apply`
//
// Runs as part of `npm run db:generate`, `npm run build` and `npm run dev:api`.
// Hand-written SQL (triggers, backfills) starts as an empty Drizzle migration:
//   npx drizzle-kit generate --config drizzle.d1.config.ts --custom --name <verb_noun>
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const drizzleDir = join(root, "drizzle");
const flatDir = join(root, "migrations");

await mkdir(flatDir, { recursive: true });
let synced = 0;
for (const name of existsSync(drizzleDir) ? (await readdir(drizzleDir)).sort() : []) {
  const src = join(drizzleDir, name, "migration.sql");
  if (!existsSync(src)) continue;
  const body = `-- Generated from drizzle/${name}/migration.sql by scripts/migrations.mjs. Do not edit.\n${await readFile(src, "utf8")}\n`;
  const dest = join(flatDir, `${name}.sql`);
  if (existsSync(dest) && (await readFile(dest, "utf8")) === body) continue;
  await writeFile(dest, body);
  synced++;
  console.log(`synced migrations/${name}.sql`);
}
console.log(synced ? `${synced} migration(s) synced to migrations/` : "migrations/ is up to date");
