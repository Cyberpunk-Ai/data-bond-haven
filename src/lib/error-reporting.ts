/**
 * Neutral client-side error hook.
 *
 * The app's root error boundary calls this when a render/loader throws. It
 * keeps the app decoupled from any specific vendor: wire `reportError` to your
 * observability provider (Sentry, OpenTelemetry, etc.) here without touching
 * call sites.
 */

type ErrorContext = Record<string, unknown>;

export function reportError(error: unknown, context: ErrorContext = {}): void {
  if (typeof window === "undefined") return;

  // Loaders and server functions commonly throw a raw Response; String(it) is
  // the opaque "[object Response]", so pull out the status and URL instead.
  const message =
    error instanceof Response
      ? `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error("[app:error]", message, {
    route: window.location.pathname,
    ...(stack !== undefined && { stack }),
    ...context,
  });
}
