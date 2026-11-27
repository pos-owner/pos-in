// One-time Cloudflare setup: creates the D1 database and the daily queue named in
// wrangler.jsonc, then writes the new database_id into wrangler.jsonc. Safe to re-run: anything that already exists
// is left alone. Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN) first.
//
//   npm run cf:setup
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const file = join(import.meta.dirname, "..", "wrangler.jsonc");
const config = await readFile(file, "utf8");

const pick = (re, fallback) => config.match(re)?.[1] ?? fallback;
const dbName = pick(/"database_name"\s*:\s*"([^"]+)"/, "pos");
const queue = pick(/"queue"\s*:\s*"([^"]+)"/, "pos-daily");
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

// Where D1 keeps the primary database. Without a hint Cloudflare picks the region nearest to where this script runs,
// which for GitHub Actions is usually the US, so every query from India would cross an ocean. Fixed when the database
// is created and cannot be changed later. Override with D1_LOCATION=wnam|enam|weur|eeur|apac|oc.
const LOCATIONS = ["wnam", "enam", "weur", "eeur", "apac", "oc"];
const location = (process.env.D1_LOCATION || "apac").toLowerCase();
if (!LOCATIONS.includes(location)) {
  throw new Error(`D1_LOCATION must be one of ${LOCATIONS.join(", ")} (got "${location}")`);
}

function wrangler(...args) {
  try {
    return { ok: true, out: execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
const exists = (out) => /already exists|already taken|already owned|code: 10073|code: 11009/i.test(out);

// D1
let id = pick(/"database_id"\s*:\s*"([^"]+)"/, PLACEHOLDER);
if (id === PLACEHOLDER) {
  const list = wrangler("d1", "list", "--json");
  const found = list.ok ? JSON.parse(list.out).find((d) => d.name === dbName) : undefined;
  if (found) {
    id = found.uuid;
    console.log(`D1 "${dbName}" already exists`);
  } else {
    const r = wrangler("d1", "create", dbName, "--location", location);
    if (!r.ok) throw new Error(`Couldn't create D1 "${dbName}":\n${r.out}`);
    id = r.out.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/)?.[1];
    if (!id) throw new Error(`Created D1 "${dbName}" but couldn't read its id:\n${r.out}`);
    console.log(`D1 "${dbName}" created (location hint: ${location})`);
  }
  await writeFile(file, config.replace(PLACEHOLDER, id));
  console.log(`database_id written to wrangler.jsonc`);
} else {
  console.log(`D1 "${dbName}" already set in wrangler.jsonc`);
}

// Queues
{
  const r = wrangler("queues", "create", queue);
  if (r.ok) console.log(`Queue "${queue}" created`);
  else if (exists(r.out)) console.log(`Queue "${queue}" already exists`);
  else throw new Error(`Couldn't create queue "${queue}":\n${r.out}`);
}

console.log("\nNext: npm run deploy (builds, applies D1 migrations, deploys the Worker).");
