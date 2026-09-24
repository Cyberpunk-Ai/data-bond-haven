import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { signedInProfileId } from "@/lib/remote-store";

type PresenceEntry = { online: boolean; lastSeen: string };
type PresenceState = Record<string, PresenceEntry>;

let currentState: PresenceState = {};
const listeners = new Set<(s: PresenceState) => void>();
let channel: ReturnType<typeof supabase.channel> | null = null;
let refCount = 0;

function publish(next: PresenceState) {
  currentState = next;
  listeners.forEach((fn) => fn(currentState));
}

function rebuild() {
  if (!channel) return;
  const state = channel.presenceState() as Record<string, Array<{ online_at?: string }>>;
  const merged: PresenceState = { ...currentState };
  for (const key of Object.keys(merged)) merged[key] = { ...merged[key], online: false };
  for (const key of Object.keys(state)) {
    const at = state[key]?.[0]?.online_at || new Date().toISOString();
    merged[key] = { online: true, lastSeen: at };
  }
  publish(merged);
}

/** Joins the shared "who's online" presence channel once per app session. */
export function ensurePresenceJoined() {
  const me = signedInProfileId();
  if (!me || typeof window === "undefined") return () => {};
  refCount++;
  if (!channel) {
    channel = supabase.channel("presence-online", { config: { presence: { key: me } } });
    channel.on("presence", { event: "sync" }, rebuild).subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel?.track({ online_at: new Date().toISOString() });
      }
    });
  }
  return () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && channel) {
      const stale = { ...currentState };
      if (stale[me]) stale[me] = { online: false, lastSeen: new Date().toISOString() };
      publish(stale);
      supabase.removeChannel(channel);
      channel = null;
    }
  };
}

/** Live map of profileId -> { online, lastSeen } sourced from Supabase Presence. */
export function usePresenceMap(): PresenceState {
  const [state, setState] = useState<PresenceState>(currentState);
  useEffect(() => {
    const leave = ensurePresenceJoined();
    listeners.add(setState);
    setState(currentState);
    return () => {
      listeners.delete(setState);
      leave();
    };
  }, []);
  return state;
}
