/*
 * Offline outbox. Meter readings, maintenance requests and expenses entered without a connection are
 * kept on the phone, in IndexedDB, and sent when the connection comes back.
 *
 *  - Every entry carries a random `clientKey`. The server stores it in a unique `client_key` column and answers a
 *    repeat with the row it already saved (worker/server/core/idempotency.ts), so a retry after a lost reply can
 *    never save twice.
 *  - An entry is removed only after the server has acknowledged it. Network and server errors are retried with
 *    backoff. A refusal (400, 403, 409) stops the entry as "needs attention", so the person can fix or discard it.
 *  - Entries belong to the person who made them: only the signed-in person's entries are shown or sent.
 *  - Photos picked offline are stored with the entry and uploaded first during sync. Their keys are saved on the
 *    entry as they upload, so a retry doesn't upload them again.
 */
import { useSyncExternalStore } from "react";
import { api, ApiError, invalidate } from "./api";
import { compressImage, uploadPhoto } from "./photo";

export type OutboxKind = "meter" | "request" | "expense";
/** queued: waiting for a connection · syncing: being sent · failed: will retry · attention: the server refused it. */
export type OutboxState = "queued" | "syncing" | "failed" | "attention";

export interface OutboxEntry {
  /** The idempotency key sent as `clientKey`; also the IndexedDB key. */
  key: string;
  uid: string;
  kind: OutboxKind;
  path: string;
  body: Record<string, unknown>;
  /** Photos picked offline, not uploaded yet. */
  photos: Blob[];
  /** Keys of photos an earlier attempt already uploaded. */
  photoKeys: string[];
  title: string;
  detail: string;
  createdAt: number;
  attempts: number;
  /** Earliest time (ms) of the next attempt. */
  nextAt: number;
  state: OutboxState;
  error: string;
  /** Machine-readable reason from the server ("unusual", "lower"), when it gave one. */
  code?: string;
}

const PATHS: Record<OutboxKind, string> = { meter: "/api/meters", request: "/api/requests", expense: "/api/expenses" };
const REFRESH: Record<OutboxKind, string[]> = {
  meter: ["/api/meters", "/api/automations", "/api/ledger", "/api/dashboard"],
  request: ["/api/requests", "/api/dashboard", "/api/tenants"],
  expense: ["/api/expenses", "/api/dashboard"],
};

/* ---- IndexedDB (with an in-memory fallback for browsers that block it, e.g. some private modes) ---- */

const DB_NAME = "pos-outbox";
const STORE = "entries";
let dbp: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, OutboxEntry>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        if (!db) return resolve(undefined);
        const t = db.transaction(STORE, mode);
        const r = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(r.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

async function dbAll(): Promise<OutboxEntry[]> {
  const db = await openDb();
  if (!db) return [...memory.values()];
  return (await tx<OutboxEntry[]>("readonly", (s) => s.getAll() as IDBRequest<OutboxEntry[]>)) ?? [];
}
async function dbPut(e: OutboxEntry) {
  if (!(await openDb())) return void memory.set(e.key, e);
  await tx("readwrite", (s) => s.put(e));
}
async function dbDelete(key: string) {
  if (!(await openDb())) return void memory.delete(key);
  await tx("readwrite", (s) => s.delete(key));
}

/* ---- State on screen ---- */

let uid: string | null = null;
let entries: OutboxEntry[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function setEntries(next: OutboxEntry[]) {
  entries = next.sort((a, b) => a.createdAt - b.createdAt);
  emit();
}

/** The signed-in person's entries, oldest first. */
export function useOutbox(): OutboxEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => entries,
    () => entries,
  );
}

async function save(key: string, patch: Partial<OutboxEntry>) {
  const cur = entries.find((e) => e.key === key);
  if (!cur) return;
  const next = { ...cur, ...patch };
  setEntries(entries.map((e) => (e.key === key ? next : e)));
  await dbPut(next).catch((err) => console.error("outbox: couldn't save", err));
}

