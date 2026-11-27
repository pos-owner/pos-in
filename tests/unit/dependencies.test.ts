/**
 * Every package the code imports must be declared in package.json. A package that only happens to sit in
 * node_modules (pulled in by another package) works on one machine and fails `npm ci && npm run build` on a clean one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const root = join(import.meta.dirname, "../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
const builtins = new Set(builtinModules);

const SOURCE_DIRS = ["src", "worker", "shared", "scripts", "tests"];
const SOURCE_FILES = ["vite.config.ts", "drizzle.d1.config.ts", "index.html"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".html"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (EXTENSIONS.has(extname(name))) yield path;
  }
}

/** Specifiers written as `import ... from "x"`, `import "x"`, `import("x")`, `require("x")` or CSS `@import "x"`. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /^\s*(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*@import\s+(?:url\()?["']([^"']+)["']/gm,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) found.push(m[1]);
  return found;
}

/** `@scope/name/sub/path` → `@scope/name`; `name/sub` → `name`; null for relative paths, built-ins and runtime schemes. */
function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) return null;
  if (/^(node|cloudflare|virtual|data|https?):/.test(spec)) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return builtins.has(name) ? null : name;
}

test("every imported package is declared in package.json", () => {
  const files = [...SOURCE_DIRS.flatMap((d) => [...walk(join(root, d))]), ...SOURCE_FILES.map((f) => join(root, f))];
  const missing = new Map<string, string>();
  for (const file of files) {
    if (file === import.meta.filename) continue; // its own sample strings below are not imports
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      const name = packageOf(spec);
      if (name && !declared.has(name) && !missing.has(name)) missing.set(name, file.slice(root.length + 1));
    }
  }
  assert.deepEqual(
    [...missing].map(([name, file]) => `${name} (imported in ${file})`),
    [],
    "add these to package.json: npm install <name>",
  );
});

test("the scanner sees the imports it is meant to see", () => {
  assert.deepEqual(specifiers(`import a from "x";\nimport "y";\nconst z = await import("w");\n@import "q";`), [
    "x",
    "y",
    "w",
    "q",
  ]);
  assert.deepEqual(specifiers(`@import "@fontsource-variable/inter/wght.css";`), [
    "@fontsource-variable/inter/wght.css",
  ]);
  assert.equal(packageOf("@fontsource-variable/inter/wght.css"), "@fontsource-variable/inter");
  assert.equal(packageOf("node:fs"), null);
  assert.equal(packageOf("fs/promises"), null);
  assert.equal(packageOf("./local.ts"), null);
});
