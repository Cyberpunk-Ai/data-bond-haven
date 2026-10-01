/**
 * What a live Space shows when something good happens: a reaction tap, or a
 * settled tip.
 *
 * Split from the room component for the same reason as `spaces-stage.ts` — the
 * rules about what is *broadcast*, *deduped*, *positioned* and *dropped* are the
 * ones that break quietly, and none of them need a browser to check. The bug
 * that started this file: tapping ❤️ only ever moved your own screen, because
 * the handler wrote straight into local state and nothing was ever sent to the
 * room.
 *
 * The visual state is a plain object so React can own it; the set of ids
 * already applied is passed in separately and mutated, because a 300-entry Set
 * copied on every sparkle would be pure waste.
 */

import { sanitizeReactionEmoji, TIP_REACTION } from "@/lib/emojis";
import { isNewEvent } from "@/lib/call-media";
import { usd } from "@/lib/formatters";

/** How many emoji fit in one row of the tap bar on a phone. */
export const SPACE_REACTION_BAR_LIMIT = 8;

/** Horizontal lanes a floating emoji can occupy. */
export const REACTION_LANES = 7;
/** A floating emoji lives this long before it is dropped from the DOM. */
export const REACTION_LIFE_MS = 2_600;
/** Concurrency ceiling: a room that floods itself stays readable. */
export const MAX_VISIBLE_REACTIONS = 18;
/** How long a room remembers event ids it has already applied. */
export const REACTION_MEMORY = 300;
/** Two taps from one person closer together than this collapse into one. */
export const REACTION_TAP_COOLDOWN_MS = 350;
/** The running count next to the bar decays after a quiet spell. */
export const REACTION_TALLY_WINDOW_MS = 5_000;

/** One settled tip's celebration banner. */
export const TIP_ALERT_MS = 6_000;
export const MAX_TIP_ALERTS = 3;
/** Money bags per tip: enough to read as a burst, few enough to stay clean. */
export const TIP_SPARKLE_COUNT = 3;
/** A tip note is a sentence, not a wall of text pasted from a broadcast. */
export const TIP_NOTE_CHARS = 140;
/** Ids arrive from the network; a megabyte of "id" would bloat the dedupe set. */
export const MAX_EVENT_ID_CHARS = 64;

export interface FloatingReaction {
  id: string;
  emoji: string;
  /** Lane index, for debugging/tests; `left` is what the DOM uses. */
  lane: number;
  /** Percentage across the room, so every member sees the same arrangement. */
  left: number;
  /** Extra travel and horizontal drift, both derived from the id. */
  rise: number;
  sway: number;
  duration: number;
  at: number;
}

export interface ReactionTally {
  emoji: string;
  count: number;
  /** When the last one landed; the entry ages out of the window after this. */
  at: number;
}

export interface ReactionLayer {
  visible: FloatingReaction[];
  tally: ReactionTally[];
}

export interface TipAlert {
  id: string;
  senderName: string;
  /** USD, as the whole app displays money. */
  amount: number;
  message: string;
  at: number;
  expiresAt: number;
}

export function emptyReactionLayer(): ReactionLayer {
  return { visible: [], tally: [] };
}

/**
 * A stable, spread-out layout derived from the event id alone.
 *
 * Every member computes the same lanes from the same broadcast, so the room
 * sees one burst rather than N slightly-different ones — and two people tapping
 * the same emoji at the same moment still land in different places.
 */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}

export function reactionLane(id: string): number {
  return hashId(id) % REACTION_LANES;
}

/** Lanes fill the middle of the room, never the very edges behind a scrollbar. */
export function reactionLeftPercent(lane: number): number {
  const spread = 84;
  const first = 8;
  const step = spread / (REACTION_LANES - 1);
  return (
    Math.round(
      (first + (((lane % REACTION_LANES) + REACTION_LANES) % REACTION_LANES) * step) * 10,
    ) / 10
  );
}