/* ---- Sending ---- */

/** Network trouble, a busy or failing server: worth another try later. */
const retryable = (e: ApiError) => e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
/** 5s, 10s, 20s … up to 10 minutes. */
const backoff = (attempts: number) => Math.min(10 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));

const newClientKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

function withPhotos(kind: OutboxKind, body: Record<string, unknown>, keys: string[]) {
  if (!keys.length) return body;
  if (kind === "request") {
    const had = Array.isArray(body.photoKeys) ? (body.photoKeys as string[]) : [];
    return { ...body, photoKeys: [...had, ...keys].slice(0, 6) };
  }
  if (kind === "meter" && !body.photoKey) return { ...body, photoKey: keys[0] };
  return body;
}

let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  const waits = entries.filter((e) => e.state === "failed" || e.state === "queued").map((e) => e.nextAt);
  if (!uid || !waits.length) return;
  const wait = Math.max(1_000, Math.min(...waits) - Date.now());
  timer = setTimeout(() => void syncOutbox(), wait);
}

async function sendOne(e: OutboxEntry): Promise<"sent" | "stop" | "next"> {
  await save(e.key, { state: "syncing", error: "" });
  try {
    let photoKeys = e.photoKeys;
    const left = [...e.photos];
    while (left.length) {
      const blob = left[0];
      try {
        const type = blob.type || "image/jpeg";
        const up = await uploadPhoto(new File([blob], type === "image/png" ? "photo.png" : "photo.jpg", { type }));
        photoKeys = [...photoKeys, up.key];
      } catch (err) {
        // A photo the server refuses (wrong type, too big) is left out rather than holding up the entry.
        if (!(err instanceof ApiError) || retryable(err) || err.status === 401) throw err;
      }
      left.shift();
      await save(e.key, { photos: [...left], photoKeys });
    }
    await api(e.path, { body: { ...withPhotos(e.kind, e.body, photoKeys), clientKey: e.key } });
    entries = entries.filter((x) => x.key !== e.key);
    emit();
    await dbDelete(e.key).catch((err) => console.error("outbox: couldn't remove", err));
    invalidate(...REFRESH[e.kind]);
    return "sent";
  } catch (err) {
    const ae = err instanceof ApiError ? err : new ApiError("Something went wrong.", 0);
    if (ae.status === 401) {
      await save(e.key, {
        state: "failed",
        nextAt: Date.now() + backoff(e.attempts + 1),
        error: "Sign in again to send this.",
      });
      return "stop";
    }
    if (retryable(ae)) {
      const attempts = e.attempts + 1;
      await save(e.key, { state: "failed", attempts, nextAt: Date.now() + backoff(attempts), error: ae.message });
      // No connection at all: the rest would fail the same way, so wait for the next chance.
      return ae.status === 0 ? "stop" : "next";
    }
    await save(e.key, { state: "attention", error: ae.message, code: ae.code, attempts: e.attempts + 1 });
    return "next";
  }
}

