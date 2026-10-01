/**
 * The rules a direct message has to satisfy before it is written.
 *
 * The hole these close: a DM body was unbounded. Postgres stores `text` and the
 * insert policy only asks "are you the sender and a participant", so one
 * signed-in token could put a five-megabyte body into a conversation — which is
 * stored, fanned out to the recipient's inbox query, re-read on every scroll and
 * rendered inside a chat bubble. Everything else in this app is bounded (a post
 * is rejected above 5000 characters, in-call chat above 500, a reaction to eight
 * code points), so an unbounded message was an oversight rather than a choice.
 *
 * The cap is enforced in three places that must agree, and this module is the
 * single statement of the rule: the composer (so nobody types past it), the write
 * path (so a scripted call gets a sentence instead of a database error) and a
 * `CHECK` constraint in the database, which is the only one of the three a
 * determined caller cannot walk around.
 */

/** Longest DM body the database will accept. */
export const MAX_MESSAGE_CHARS = 4_000;

/**
 * Longest space-chat message. Shorter than a DM on purpose: a room chat is one
 * line among many in a live space, it is re-read by every participant through
 * `getSpaceRoom`, and the column is bounded by `space_messages_body_length`.
 */
export const MAX_SPACE_CHAT_CHARS = 2_000;

/** The same rule for a different column, so neither can drift from its constraint. */
export function lengthError(body: string, limit: number): string | null {
  const over = messageLength(body) - limit;
  if (over <= 0) return null;
  return `A message can be up to ${limit} characters — this one is ${over} over. Please shorten it.`;
}

/** Show the counter before it is needed, not the instant it blocks you. */
export const MESSAGE_COUNTER_WARN_AT = 200;

/**
 * Count characters the way a person sees them, not the way UTF-16 stores them.
 *
 * Code points, deliberately: that is exactly what Postgres `char_length()` counts,
 * so the composer's arithmetic and the `messages_body_length` constraint cannot
 * disagree. It is not grapheme counting — `👩‍👩‍👧` is five code
 * points because a family emoji really is a sequence — and a cap that argued about
 * segmentation would be a cap nobody could explain.
 */
export function messageLength(body: string): number {
  return Array.from(String(body ?? "")).length;
}

export function remainingMessageChars(body: string): number {
  return Math.max(0, MAX_MESSAGE_CHARS - messageLength(body));
}

/** How far past the cap a draft already is. Zero while it still fits. */
export function messageCharsOver(body: string): number {
  return Math.max(0, messageLength(body) - MAX_MESSAGE_CHARS);
}

export function isMessageWithinLimit(body: string): boolean {
  return messageCharsOver(body) === 0;
}

/**
 * The number next to the send button: what is left, or what is too much.
 *
 * Going negative is on purpose. Silently stopping the caret at 4000 reads as a
 * broken keyboard, and truncating a paste loses words nobody can get back.
 */
export function messageCounterLabel(body: string): string {
  const over = messageCharsOver(body);
  return over > 0 ? `-${over}` : String(remainingMessageChars(body));
}

/** True when the counter is worth showing. */
export function shouldShowMessageCounter(body: string): boolean {
  return remainingMessageChars(body) <= MESSAGE_COUNTER_WARN_AT;
}

/**
 * Why a message will not be stored, in a sentence the user can act on — or null
 * when it is fine. Written without locale formatting so the same words are what
 * the composer shows and what the tests pin.
 */
export function messageLengthError(body: string): string | null {
  const over = messageCharsOver(body);
  if (over === 0) return null;
  return `A message can be up to ${MAX_MESSAGE_CHARS} characters — this one is ${over} over. Please split it up.`;
}
