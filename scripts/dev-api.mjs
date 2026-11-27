// Runs the Worker locally (`wrangler dev`) with a local D1: http://localhost:8787
//
//   npm run dev:api            no Cloudflare login needed
//   npm run dev:api -- --ai    keep the Workers AI binding (meter-photo reading); needs `npm run cf:login`
//
// Workers AI has no local emulation: with the binding present, `wrangler dev` insists on a Cloudflare login even if
// nothing ever calls it, and METER_AI=off does not change that. So by default this starts Wrangler from a copy of
// wrangler.jsonc without the AI binding (wrangler.dev.jsonc, git-ignored, rewritten on every start). The app treats a
// missing binding as "meter scanning unavailable". Any other argument is passed on to `wrangler dev`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const withAi = args.includes("--ai");
const passthrough = args.filter((a) => a !== "--ai");

/** Parses JSON with comments and trailing commas (what wrangler.jsonc is), without touching text inside strings. */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Trailing commas, only outside strings (odd segments of the split are the strings).
  const parts = out.split(/("(?:[^"\\]|\\.)*")/);
  return JSON.parse(parts.map((p, k) => (k % 2 ? p : p.replace(/,(\s*[}\]])/g, "$1"))).join(""));
}

const run = (nodeArgs) => {
  const r = spawnSync(process.execPath, nodeArgs, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
if (!existsSync(wrangler)) {
  console.error("Wrangler isn't installed. Run `npm ci` first.");
  process.exit(1);
}

// Sync the SQL migrations, and make sure dist/ exists (the assets binding needs the directory).
run([join(root, "scripts", "migrations.mjs")]);
mkdirSync(join(root, "dist"), { recursive: true });

let config = "wrangler.jsonc";
if (!withAi) {
  const cfg = parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  delete cfg.ai;
  config = "wrangler.dev.jsonc";
  writeFileSync(join(root, config), `${JSON.stringify(cfg, null, 2)}\n`);
  console.log("Starting without the Workers AI binding (meter-photo reading is off). Use `-- --ai` to keep it.");
}

run([wrangler, "d1", "migrations", "apply", "DB", "--local", "-c", config]);
run([wrangler, "dev", "-c", config, ...passthrough]);