/** Sends every entry that is due. Safe to call any time; overlapping calls run one after another. */
async function syncOutbox(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  if (!uid || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  running = true;
  let sent = 0;
  try {
    const me = uid;
    const due = entries.filter((e) => e.state !== "attention" && e.nextAt <= Date.now());
    for (const e of due) {
      if (uid !== me) break; // signed out meanwhile
      const r = await sendOne(e);
      if (r === "sent") sent++;
      if (r === "stop") break;
    }
  } finally {
    running = false;
    if (sent) for (const l of sentListeners) l(sent);
    if (again) {
      again = false;
      void syncOutbox();
    } else schedule();
  }
}

const sentListeners = new Set<(n: number) => void>();
/** Called with the number of entries sent after a sync that sent at least one. */
export function onOutboxSent(l: (n: number) => void) {
  sentListeners.add(l);
  return () => sentListeners.delete(l);
}

/* ---- Start, stop, queue ---- */

const kick = () => void syncOutbox();
/** Back online: whatever was waiting out a backoff is worth trying straight away. */
const onOnline = () => void retryAll();
const onVisible = () => {
  if (document.visibilityState === "visible") kick();
};

/** Loads the signed-in person's entries and starts syncing them (on start, when back online, on return to the app). */
export async function startOutbox(userId: string) {
  if (uid === userId) return;
  uid = userId;
  const all = await dbAll().catch(() => [] as OutboxEntry[]);
  if (uid !== userId) return;
  // An entry left "syncing" by a closed app is simply due again.
  setEntries(
    all.filter((e) => e.uid === userId).map((e) => (e.state === "syncing" ? { ...e, state: "queued" as const } : e)),
  );
  addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  kick();
}

/** Stops syncing and hides the entries (signed out). They stay on the phone until that person signs in again. */
export function stopOutbox() {
  uid = null;
  clearTimeout(timer);
  timer = undefined;
  removeEventListener("online", onOnline);
  document.removeEventListener("visibilitychange", onVisible);
  setEntries([]);
}

interface QueueInput {
  kind: OutboxKind;
  body: Record<string, unknown>;
  title: string;
  detail: string;
  /** Photos that couldn't be uploaded yet (picked offline). */
  photos?: (Blob | File)[];
  /** Reuse a key already sent once (a request that may have reached the server before the connection dropped). */
  key?: string;
}

async function enqueue(input: QueueInput): Promise<OutboxEntry> {
  if (!uid) throw new ApiError("Sign in again to save this.", 401);
  const photos = await Promise.all(
    (input.photos ?? []).map((p) => (p instanceof File ? compressImage(p).catch(() => p) : Promise.resolve(p))),
  );
  const e: OutboxEntry = {
    key: input.key ?? newClientKey(),
    uid,
    kind: input.kind,
    path: PATHS[input.kind],
    body: input.body,
    photos,
    photoKeys: [],
    title: input.title,
    detail: input.detail,
    createdAt: Date.now(),
    attempts: 0,
    nextAt: Date.now() + 2_000,
    state: "queued",
    error: "",
  };
  await dbPut(e);
  setEntries([...entries, e]);
  schedule();
  return e;
}

type SendResult<T> = { queued: false; data: T } | { queued: true };

/**
 * Sends a new meter reading, request or expense now, or keeps it in the outbox when there's no connection.
 * A refusal from the server (a wrong number, a missing field) is thrown as usual, so the form can show it.
 */
export async function sendOrQueue<T>(input: QueueInput): Promise<SendResult<T>> {
  const key = input.key ?? newClientKey();
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!offline && !input.photos?.length) {
    try {
      return { queued: false, data: await api<T>(PATHS[input.kind], { body: { ...input.body, clientKey: key } }) };
    } catch (e) {
      if (!(e instanceof ApiError) || !retryable(e)) throw e;
      // It may have reached the server: the same key makes the later retry return that row instead of a new one.
    }
  }
  await enqueue({ ...input, key });
  return { queued: true };
}

/* ---- Actions from the outbox screen ---- */

/** Tries an entry again now, optionally changing what is sent (e.g. confirming an unusual meter reading). */
export async function retryEntry(key: string, bodyPatch?: Record<string, unknown>) {
  const cur = entries.find((e) => e.key === key);
  if (!cur) return;
  await save(key, {
    state: "queued",
    nextAt: 0,
    error: "",
    code: undefined,
    body: bodyPatch ? { ...cur.body, ...bodyPatch } : cur.body,
  });
  await syncOutbox();
}

/** Deletes an entry from the phone without sending it. */
export async function discardEntry(key: string) {
  entries = entries.filter((e) => e.key !== key);
  emit();
  await dbDelete(key);
  schedule();
}

/** Tries everything that isn't waiting on the person, now. */
export async function retryAll() {
  const keys = entries.filter((e) => e.state === "failed" || e.state === "queued").map((e) => e.key);
  for (const key of keys) await save(key, { nextAt: 0 });
  await syncOutbox();
}
