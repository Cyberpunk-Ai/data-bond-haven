/**
 * Shared tuning values for the messaging surface.
 *
 * These used to be inline magic numbers scattered through the 2,800-line
 * `messages.tsx` — a bubble's max width here, an upload `accept` string there, a
 * collapse threshold buried inside a component. Pulling them out gives one place
 * to reason about the visual rhythm and the attachment contract, and keeps the
 * composer's `accept` in sync with what the bubble renderer (`attachmentKind`)
 * actually knows how to display.
 */

/** Own text messages can be edited / un-sent only inside this window. */
export { MESSAGE_EDIT_WINDOW_MS } from "@/lib/api-client";

/** How many messages to fetch per history page when scrolling up for older ones. */
export const NEW_PAGE_LIMIT = 60;

/** Above this many characters a bubble collapses behind a "Show more" affordance. */
export const LONG_MESSAGE_THRESHOLD = 500;

/** Max height (Tailwind arbitrary value) a collapsed long message is clamped to. */
export const LONG_MESSAGE_CLAMP_CLASS = "max-h-[240px]";

/**
 * The bubble width scale. One source so text, image, video and document bubbles
 * share the same shape instead of each hard-coding its own `max-w-[...]`.
 */
export const BUBBLE_MAX_WIDTH_CLASS = "max-w-[88%] sm:max-w-[76%] lg:max-w-[68%]";

/** Attachment media is allowed a touch more room than a line of text. */
export const ATTACHMENT_MAX_WIDTH_CLASS = "max-w-[260px] sm:max-w-[320px]";

/** Quick reactions shown as a row above the action list in the message menu. */
export { QUICK_REACTIONS } from "@/lib/emojis";

/**
 * File-picker `accept` filters for the attach menu. Kept next to each other so
 * the three entry points (photos/videos, documents, audio) cannot drift from the
 * union the "everything" button uses, and so they line up with the extensions
 * `attachmentKind` knows how to render.
 */
export const ACCEPT_MEDIA = "image/*,video/*";
export const ACCEPT_DOCUMENTS =
  ".pdf,.doc,.docx,.txt,.zip,.rar,.7z,.tar,.gz,.csv,.xlsx,.xls,.pptx,.ppt,.json,.js,.ts,.py,.md,.html,.css";
export const ACCEPT_AUDIO = "audio/*";
/** The union used by the single paperclip input when no sub-menu choice is made. */
export const ACCEPT_ALL = `${ACCEPT_MEDIA},${ACCEPT_AUDIO},${ACCEPT_DOCUMENTS}`;

/** A staged attachment over this many MB is worth flagging before upload. */
export const ATTACHMENT_SIZE_WARN_MB = 20;
