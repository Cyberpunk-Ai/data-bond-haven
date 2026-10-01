/**
 * The one thing that makes a tip in a live Space worth celebrating.
 *
 * Paying leaves the room: `openPaystackPayment` sends the browser to a hosted
 * checkout page, the whole app is torn down, and the person comes back at
 * `/billing/callback` once the charge is verified. By then the Space modal is
 * gone, so nothing in the room knows the money settled.
 *
 * So the tipper carries a note about where they were standing, in their own
 * browser's storage, and the callback trades it for an announcement. The note
 * is *only* an address — the amount shown to the room comes from the payment
 * the server verified, never from this record.
 *
 * Claiming is deliberately destructive: reading a pending tip removes it. A
 * double-mounted effect, a refresh on the callback page, or a second tab all
 * replay the same reference, and a supporter who paid once should be
 * celebrated once.
 */

import { TIP_NOTE_CHARS } from "@/lib/space-reactions";

/** Where the note lives. Prefixed like the app's other local state keys. */
export const PENDING_TIP_KEY = "starpace:pending-tip";

/** A tip whose checkout has been abandoned for this long is never announced. */
export const PENDING_TIP_TTL_MS = 30 * 60 * 1000;

/** A person can have a couple of checkouts in flight; a hundred is a bug. */
export const MAX_PENDING_TIPS = 5;

/** Slack for a browser clock that runs slightly ahead of the server's. */
const FUTURE_SKEW_MS = 60_000;

export interface PendingTip {
  /** Paystack's reference — the only id both sides of the redirect agree on. */
  reference: string;
  spaceId: string;
  /** USD, the currency the whole app displays. A hint only: see the header. */
  amountUsd: number;
  message: string;
  at: number;
}

/**
 * Purge expired notes and pull out the one this reference owns.
 *
 * DOM-free so the rules (expiry, matching, junk entries) are testable in node:
 * `claim` is returned only when it is real, and `keep` is what should be written
 * back afterwards — which is what makes a claim happen once. An empty reference
 * claims nothing and simply returns the live list.
 */
export function parsePendingTips(
  raw: unknown,
  reference: string,
  now: number,
): { claim: PendingTip | null; keep: PendingTip[] } {
  const ref = typeof reference === "string" ? reference.trim() : "";
  const keep: PendingTip[] = [];
  let claim: PendingTip | null = null;

  if (!Number.isFinite(now)) return { claim: null, keep };

  let list: unknown;
  try {
    list = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { claim: null, keep };
  }
  if (!Array.isArray(list)) return { claim: null, keep };

  for (const entry of list) {
    const tip = shape(entry);
    if (!tip) continue;
    const age = now - tip.at;
    if (age > PENDING_TIP_TTL_MS || age < -FUTURE_SKEW_MS) continue;
    // An empty reference claims nothing: the caller only wanted the purge.
    // Newest wins if a reference somehow appears twice.
    if (ref && !claim && tip.reference === ref) {
      claim = tip;
      continue;
    }
    keep.push(tip);
  }

  return {
    claim,
    keep: keep.sort((a, b) => b.at - a.at).slice(0, MAX_PENDING_TIPS),
  };
}

/** Validate one stored entry. Anything unusable is dropped, not repaired. */
function shape(entry: unknown): PendingTip | null {
  const p = entry as Partial<PendingTip> | null;
  if (!p || typeof p !== "object") return null;

  const reference = typeof p.reference === "string" ? p.reference.trim() : "";
  const spaceId = typeof p.spaceId === "string" ? p.spaceId.trim() : "";
  const amountUsd = Number(p.amountUsd);
  const at = Number(p.at);
  if (!reference || !spaceId) return null;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
  if (!Number.isFinite(at) || at <= 0) return null;

  const message = String(p.message ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, TIP_NOTE_CHARS);

  return { reference, spaceId, amountUsd, message, at };
}

function read(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PENDING_TIP_KEY);
  } catch {
    return null;
  }
}

function write(list: PendingTip[]) {
  if (typeof window === "undefined") return;
  try {
    if (list.length === 0) window.localStorage.removeItem(PENDING_TIP_KEY);
    else window.localStorage.setItem(PENDING_TIP_KEY, JSON.stringify(list));
  } catch {
    /* Private-mode/full storage: the tip still settles, it is just not announced. */
  }
}

/** What is on disk right now, with anything expired or unusable already gone. */
function liveTips(now: number): PendingTip[] {
  const raw = read();
  if (!raw) return [];
  // A blank reference matches nothing, so this is a purge rather than a claim.
  return parsePendingTips(raw, "", now).keep;
}

/**
 * Remember the room this tip came from, just before the checkout redirect.
 *
 * Returns false when there is nothing worth remembering (no reference, no room)
 * so a caller can stay silent rather than promise a celebration it cannot give.
 */
export function stashPendingTip(tip: {
  reference?: string;
  spaceId?: string;
  amountUsd?: number;
  message?: string;
}): boolean {
  const now = Date.now();
  const entry = shape({
    reference: tip.reference,
    spaceId: tip.spaceId,
    amountUsd: tip.amountUsd,
    message: tip.message,
    at: now,
  });
  if (!entry) return false;

  // A retry of a checkout that failed re-notes the same reference rather than
  // leaving two claims behind for one payment.
  const others = liveTips(now).filter((t) => t.reference !== entry.reference);
  write([entry, ...others].slice(0, MAX_PENDING_TIPS));
  return true;
}

/**
 * Read the note for a settled payment, and consume it.
 *
 * The write-back is unconditional: it is the removal that makes a claim happen
 * once, and it purges the expired notes a person never came back for.
 */
export function claimPendingTip(reference: string, now = Date.now()): PendingTip | null {
  const { claim, keep } = parsePendingTips(read(), reference, now);
  write(keep);
  return claim;
}
