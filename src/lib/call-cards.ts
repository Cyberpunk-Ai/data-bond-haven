/**
 * The rules that turn a `calls` row into something a chat thread can show.
 *
 * Same reasoning as `call-media.ts`: what a call card *says* about a call is a
 * decision, and a wrong one (a declined call reported as "Missed", a 40-second
 * conversation shown as 0s) reads as a broken product rather than a broken
 * browser. The calls table already carries every fact needed — caller, callee,
 * kind, status, the answer and end timestamps and the recorded duration — so a
 * card is derived from that row instead of being written a second time into
 * `messages`. One source, no second copy to drift, and nothing for a caller to
 * forge: the row is guarded by `calls participant read` either way.
 */

import type { Message } from "@/lib/types";

/** The columns `getCallHistory` reads off `calls`. */
export interface CallRowLike {
  id: string;
  caller_id: string;
  callee_id: string;
  kind: string;
  status: string;
  started_at: string;
  answered_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
}

export type CallKind = "audio" | "video";

/**
 * What actually happened, from *this* viewer's seat.
 *
 * `missed` and `unanswered` are the same database status seen from opposite
 * ends: the row says nobody picked up, but the caller needs "No answer" and the
 * person being called needs "Missed call". Collapsing them into one label is how
 * a call log tells everybody the same story and everybody reads it wrong.
 */
export type CallOutcome = "connected" | "declined" | "missed" | "unanswered" | "canceled";

export interface CallCard {
  id: string;
  kind: CallKind;
  outcome: CallOutcome;
  /** Whose phone dialled — drives the arrow as well as the wording. */
  direction: "incoming" | "outgoing";
  /** Sort and display time: the dial, not the pickup. */
  at: string;
  durationSeconds: number;
  /** Talk time is only honest if the call was actually answered. */
  answered: boolean;
}

/** A call that is still ringing has no history entry yet. */
const NOT_HISTORY = new Set(["ringing", "active"]);

function asKind(value: string): CallKind {
  return value === "video" ? "video" : "audio";
}

/**
 * Positive seconds only, and only for a call that was answered.
 *
 * `duration_seconds` is written by whoever ended the call, so an unconnected
 * ring can carry a number (a stale write, a device clock) — and "Missed call ·
 * 0:41" is a lie that makes it look like somebody picked up.
 */
function talkSeconds(row: CallRowLike): number {
  const seconds = Math.round(Number(row.duration_seconds ?? 0));
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (row.status !== "ended") return 0;
  // `answered_at` is set by the only write that turns a ring into a call, so it
  // is the reliable proof somebody picked up even if duration says otherwise.
  if (!row.answered_at) return 0;
  return seconds;
}

export function callCardFromRow(row: CallRowLike, myProfileId: string): CallCard | null {
  if (!row?.id || !row.started_at) return null;
  if (NOT_HISTORY.has(row.status)) return null;

  const outgoing = row.caller_id === myProfileId;
  const seconds = talkSeconds(row);
  const answered = seconds > 0;

  let outcome: CallOutcome;
  if (answered) outcome = "connected";
  else if (row.status === "declined") outcome = "declined";
  else if (row.status === "missed") outcome = outgoing ? "unanswered" : "missed";
  // An `ended` row with no answer means the dialler put their own phone down
  // before anyone picked up. Calling that "Missed" would blame the wrong person.
  else outcome = outgoing ? "canceled" : "missed";

  return {
    id: row.id,
    kind: asKind(row.kind),
    outcome,
    direction: outgoing ? "outgoing" : "incoming",
    at: row.started_at,
    durationSeconds: seconds,
    answered,
  };
}

export function callCardsFromRows(rows: CallRowLike[], myProfileId: string): CallCard[] {
  const cards: CallCard[] = [];
  // A call can appear twice if a device retried its write; the row id is the
  // only stable key, so the log stays honest without trusting the client.
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    const card = callCardFromRow(row, myProfileId);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  return cards.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The wording a card shows under the person's name. */
export function callCardStatusText(card: CallCard, formattedDuration: string): string {
  if (card.answered) return formattedDuration;
  switch (card.outcome) {
    case "declined":
      return card.direction === "outgoing" ? "Declined" : "You declined";
    case "unanswered":
      return "No answer";
    case "canceled":
      return "Canceled";
    default:
      return "Missed call";
  }
}

/** Rose for the outcomes nobody wanted, neutral for a finished conversation. */
export function callCardIsWarning(card: CallCard): boolean {
  return !card.answered;
}

/* ------------------------------------------------------------------ thread */

export type ThreadEntry =
  | { key: string; at: number; type: "call"; call: CallCard; newDay: boolean }
  | {
      key: string;
      at: number;
      type: "message";
      message: Message;
      newDay: boolean;
      startsGroup: boolean;
      endsGroup: boolean;
    };

function timeOf(iso: string): number {
  const parsed = Date.parse(iso);
  // An unreadable timestamp sorts last rather than to `NaN`, which would put a
  // message at neither end of the thread and make the dividers disagree.
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function dayKey(ms: number): string {
  return new Date(ms).toDateString();
}

/**
 * Interleave messages and call cards in one timeline.
 *
 * Day dividers come from the *merged* list, so a calendar day gets exactly one
 * strip no matter which kind of entry opened it — deciding per list instead is
 * how a call at 00:05 and a reply at 00:06 both print "Today".
 *
 * Message *grouping* (who owns the rounded corner, which bubble carries the
 * timestamp) is still computed across messages only: a call card between two of
 * your own messages must not split them into two groups, because nothing about
 * the conversation changed — a call happened.
 */
export function buildThreadTimeline(messages: Message[], cards: CallCard[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [
    ...((messages ?? []) as Message[]).map((message) => ({
      key: `m:${message.id}`,
      at: timeOf(message.created_at),
      type: "message" as const,
      message,
      newDay: false,
      startsGroup: false,
      endsGroup: false,
    })),
    ...((cards ?? []) as CallCard[]).map((call) => ({
      key: `c:${call.id}`,
      at: timeOf(call.at),
      type: "call" as const,
      call,
      newDay: false,
    })),
  ];

  entries.sort((a, b) => a.at - b.at || (a.type === b.type ? 0 : a.type === "message" ? -1 : 1));

  entries.forEach((entry, idx) => {
    const prev = idx > 0 ? entries[idx - 1] : null;
    entry.newDay = !prev || dayKey(prev.at) !== dayKey(entry.at);
  });

  const messageEntries = entries.filter(
    (entry): entry is Extract<ThreadEntry, { type: "message" }> => entry.type === "message",
  );
  messageEntries.forEach((entry, idx) => {
    const prev = idx > 0 ? messageEntries[idx - 1] : null;
    const next = idx < messageEntries.length - 1 ? messageEntries[idx + 1] : null;
    entry.startsGroup = entry.newDay || !prev || prev.message.sender_id !== entry.message.sender_id;
    entry.endsGroup =
      !next ||
      next.message.sender_id !== entry.message.sender_id ||
      dayKey(next.at) !== dayKey(entry.at);
  });

  return entries;
}
