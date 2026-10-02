import "./lib/error-capture";

// Mirror .env / .dev.vars into process.env before anything reads server env.
// The standalone node-server (`npm start`) otherwise boots with no Supabase
// credentials, which breaks the media proxy (404 images) and every
// service-role call. Real shell env always wins, so this is a no-op in prod.
import { loadRuntimeEnv } from "./lib/runtime-env.server";

loadRuntimeEnv();

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { withSecurityHeaders } from "./lib/security-headers.server";
import { startFeedWorker } from "./lib/feed-worker.server";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// Serve the "For you" feed as a precomputed timeline read; ranking happens on
// this timer, never inside a request. Guarded to start once per process and
// unref()'d so it can't keep the process alive on its own.
startFeedWorker();

// A returning, signed-in visitor who types the bare domain wants their feed,
// not the marketing page — but SSR can't read the client's session storage. The
// Supabase auth cookie is the one server-visible hint, so use it to skip the
// landing page (and its hydrate-then-navigate round trip) for the / entrypoint.
// This is a HINT only: an expired cookie just lands on /feed, which renders
// correctly for guests via auth-state. Guests have no cookie → marketing stays.
function hasAuthCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.startsWith("sb-") && name.includes("auth-token") && value && value !== "null") {
      return true;
    }
  }
  return false;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // Fast, safe redirect for the signed-in landing hop (see above).
      if (request.method === "GET") {
        const url = new URL(request.url);
        if (url.pathname === "/" && hasAuthCookie(request)) {
          return withSecurityHeaders(
            new Response(null, { status: 302, headers: { location: "/feed" } }),
          );
        }
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return withSecurityHeaders(await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return withSecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
  },
};
