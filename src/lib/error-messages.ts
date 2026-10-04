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
const FORBIDDEN =
  "You don't have permission to do that. If it keeps happening, check your account.";
const CONFLICT = "That already exists. Try a different value and retry.";
const RATE_LIMIT = "You're doing that a bit too fast — wait a moment and try again.";

/**
 * Tokens our own database triggers raise (`raise exception 'SOME_TOKEN'`).
 * They are stable on purpose — a trigger must not care who is calling — but a
 * person has never seen one before, so every path that can hit it would
 * otherwise display the raw string. Add the sentence here once, and the toast,
 * the DM composer and the story reply all agree.
 */
const TRIGGER_TOKENS: Record<string, string> = {
  MESSAGE_REQUESTS_CLOSED:
    "They only accept messages from people they follow, so this thread stays closed.",
};

/** Signatures of an unintentional, technical message (env names, PG errors, codes). */
const TECHNICAL =
  /environment variable|[A-Z][A-Z0-9_]{2,}_(URL|KEY|SECRET|TOKEN|PEPPER)|api[_ -]?key|not configured|missing (required )?(secret|env|variable)|permission denied|row[- ]level security|violates .*constraint|duplicate key|_unique|unique constraint|is not unique|does not exist|foreign key|not-null|relation .*exists|\b(?:pg|pgrst)[ _-]|postgrest|syntax error|invalid json|unexpected token|cannot read|cannot destructure|is not a function|undefined is not|null is not|renegotiat|stack overflow|internal server error|\bhttp status \d{3}\b/i;

/**
 * The shortest honest rendering of a caught value's message. For `catch (err:
 * unknown)` sites that used to read `err.message` off an `any` — same output,
 * no `any`. Lives here (side-effect-free) rather than in `error-capture.ts`,
 * whose module load patches `console.error` for the server error pipeline.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message ?? "");
  }
  return "";
}

export function friendlyError(err: unknown, fallback: string = GENERIC): string {
  let msg = "";
  if (typeof err === "string") msg = err;
  else if (err instanceof Error) msg = err.message;
  else if (err && typeof err === "object" && "message" in err)
    msg = String((err as { message?: unknown }).message ?? "");
  msg = msg.trim();
  if (!msg) return fallback;

  // A trigger token is an exact, known string — translate it before anything
  // else gets to decide it looks technical.
  const token = TRIGGER_TOKENS[msg.toUpperCase()];
  if (token) return token;

  // Zod throws with a JSON array of issues as its message — never show that
  // raw payload; surface the first human-written issue message instead.
  if (msg.startsWith("[") || msg.startsWith("{")) {
    try {
      const parsed = JSON.parse(msg);
      const issues = Array.isArray(parsed) ? parsed : parsed?.issues;
      if (Array.isArray(issues) && issues.length > 0) {
        console.error("[friendlyError] validation payload:", msg);
        const first = (issues[0] as { message?: unknown }).message;
        const human =
          typeof first === "string" && first && !TECHNICAL.test(first) ? first : fallback;
        return issues.length > 1
          ? `${human} (+${issues.length - 1} more check${issues.length - 1 > 1 ? "es" : ""})`
          : human;
      }
      return fallback;
    } catch {
      /* Not JSON after all — keep the message on the normal path. */
    }
  }

  const m = msg.toLowerCase();
  if (
    /failed to fetch|networkerror|network request failed|err_network|error connecting|timed? ?out/.test(
      m,
    )
  )
    return OFFLINE;
  if (/rate limit|too many requests|slow down/.test(m)) return RATE_LIMIT;
  if (/permission denied|row-level security|not authorized|authorization/.test(m)) return FORBIDDEN;
  if (/duplicate key|unique constraint|is not unique|already exists/.test(m)) return CONFLICT;
  if (/environment variable|not configured|missing secret|\.dev\.vars/i.test(msg))
    return UNAVAILABLE;
  if (TECHNICAL.test(msg)) {
    // Keep the real cause findable by developers without showing it to users.
    console.error("[friendlyError] technical message hidden from UI:", msg);
    return fallback;
  }
  return msg; // Already written for humans.
}
