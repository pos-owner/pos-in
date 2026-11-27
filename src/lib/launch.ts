/*
 * Launch cache: what the last session leaves behind so the next launch can paint at once and refresh in the
 * background (stale-while-revalidate), instead of showing the logo while the network answers.
 *
 * Only the signed-in person's own screens are kept, tagged with their user id, and signing out wipes everything.
 * This file has no imports on purpose: the tests run it directly.
 */

export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage that never throws (private mode, blocked storage, a full quota). */
export const browserStore: Store = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked or full: the next launch simply loads from the network */
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to clear */
    }
  },
};

const ME_KEY = "pos.launch.me.v1";
const DATA_KEY = "pos.launch.data.v1";
/** A remembered session older than this is ignored (the person may have been signed out elsewhere long ago). */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** localStorage is synchronous, so a snapshot bigger than this is skipped rather than slowing launch down. */
export const MAX_CHARS = 400_000;

/** GET endpoints worth painting from the last session: each role's first screens and what their tab badges need. */
export const SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
  "/api/dashboard",
  "/api/ledger",
  "/api/tenants",
  "/api/requests",
  "/api/workspace",
  "/api/tenant/home",
  "/api/reminders",
  // The meter and expense screens, so staff can open them and save entries to the offline outbox with no signal.
  "/api/meters",
  "/api/expenses",
]);

/** Remembered only when they fit: a snapshot that would be too big drops these before giving up on the rest. */
const OPTIONAL_SNAPSHOT_KEYS: ReadonlySet<string> = new Set(["/api/meters", "/api/expenses"]);

interface Stamped<T> {
  at: number;
  uid: string;
  value: T;
}

function read<T>(store: Store, key: string, now: number): Stamped<T> | null {
  const raw = store.getItem(key);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as Partial<Stamped<T>> | null;
    if (!rec || typeof rec.at !== "number" || typeof rec.uid !== "string" || rec.value == null) return null;
    if (now - rec.at > MAX_AGE_MS) return null;
    return rec as Stamped<T>;
  } catch {
    return null;
  }
}

/** The account details remembered from the last successful sign-in, or null when there are none worth trusting. */
export function readMe<T extends { user: { id: string } }>(store: Store, now = Date.now()): T | null {
  const rec = read<T>(store, ME_KEY, now);
  if (!rec || rec.value.user?.id !== rec.uid) return null;
  return rec.value;
}

export function writeMe<T extends { user: { id: string } }>(store: Store, me: T, now = Date.now()) {
  store.setItem(ME_KEY, JSON.stringify({ at: now, uid: me.user.id, value: me }));
}

/** Remembered API replies for this person, limited to the known endpoints. Empty for anyone else. */
export function readData(store: Store, uid: string, now = Date.now()): Record<string, unknown> {
  const rec = read<Record<string, unknown>>(store, DATA_KEY, now);
  if (!rec || rec.uid !== uid || typeof rec.value !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) if (rec.value[key] !== undefined) out[key] = rec.value[key];
  return out;
}

/** Saves the known endpoints from `data`. Returns false (and forgets the old snapshot) when it would be too big. */
export function writeData(store: Store, uid: string, data: Record<string, unknown>, now = Date.now()): boolean {
  const value: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) if (data[key] !== undefined) value[key] = data[key];
  let json = JSON.stringify({ at: now, uid, value });
  if (json.length > MAX_CHARS) {
    for (const key of OPTIONAL_SNAPSHOT_KEYS) delete value[key];
    json = JSON.stringify({ at: now, uid, value });
  }
  if (json.length > MAX_CHARS) {
    store.removeItem(DATA_KEY);
    return false;
  }
  store.setItem(DATA_KEY, json);
  return true;
}

/** Forgets everything (sign-out, a different person, an expired session). */
export function clearLaunch(store: Store) {
  store.removeItem(ME_KEY);
  store.removeItem(DATA_KEY);
}

/**
 * True when this page load carries an auth link (a password reset, or an older email link). Those must take the
 * normal path, so a remembered session never shows through while the link is handled.
 */
export function hasAuthParams(hash: string, search: string): boolean {
  return /[#?&](reset|access_token|refresh_token|code|error|error_description|type)=/.test(`${hash}${search}`);
}
