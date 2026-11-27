import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import { bindings } from "../server/core/bindings.ts";

/*
 * Cloudflare D1 through Drizzle.
 *
 * D1 refuses statements with more than 100 bound parameters. A workspace's ledger easily needs more (every charge id
 * of a year in one `IN (...)`), so `withParamLimit` inlines the values as SQL literals for those few statements.
 * Values are escaped here, never concatenated by callers, and Drizzle's own SQL only uses `?` for parameters.
 */
const MAX_PARAMS = 100;

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in SQL");
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const b = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `X'${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Replaces each `?` outside quotes with the next value. */
function inlineParams(query: string, params: unknown[]): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  for (let k = 0; k < query.length; k++) {
    const ch = query[k];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      if (i >= params.length) throw new Error("more placeholders than parameters");
      out += literal(params[i++]);
    } else out += ch;
  }
  if (i !== params.length) throw new Error("more parameters than placeholders");
  return out;
}

function withParamLimit(d1: D1Database): D1Database {
  const wrapStmt = (query: string, stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind")
          return (...params: unknown[]) =>
            params.length > MAX_PARAMS ? d1.prepare(inlineParams(query, params)) : target.bind(...params);
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  return new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrapStmt(query, target.prepare(query));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const connect = (d1: D1Database) => drizzle(withParamLimit(d1) as never);
export type Db = ReturnType<typeof connect>;

/* One Drizzle instance per D1 binding object (the same for the life of an isolate). */
let cached: { d1: D1Database; db: Db } | null = null;
function current(): Db {
  const d1 = bindings().DB;
  if (cached?.d1 !== d1) cached = { d1, db: connect(d1) };
  return cached.db;
}

/** The database. A thin proxy, so modules can `import { db }` before the Worker has received its bindings. */
export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    const d = current();
    const v = Reflect.get(d, prop, d);
    return typeof v === "function" ? v.bind(d) : v;
  },
});

/**
 * D1 has no interactive transactions (BEGIN/COMMIT over several round trips). Money paths are made safe instead by
 * single statements that check and write at once (see `domain/data.ts` and the meter bill triggers), and by
 * `db.batch([...])` where several writes must land together. `Tx` stays as a name for "the executor in use".
 */
export type Tx = Db;
export type Executor = Db;

export * from "./schema.ts";
