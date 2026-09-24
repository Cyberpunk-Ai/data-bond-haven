import { useEffect, useRef } from "react";

import { supabase } from "@/integrations/supabase/client";

export type RealtimeHandlers = Record<string, (payload: any) => void>;

const CHANNEL_NAME = "spaces-app-events";

/**
 * One shared, always-subscribed broadcast channel. Creating a channel per
 * `emitRealtime` call meant `send()` fired before the socket was joined, so
 * nothing ever reached other clients.
 */
let sharedChannel: ReturnType<typeof supabase.channel> | null = null;
let channelReady = false;
const pending: Array<{ event: string; payload: any }> = [];

function getChannel() {
  if (typeof window === "undefined") return null;
  if (!sharedChannel) {
    sharedChannel = supabase.channel(CHANNEL_NAME, { config: { broadcast: { self: false } } });
    // Bridge every remote broadcast into local window events so all hooks
    // (including wildcard listeners) receive it exactly once.
    sharedChannel.on("broadcast", { event: "*" }, (msg: any) => {
      const event = msg?.event as string;
      const payload = msg?.payload;
      if (!event) return;
      window.dispatchEvent(new CustomEvent(`rt:${event}`, { detail: payload }));
      window.dispatchEvent(
        new CustomEvent("rt:*", {
          detail: {
            ...(payload && typeof payload === "object" ? payload : { payload }),
            type: event,
            event,
          },
        }),
      );
    });
    sharedChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        channelReady = true;
        while (pending.length > 0) {
          const next = pending.shift()!;
          void sharedChannel?.send({ type: "broadcast", event: next.event, payload: next.payload });
        }
      }
    });
  }
  return sharedChannel;
}

/** De-dupe guard: the same logical event may be emitted under alias names. */
const recentlyEmitted = new Map<string, number>();

function isDuplicate(event: string, payload: any) {
  try {
    const key = `${event}:${JSON.stringify(payload ?? null)}`;
    const now = Date.now();
    for (const [k, t] of recentlyEmitted) if (now - t > 3000) recentlyEmitted.delete(k);
    if (recentlyEmitted.has(key)) return true;
    recentlyEmitted.set(key, now);
    return false;
  } catch {
    return false;
  }
}

/**
 * Event bus backed by a Supabase broadcast channel with a local window-event
 * fallback so optimistic UI updates still propagate instantly.
 */
export function emitRealtime(event: string, payload: any) {
  if (typeof window === "undefined") return;
  if (isDuplicate(event, payload)) return;

  try {
    window.dispatchEvent(new CustomEvent(`rt:${event}`, { detail: payload }));
    window.dispatchEvent(
      new CustomEvent("rt:*", {
        detail: {
          ...(payload && typeof payload === "object" ? payload : { payload }),
          type: event,
          event,
        },
      }),
    );
  } catch {
    /* non-browser */
  }

  // Private rows reach their intended recipients through database change
  // feeds (filtered by access rules), never through the public broadcast.
  if (DB_DELIVERED.has(event)) return;

  const channel = getChannel();
  if (!channel) return;
  if (channelReady) void channel.send({ type: "broadcast", event, payload });
  else pending.push({ event, payload });
}

const DB_DELIVERED = new Set(["message:created", "space:message"]);

function dispatchLocal(event: string, payload: any) {
  window.dispatchEvent(new CustomEvent(`rt:${event}`, { detail: payload }));
  window.dispatchEvent(new CustomEvent("rt:*", { detail: { ...payload, type: event, event } }));
}

let authHooked = false;
let dbChannel: ReturnType<typeof supabase.channel> | null = null;

/** Subscribes once to database inserts; access rules decide who receives them. */
function ensureDbFeed() {
  if (typeof window === "undefined" || dbChannel) return;
  dbChannel = supabase
    .channel("db-feed")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p: any) => {
      const row = p.new;
      if (row?.id) dispatchLocal("message:created", { message: row, ...row });
    })
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "space_messages" },
      (p: any) => {
        const row = p.new;
        if (!row?.id) return;
        dispatchLocal("space:message", {
          spaceId: row.space_id,
          message: { id: row.id, userId: row.user_id, body: row.body, spaceId: row.space_id },
        });
      },
    )
    .subscribe();
  // Rejoin with the user's token after sign-in so access rules apply.
  if (authHooked) return;
  authHooked = true;
  supabase.auth.onAuthStateChange((event) => {
    if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
    const old = dbChannel;
    dbChannel = null;
    if (old) void supabase.removeChannel(old).then(() => ensureDbFeed());
  });
}

export function useRealtime(
  handlers: RealtimeHandlers | ((payload: any) => void),
  deps: unknown[] = [],
) {
  const normalized: RealtimeHandlers =
    typeof handlers === "function" ? { "*": handlers } : handlers;
  const ref = useRef(normalized);
  ref.current = normalized;

  useEffect(() => {
    const events = Object.keys(ref.current);
    if (events.length === 0) return;

    const localListeners = events.map((event) => {
      const listener = (e: Event) => ref.current[event]?.((e as CustomEvent).detail);
      window.addEventListener(`rt:${event}`, listener);
      return { event, listener };
    });

    // Remote broadcasts arrive through the shared channel bridge, which
    // re-dispatches them as the same local window events.
    getChannel();
    ensureDbFeed();

    return () => {
      for (const { event, listener } of localListeners) {
        window.removeEventListener(`rt:${event}`, listener);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
