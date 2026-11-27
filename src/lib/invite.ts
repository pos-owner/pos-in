/**
 * Remembers an invite the person has unlocked with its PIN while they sign in
 * (Google redirects away, and email sign-up may need a confirmation link).
 * Cleared as soon as the invite is claimed, and ignored after 2 hours.
 */
const KEY = "pos.invite";
interface PendingInvite {
  token: string;
  pin: string;
  at: number;
}

export function savePendingInvite(token: string, pin: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, pin, at: Date.now() }));
  } catch {
    /* storage blocked: the invite just can't resume after a redirect */
  }
}
export function readPendingInvite(): PendingInvite | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as PendingInvite | null;
    if (!v?.token || Date.now() - v.at > 2 * 3600_000) return null;
    return v;
  } catch {
    return null;
  }
}
export function clearPendingInvite() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}
