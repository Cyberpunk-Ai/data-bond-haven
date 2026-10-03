import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { signedInProfileId } from "@/lib/remote-store";
import { getPreferences } from "@/lib/preferences-state";

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

/**
 * Is this device allowed to broadcast its own presence right now?
 * "Hide activity status" is honoured publisher-side: the account still reads
 * everyone else's state, it just never announces itself.
 */
function presenceHidden(): boolean {
  return Boolean(getPreferences().toggles["hide_activity"]);
}

/** Joins the shared "who's online" presence channel once per app session. */
export function ensurePresenceJoined() {
  const me = signedInProfileId();
  if (!me || typeof window === "undefined") return () => {};
  refCount++;
  if (!channel) {
    channel = supabase.channel("presence-online", { config: { presence: { key: me } } });
    channel.on("presence", { event: "sync" }, rebuild).subscribe(async (status) => {
      if (status === "SUBSCRIBED" && !presenceHidden()) {
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

/**
 * Apply the "Hide activity status" switch live (settings page) so flipping it
 * takes effect without a reload: untrack stops others seeing this device as
 * online; track announces it again.
 */
export function setPresenceHidden(hidden: boolean) {
  if (!channel) return;
  if (hidden) {
    void channel.untrack();
  } else {
    void channel.track({ online_at: new Date().toISOString() });
  }
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
