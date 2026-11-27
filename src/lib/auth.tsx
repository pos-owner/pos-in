import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, clearCache, restoreSnapshot } from "./api";
import { browserStore, clearLaunch, hasAuthParams, readMe, writeMe } from "./launch";
import { setLocale } from "./i18n";
import { startOutbox, stopOutbox } from "./outbox";
import { clearResetFromUrl, resetToken } from "./session";

type Role = "owner" | "staff" | "tenant";
interface Me {
  user: { id: string; email: string; name: string };
  profile: {
    id: string;
    role: Role;
    fullName: string;
    phone: string;
    email: string;
    upiId: string;
    /** Language for the app. */
    locale?: "en" | "hi";
  } | null;
  ownerName?: string;
}
type Status = "loading" | "signedOut" | "setup" | "ready" | "error" | "signOutPending";
interface AuthState {
  status: Status;
  me: Me | null;
  error: string;
  notice: string;
  /** The token from a password-reset link opened on this page load ("" when none); a new password is chosen. */
  recovery: string;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  clearRecovery: () => void;
  /** Call after signing in or creating an account: drops anything cached for a previous person, then loads /me. */
  signedIn: () => Promise<void>;
}

// The cookie is HttpOnly: a local sign-out must be completed by the server on reconnect.
const SIGN_OUT_KEY = "pos.auth.signout-pending";

const Ctx = createContext<AuthState>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  /*
   * A returning person opens straight into their app: the account and last screens remembered from the previous
   * session (launch.ts) show at once while the session and /api/me are verified in the background. Anything that
   * doesn't check out (signed out elsewhere, someone else's session) falls back to the normal path in refresh().
   * Reset links always take the normal path.
   */
  const [boot] = useState(() => {
    if (browserStore.getItem(SIGN_OUT_KEY) || hasAuthParams(window.location.hash, window.location.search)) return null;
    const remembered = readMe<Me>(browserStore);
    if (!remembered?.profile) return null;
    restoreSnapshot(remembered.user.id);
    setLocale(remembered.profile.locale);
    return remembered;
  });
  const [status, setStatus] = useState<Status>(boot ? "ready" : "loading");
  const [me, setMe] = useState<Me | null>(boot);
  const [error, setError] = useState("");
  const [notice] = useState("");
  const [recovery, setRecovery] = useState(resetToken);

  /** The account on screen, readable inside refresh() without making it re-create on every change. */
  const meRef = useRef<Me | null>(boot);
  const put = useCallback((m: Me | null) => {
    meRef.current = m;
    setMe(m);
  }, []);

  const pending = useRef(browserStore.getItem(SIGN_OUT_KEY) === "1");
  const signOutRequest = useRef<Promise<void> | null>(null);
  const sessionEpoch = useRef(0);

  const finishSignOut = useCallback(() => {
    if (signOutRequest.current) return signOutRequest.current;
    signOutRequest.current = (async () => {
      try {
        await import("./push").then((m) => m.disablePush()).catch(() => undefined);
        const result = await api<{ ok: boolean }>("/api/auth/signout", { method: "POST" });
        if (result?.ok !== true) throw new Error("Sign-out was not confirmed.");
        browserStore.removeItem(SIGN_OUT_KEY);
        pending.current = false;
        setStatus("signedOut");
      } catch {
        setStatus("signOutPending");
      } finally {
        signOutRequest.current = null;
      }
    })();
    return signOutRequest.current;
  }, []);

  const refresh = useCallback(async () => {
    if (pending.current) return finishSignOut();
    const epoch = sessionEpoch.current;
    try {
      const m = await api<Me>("/api/me");
      if (epoch !== sessionEpoch.current) return;
      if (meRef.current && meRef.current.user.id !== m.user.id) {
        // What was remembered belongs to someone else: drop it and load this person properly.
        clearCache();
      }
      if (m.profile) {
        restoreSnapshot(m.user.id);
        writeMe(browserStore, m);
        setLocale(m.profile.locale);
      } else {
        clearLaunch(browserStore);
      }
      put(m);
      setStatus(m.profile ? "ready" : "setup");
    } catch (e) {
      if (epoch !== sessionEpoch.current) return;
      if (e instanceof ApiError && e.status === 401) {
        // Wipe the cache only if someone's data was on screen, so a signed-out screen that is loading its own
        // public data (an invite, say) isn't disturbed.
        if (meRef.current) clearCache();
        else clearLaunch(browserStore);
        put(null);
        setStatus("signedOut");
      } else if (!meRef.current) {
        setError(e instanceof Error ? e.message : "Couldn't load your account.");
        setStatus("error");
      }
      // Otherwise we're offline or the server hiccuped: keep showing what the last session left; the next
      // request retries and the offline bar already says what's going on.
    }
  }, [finishSignOut, put]);

  useEffect(() => {
    if (resetToken) clearResetFromUrl();
    refresh();
  }, [refresh]);

  useEffect(() => {
    const online = () => {
      if (pending.current) void finishSignOut();
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [finishSignOut]);

  /*
   * The offline outbox (outbox.ts) follows whoever is signed in: their saved entries load and start sending as soon
   * as their app is on screen, including an offline launch from the remembered session. Signing out, or another
   * person signing in, stops it; entries stay on the phone for the person who made them.
   */
  const outboxUser = status === "ready" && me?.profile ? me.user.id : null;
  useEffect(() => {
    if (outboxUser) void startOutbox(outboxUser);
    else if (status !== "loading") stopOutbox();
  }, [outboxUser, status]);

  const signedIn = useCallback(async () => {
    clearCache();
    put(null);
    await refresh();
    // A browser that already has push on now delivers to whoever just signed in.
    import("./push").then((m) => m.resyncPush()).catch(() => undefined);
  }, [put, refresh]);

  const signOut = useCallback(async () => {
    sessionEpoch.current++;
    pending.current = true;
    browserStore.setItem(SIGN_OUT_KEY, "1");
    stopOutbox();
    clearCache();
    put(null);
    setStatus("loading");
    await finishSignOut();
  }, [finishSignOut, put]);

  const value = useMemo(
    () => ({ status, me, error, notice, recovery, refresh, signOut, signedIn, clearRecovery: () => setRecovery("") }),
    [status, me, error, notice, recovery, refresh, signOut, signedIn],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