/** Build the animation model for one emoji. Pure, so the layout is testable. */
export function reactionFor(id: string, emoji: string, at: number): FloatingReaction {
  const h = hashId(id);
  const lane = h % REACTION_LANES;
  return {
    id,
    emoji,
    lane,
    left: reactionLeftPercent(lane),
    rise: 130 + (h % 7) * 14,
    sway: ((h >> 3) % 2 === 0 ? -1 : 1) * (8 + (h % 5) * 4),
    // Always shorter than REACTION_LIFE_MS: an emoji whose arc outlived its time
    // on screen would be cut off mid-fade, which reads as a pop rather than a
    // float. The prune and the CSS never disagree.
    duration: REACTION_LIFE_MS - 600 + (h % 5) * 100,
    at,
  };
}

/**
 * Validate a reaction off the broadcast bus.
 *
 * A payload is somebody else's bytes: it must name an id and carry something
 * that survives the emoji rules, or the room ignores it entirely rather than
 * rendering `"undefined"` as a floating glyph.
 */
export function readReactionPayload(raw: unknown): { id: string; emoji: string } | null {
  const p = raw as { id?: unknown; emoji?: unknown } | null;
  if (!p || typeof p.id !== "string" || !p.id.trim()) return null;
  const emoji = sanitizeReactionEmoji(p.emoji);
  if (!emoji) return null;
  return { id: p.id.slice(0, MAX_EVENT_ID_CHARS), emoji };
}

/** The id one person's tap carries; the salt keeps two taps in a row distinct. */
export function reactionId(userId: string, at: number, salt: string): string {
  return `rx_${(userId || "anon").slice(0, 24)}_${at}_${salt.slice(0, 8)}`;
}

/**
 * May this tap be sent? A held-down button or an over-eager tapper must not be
 * able to put a hundred sparkles on everyone's screen.
 */
export function canTapReaction(
  lastTapAt: number,
  at: number,
  cooldownMs = REACTION_TAP_COOLDOWN_MS,
) {
  if (!Number.isFinite(lastTapAt) || lastTapAt <= 0) return true;
  if (at < lastTapAt) return false; // clock jumped backwards: drop rather than flood
  return at - lastTapAt >= cooldownMs;
}

function bumpTally(tally: ReactionTally[], emoji: string, at: number): ReactionTally[] {
  const live = tally.filter((t) => at - t.at < REACTION_TALLY_WINDOW_MS);
  const hit = live.find((t) => t.emoji === emoji);
  if (!hit) return [...live, { emoji, count: 1, at }];
  return live.map((t) => (t === hit ? { ...t, count: t.count + 1, at } : t));
}

/**
 * Apply already-built floaters to the layer.
 *
 * The `seen` set is what makes this idempotent: the same event reaching the room
 * twice (a retry, or a second tab of your own account) renders once.
 */
export function applyReactions(
  layer: ReactionLayer,
  seen: Set<string>,
  floats: FloatingReaction[],
  at: number,
): ReactionLayer {
  const fresh = (floats ?? []).filter(
    (f) => f && f.emoji && isNewEvent(seen, f.id, REACTION_MEMORY),
  );
  if (fresh.length === 0) return layer;

  const alive = layer.visible.filter((v) => at - v.at < REACTION_LIFE_MS);
  let visible = alive;
  for (const f of fresh) {
    visible = visible.length >= MAX_VISIBLE_REACTIONS ? visible.slice(1) : visible;
    visible = [...visible, f];
  }

  let tally = layer.tally;
  for (const f of fresh) tally = bumpTally(tally, f.emoji, at);

  return { visible, tally };
}

/** Drop floaters that have finished and tallies that have gone quiet. */
export function pruneReactionLayer(layer: ReactionLayer, at: number): ReactionLayer {
  const visible = layer.visible.filter((v) => at - v.at < REACTION_LIFE_MS);
  const tally = layer.tally.filter((t) => at - t.at < REACTION_TALLY_WINDOW_MS);
  if (visible.length === layer.visible.length && tally.length === layer.tally.length) return layer;
  return { visible, tally };
}

/** The chips beside the bar: busiest glyph first, capped for one row. */
export function sortedTally(tally: ReactionTally[], at: number, limit = 4): ReactionTally[] {
  return tally
    .filter((t) => at - t.at < REACTION_TALLY_WINDOW_MS && t.count > 0)
    .sort((a, b) => b.count - a.count || b.at - a.at)
    .slice(0, Math.max(0, limit));
}

