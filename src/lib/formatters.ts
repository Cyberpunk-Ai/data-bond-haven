export const SEED_ANCHOR = Math.floor(Date.now() / 3_600_000) * 3_600_000;

export function compact(num: number): string {
  if (num === null || num === undefined || isNaN(num)) return "0";
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  }
  return num.toString();
}

export function initials(name: string): string {
  if (!name) return "";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The platform's advertising currency is USD everywhere (global audience), so
 * money is rendered with a plain dollar sign rather than a locale-dependent
 * currency name. Fixed `en-US` formatting keeps server and client output
 * identical — no hydration flicker.
 */
export function usd(amount: number): string {
  const value = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

/** A local-currency equivalent for confirmations: "≈ KES 1,560". */
export function approxLocal(amount: number, currency: string): string {
  const value = Number.isFinite(amount) ? amount : 0;
  try {
    return `≈ ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} ${currency}`;
  } catch {
    return `≈ ${value.toFixed(2)} ${currency}`;
  }
}

/**
 * "March 2025"-style account-age label for the profile "Joined …" line. Fixed
 * `en-US` (like `usd`) so the server render and the client hydration agree and
 * never flicker. Returns "" for a missing/invalid date so the caller can drop
 * the whole line rather than show "Joined" with nothing after it.
 */
export function memberSince(isoString?: string | null): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(date);
}

/**
 * The DM body for a story reply. Only quote the story when there is text to
 * quote, and only add the ellipsis when we actually truncated — a media-only
 * story reads "Replied to your story: …", not "Replied to your story
 * \"story\": …", and "Hi" never becomes "Hi...".
 */
export function storyReplyBody(
  story: { text?: string | null; caption?: string | null },
  reply: string,
): string {
  const raw = (story.text || story.caption || "").trim();
  const quote = raw ? ` "${raw.length > 40 ? `${raw.slice(0, 40).trimEnd()}…` : raw}"` : "";
  return `Replied to your story${quote}: ${reply}`;
}

export function timeAgo(isoString: string, _now?: unknown): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  const now = typeof _now === "number" ? new Date(_now) : _now instanceof Date ? _now : new Date();
  const diffInSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));

  if (diffInSeconds < 60) return "just now";
  const minutes = Math.floor(diffInSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
