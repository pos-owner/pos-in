// Exports the production D1 database to a dated SQL file in backups/ (git-ignored). D1 also keeps its own
// point-in-time history (Time Travel: 7 days on Workers Free, 30 on Paid); this is the copy you keep yourself. See docs/operations.md.
//
//   npm run cf:backup                 production database
//   npm run cf:backup -- --local      the `wrangler dev` database
//   npm run cf:backup -- --schema     structure only (no rows)
import { execFileSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const local = args.includes("--local");
const schemaOnly = args.includes("--schema");

const dir = join(import.meta.dirname, "..", "backups");
await mkdir(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const file = join(dir, `pos-${local ? "local" : "remote"}-${schemaOnly ? "schema-" : ""}${stamp}.sql`);

execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "export",
    "DB",
    local ? "--local" : "--remote",
    "--output",
    file,
    ...(schemaOnly ? ["--no-data"] : []),
  ],
  { stdio: "inherit" },
);
console.log(
  `\nBackup written: backups/${file.split(/[\\/]/).pop()} (${((await stat(file)).size / 1024).toFixed(0)} KiB)`,
);
console.log("Restore into an empty database with: npx wrangler d1 execute <database> --remote --file <backup.sql>");
