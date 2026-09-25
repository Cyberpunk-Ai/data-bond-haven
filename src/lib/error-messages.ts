/**
 * One place to turn raw/technical failures into words a person can act on.
 *
 * Server functions, Supabase and the DB can surface messages like
 * "Missing required environment variable X", "duplicate key value violates
 * unique constraint" or "permission denied for table Y". Those are useful in
 * logs but mean nothing (and leak internals) in the UI. Pass every message
 * that would reach a toast/dialog through `friendlyError()` first: intentional
 * friendly messages pass through untouched; anything technical is replaced by
 * a graceful equivalent (and logged to the console for debugging).
 */

const GENERIC = "Something didn't work on our end. Please try again.";
const OFFLINE = "You seem to be offline. Check your connection and try again.";
const UNAVAILABLE = "This feature is temporarily unavailable. Please try again shortly.";
const FORBIDDEN = "You don't have permission to do that. If it keeps happening, check your account.";
const CONFLICT = "That already exists. Try a different value and retry.";
const RATE_LIMIT = "You're doing that a bit too fast — wait a moment and try again.";

/** Signatures of an unintentional, technical message (env names, PG errors, codes). */
const TECHNICAL =
  /environment variable|[A-Z][A-Z0-9_]{2,}_(URL|KEY|SECRET|TOKEN|PEPPER)|api[_ -]?key|not configured|missing (required )?(secret|env|variable)|permission denied|row[- ]level security|violates .*constraint|duplicate key|_unique|unique constraint|is not unique|does not exist|foreign key|not-null|relation .*exists|\b(?:pg|pgrst)[ _-]|postgrest|syntax error|invalid json|unexpected token|cannot read|cannot destructure|is not a function|undefined is not|null is not|renegotiat|stack overflow|internal server error|\bhttp status \d{3}\b/i;

export function friendlyError(err: unknown, fallback: string = GENERIC): string {
  let msg = "";
  if (typeof err === "string") msg = err;
  else if (err instanceof Error) msg = err.message;
  else if (err && typeof err === "object" && "message" in err)
    msg = String((err as { message?: unknown }).message ?? "");
  msg = msg.trim();
  if (!msg) return fallback;

  const m = msg.toLowerCase();
  if (/failed to fetch|networkerror|network request failed|err_network|error connecting|timed? ?out/.test(m))
    return OFFLINE;
  if (/rate limit|too many requests|slow down/.test(m)) return RATE_LIMIT;
  if (/permission denied|row-level security|not authorized|authorization/.test(m)) return FORBIDDEN;
  if (/duplicate key|unique constraint|is not unique|already exists/.test(m)) return CONFLICT;
  if (/environment variable|not configured|missing secret|\.dev\.vars/i.test(msg)) return UNAVAILABLE;
  if (TECHNICAL.test(msg)) {
    // Keep the real cause findable by developers without showing it to users.
    console.error("[friendlyError] technical message hidden from UI:", msg);
    return fallback;
  }
  return msg; // Already written for humans.
}
