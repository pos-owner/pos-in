import type { Config } from "drizzle-kit";
// Named drizzle.d1.config.ts (not the default drizzle.config.ts) so hosting build steps that auto-run
// `drizzle-kit generate` skip it: this schema targets Cloudflare D1, and migrations are applied with Wrangler.

// Type-only import: the config loads even before dependencies are resolved.
// Drizzle keeps its migrations (SQL + snapshots) in drizzle/; `npm run db:generate` also copies each
// migration into migrations/ (flat files), which is what `wrangler d1 migrations apply` reads.
export default {
  dialect: "sqlite",
  schema: "./worker/db/schema.ts",
  out: "drizzle",
} satisfies Config;
