// Makes a one-time password reset link straight in D1, for when nobody can make one in the app (usually the owner
// forgot their own password and email sending isn't set up). Same rules as the app: valid for 1 hour, single use,
// and earlier unused links for that person stop working.
//
//   npm run cf:reset-link -- owner@example.com --url https://pos.example.workers.dev
//   npm run cf:reset-link -- owner@example.com --local          (wrangler dev database, link on localhost:8787)
//
// Only the SHA-256 of the token is stored, exactly like links made by the Worker.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const local = args.includes("--local");
const urlIdx = args.indexOf("--url");
const base = (urlIdx >= 0 ? args[urlIdx + 1] : local ? "http://localhost:8787" : process.env.APP_URL) ?? "";
const email = (args.find((a, i) => !a.startsWith("--") && (urlIdx < 0 || i !== urlIdx + 1)) ?? "").trim().toLowerCase();

if (!/^[^\s@'"\\;]+@[^\s@'"\\;]+\.[^\s@'"\\;]+$/.test(email)) {
  console.error("Usage: npm run cf:reset-link -- <email> [--local] [--url https://your-app.example]");
  process.exit(1);
}
if (!base) {
  console.error("Pass --url with the app's public address (or set APP_URL), so the link points at the right site.");
  process.exit(1);
}

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", local ? "--local" : "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

// The email is validated above (no quotes, backslashes or semicolons); quotes are doubled anyway.
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const [user] = d1(`SELECT id, name FROM users WHERE email = ${lit(email)} LIMIT 1`);
if (!user) {
  console.error(`No pOS account uses ${email}.`);
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const now = Date.now();
d1(
  `UPDATE password_resets SET used_at = ${now} WHERE user_id = ${lit(user.id)} AND used_at IS NULL; ` +
    `INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) ` +
    `VALUES (${lit(hash)}, ${lit(user.id)}, ${now + 60 * 60_000}, ${now})`,
);

console.log(`\nReset link for ${user.name || email} (works once, for 1 hour):\n`);
console.log(`${base.replace(/\/+$/, "")}/?reset=${encodeURIComponent(token)}\n`);
