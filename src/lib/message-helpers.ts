/**
 * Pure, render-free helpers for the messaging surface.
 *
 * These previously lived inside `messages.tsx` where they could only be exercised
 * by mounting the whole 2,800-line page. Extracting them here makes the tricky
 * ones (`attachmentKind`, `previewLabel`, the body tokenizer) directly unit-testable
 * and reusable by the extracted bubble/attachment components.
 */
import type { Message } from "@/lib/types";
import { MESSAGE_EDIT_WINDOW_MS } from "@/lib/api-client";

/** A media/doc link body we know how to render inline, or null for plain text. */
export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "document" | null;

/**
 * A file queued in the composer. Nothing is uploaded or sent until the user
 * presses Send; `previewUrl` is a local object URL for images/videos only.
 */
export interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  sizeLabel: string;
  isMedia: boolean;
  previewUrl: string;
}

/** Detects whether a message body is a media link or document we should render inline. */
export function attachmentKind(body: string): AttachmentKind {
  const value = (body || "").trim();
  if (!value) return null;
  if (value.startsWith("data:image")) return "image";
  if (value.startsWith("data:video")) return "video";
  if (value.startsWith("data:audio")) return "audio";
  if (value.startsWith("data:application/pdf")) return "pdf";
  if (value.startsWith("data:application")) return "document";
  if (isVoiceNoteBody(value)) return "audio";
  if (value.startsWith("📄") || value.startsWith("📎")) return "document";

  if (!value.startsWith("http") && !value.startsWith("/")) return null;
  const path = value.split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|avif|svg)$/.test(path)) return "image";
  if (/\.(mp4|webm|mov|m4v|mkv)$/.test(path)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(path)) return "audio";
  if (/\.pdf$/.test(path)) return "pdf";
  if (
    /\.(doc|docx|txt|csv|xlsx|xls|pptx|ppt|zip|rar|7z|tar|gz|json|js|ts|py|md|css|html)$/.test(path)
  )
    return "document";

  if (path.includes("/messages/") || path.includes("/media/") || path.includes("/attachments/")) {
    return "document";
  }
  return null;
}

/** Voice-note bodies are stored as `🎙️ Voice Note (Ns) [url]`. */
export function isVoiceNoteBody(body: string) {
  const value = (body || "").trim();
  return value.startsWith("🎙️") || /\bVoice Note\b/i.test(value);
}

/**
 * A media/attachment reference that points at *our own* storage — the read proxy
 * (`/api/public/media/…`), the upload endpoint (`/api/uploads/…`) or the legacy
 * `/api/media/…`. With or without a scheme, because a caption can carry the bare
 * `/api/…` path just as easily as a full `https://…/api/…` link.
 *
 * These must never be shown as a clickable path in a bubble: the reader already
 * knows how to render them inline, so surfacing the raw storage path is noise and
 * leaks an internal route the user can't do anything with.
 */