/**
 * The bags a settled tip throws up, in different lanes, sharing one prefix.
 *
 * Keyed off the tip's own id so a tip that is broadcast twice sparkles once.
 */
export function tipSparkles(
  tipId: string,
  at: number,
  count = TIP_SPARKLE_COUNT,
): FloatingReaction[] {
  const id = (tipId || "tip").slice(0, MAX_EVENT_ID_CHARS);
  const sparkles: FloatingReaction[] = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    sparkles.push(reactionFor(`tip_${id}_${i}`, TIP_REACTION, at + i * 90));
  }
  return sparkles;
}

/**
 * Validate and shape a tip event into a banner.
 *
 * Two things this refuses to do: invent an amount (the old code defaulted a
 * missing figure to $5, which put money on screen that nobody paid) and trust
 * an unbounded note pasted straight out of the broadcast into the room.
 */
export function readTipAlert(
  raw: unknown,
  opts: { at: number; senderName?: string; ttlMs?: number },
): TipAlert | null {
  const p = raw as {
    id?: unknown;
    amount?: unknown;
    message?: unknown;
    sender_name?: unknown;
    tip_message?: unknown;
  } | null;
  if (!p) return null;

  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const id =
    typeof p.id === "string" && p.id.trim()
      ? p.id.trim().slice(0, MAX_EVENT_ID_CHARS)
      : `tip_${opts.at}`;

  const senderName =
    (typeof p.sender_name === "string" && p.sender_name.trim()) ||
    (opts.senderName ?? "").trim() ||
    "A supporter";

  const note = String(p.message ?? p.tip_message ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  const ttl = opts.ttlMs ?? TIP_ALERT_MS;

  return {
    id,
    senderName: senderName.slice(0, 60),
    amount: Math.round(amount * 100) / 100,
    message: note.length > TIP_NOTE_CHARS ? `${note.slice(0, TIP_NOTE_CHARS - 1)}…` : note,
    at: opts.at,
    expiresAt: opts.at + ttl,
  };
}

/** Newest last, capped: a run of tips queues up instead of overwriting. */
export function pushTipAlert(list: TipAlert[], alert: TipAlert, cap = MAX_TIP_ALERTS): TipAlert[] {
  const next = [...list, alert];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function pruneTipAlerts(list: TipAlert[], at: number): TipAlert[] {
  const live = list.filter((t) => t.expiresAt > at);
  return live.length === list.length ? list : live;
}

/**
 * How long until the next banner has to go, or null when nothing is on screen.
 *
 * One timer for the whole stack, re-armed from the render — which is what the
 * old code lacked: every tip scheduled its own 6s timeout, so an early tip's
 * timer dismissed the banner that replaced it, and the timer outlived the room.
 */
export function nextTipAlertDelay(list: TipAlert[], at: number): number | null {
  if (list.length === 0) return null;
  const soonest = Math.min(...list.map((t) => t.expiresAt));
  return Math.max(0, soonest - at);
}

/**
 * The line a settled tip leaves in the room's chat.
 *
 * Written by the person who paid, so it starts with a verb: the row renders as
 * "Amina: tipped $5.00 to the room". A tip that arrived without a usable figure
 * produces no sentence at all rather than a row claiming money nobody paid.
 */
export function tipAnnouncement(amountUsd: unknown, note?: unknown): string {
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const text = String(note ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  if (!text) return `tipped ${usd(amount)} to the room`;
  const clipped = text.length > TIP_NOTE_CHARS ? `${text.slice(0, TIP_NOTE_CHARS - 1)}…` : text;
  return `tipped ${usd(amount)}: “${clipped}”`;
}

/** Remove one banner now (the ✕ on it), leaving the rest of the stack alone. */
export function dismissTipAlert(list: TipAlert[], id: string): TipAlert[] {
  const next = list.filter((t) => t.id !== id);
  // Same reference when there was nothing to remove, so closing a banner that
  // has already expired does not re-render the stack.
  return next.length === list.length ? list : next;
}