export const OWN_MEDIA_RE =
  /(?:https?:\/\/[^\s<>"']+)?\/api\/(?:public\/)?(?:media|uploads)\/[^\s<>"']+/g;

// A scheme-free, single-match twin of `OWN_MEDIA_RE` so a test never trips over
// the shared regex's `lastIndex`.
const OWN_MEDIA_SOLO =
  /(?:https?:\/\/[^\s<>"']+)?\/api\/(?:public\/)?(?:media|uploads)\/[^\s<>"']+/;

export function isOwnMediaUrl(value: string): boolean {
  const v = (value || "").trim();
  if (!v || v.startsWith("data:")) return false;
  return OWN_MEDIA_SOLO.test(v);
}

/** Recover the sender's filename from a tagged document body, else a generic label. */
export function documentLabelName(preview: string) {
  const tagged = (preview || "").trim().match(/^(?:📄|📎)\s*(.*?):\s*\[(.*?)\]/);
  const name = tagged?.[2]?.trim();
  return name ? `📎 ${name}` : "📎 File Attachment";
}

/** Attachments read as a friendly label in the chat list, never a raw link. */
export function previewLabel(preview: string) {
  if (isVoiceNoteBody(preview)) return "🎙️ Voice message";
  const kind = attachmentKind(preview);
  if (kind === "image") return "📷 Photo";
  if (kind === "video") return "🎬 Video";
  if (kind === "audio") return "🎧 Audio";
  if (kind === "pdf") return "📄 PDF Document";
  if (kind === "document") return documentLabelName(preview);
  if (preview.startsWith("📄") || preview.startsWith("📎")) return "📎 Document";
  if (/^https?:\/\/|^\/api\/public\/media\//.test(preview)) return "📎 Attachment";
  return preview;
}

/** Own text messages can be edited / un-sent only inside the shared window. */
export function canEdit(m: Message): boolean {
  return Date.now() - new Date(m.created_at).getTime() <= MESSAGE_EDIT_WINDOW_MS;
}

/* -------------------------------------------------------------------- calls */

/**
 * Was the last activity in a thread a call rather than a message?
 *
 * Calls never enter `messages` (they are derived from the `calls` table, so the
 * conversation trigger cannot stamp them), which leaves the row's own
 * timestamps as the only honest comparison: a call that started after the last
 * message beat it. An unparseable date on either side says "not a call" — the
 * rail must never claim one it cannot prove.
 */
export function isCallActivity(
  lastCallAt?: string | null,
  conversationUpdatedAt?: string | null,
): boolean {
  const call = Date.parse(lastCallAt ?? "");
  if (!Number.isFinite(call)) return false;
  const message = Date.parse(conversationUpdatedAt ?? "");
  if (!Number.isFinite(message)) return true;
  return call > message;
}

/** The inbox-rail label for a last activity that was a call. */
export function callPreviewLabel(kind?: "voice" | "video"): string {
  return kind === "video" ? "📹 Video call" : "📞 Voice call";
}

/** The dated strip label: "Today", "Yesterday", or a short weekday/date. */
export function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/* ------------------------------------------------------------------ tokenize */

// Non-global source: each `tokenizeBody` call builds its own lastIndex-free scan,
// so reusing a module-level /g regex (which carries `lastIndex` between `.exec`
// calls) can never mis-detect a link on a re-render.
const URL_SOURCE = String.raw`https?:\/\/[^\s<>"]+`;
const MENTION_SOURCE = String.raw`@[A-Za-z0-9_][A-Za-z0-9_.]{1,30}`;
const HASHTAG_SOURCE = String.raw`#[A-Za-z0-9_][A-Za-z0-9_\-]{1,50}`;
const TOKEN_REGEX = new RegExp(`(${URL_SOURCE})|(${MENTION_SOURCE})|(${HASHTAG_SOURCE})`, "g");

export type BodyToken =
  | { type: "text"; value: string }
  | { type: "url"; value: string }
  | { type: "mention"; value: string }
  | { type: "hashtag"; value: string };

/**
 * Split a message body into ordered text/url/mention/hashtag tokens.
 *
 * The composer's renderer maps each token to the right element (a real anchor
 * for links, a highlight span for mentions/hashtags) without re-parsing on every
 * keystroke. `@handle`s and `#tag`s are matched after URLs so a link containing
 * an `@` or `#` is never chopped into a fake mention.
 */
export function tokenizeBody(body: string): BodyToken[] {
  const text = body ?? "";
  if (!text) return [];
  const tokens: BodyToken[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN_REGEX.lastIndex = 0;
  while ((match = TOKEN_REGEX.exec(text)) !== null) {
    if (match.index > last) tokens.push({ type: "text", value: text.slice(last, match.index) });
    if (match[1]) tokens.push({ type: "url", value: match[1] });
    else if (match[2]) tokens.push({ type: "mention", value: match[2] });
    else if (match[3]) tokens.push({ type: "hashtag", value: match[3] });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: "text", value: text.slice(last) });
  return tokens;
}

/** The distinct http(s) links in a body, first-seen order, for a preview card. */
export function extractUrls(body: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeBody(body)) {
    if (token.type === "url" && !seen.has(token.value)) seen.add(token.value);
  }
  return Array.from(seen);
}
