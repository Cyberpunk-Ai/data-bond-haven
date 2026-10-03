import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import type { Profile } from "@/lib/types";

export const GUEST_PROFILE: Profile = {
  id: "guest",
  username: "guest",
  display_name: "Guest",
  bio: "",
  avatar_url: null,
  location: "",
  website: "",
  followers: 0,
  following: 0,
  verified: false,
  plan: "free",
  role: "user",
  status: "active",
  warning_count: 0,
};

/**
 * Live binding to the signed-in profile. Updated by auth-state whenever the
 * session changes so plain (non-hook) call sites stay in sync.
 */
export let currentUser: Profile = GUEST_PROFILE;
export let currentUserId: string = GUEST_PROFILE.id;

const profileCache = new Map<string, Profile>();

const inflight = new Map<string, Promise<Profile | null>>();
const listeners = new Set<() => void>();
/**
 * When each key was last asked for. A cache miss used to be permanent: the
 * caller got a stand-in built out of the id itself, so a screen printed a raw
 * UUID where a name belongs. Now a miss also schedules a read, and this map is
 * what keeps a still-missing row (deleted account, offline) from re-requesting
 * it on every render.
 */
const readAttempts = new Map<string, number>();
const READ_RETRY_MS = 60_000;

function notify() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore listener failures */
    }
  });
}

export function subscribeProfiles(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setCurrentUser(profile: Profile | null) {
  currentUser = profile ?? GUEST_PROFILE;
  currentUserId = currentUser.id;
  if (profile) {
    profileCache.set(profile.id, profile);
    profileCache.set(profile.username, profile);
  }
  notify();
}

export function cacheProfiles(rows: Profile[]) {
  let changed = false;
  for (const row of rows) {
    if (!row?.id) continue;
    profileCache.set(row.id, row);
    if (row.username) profileCache.set(row.username, row);
    changed = true;
  }
  if (changed) notify();
}

/**
 * Compatibility view over the profile cache: a plain-object style registry
 * (`profileRegistry[id]`) backed by the live cache, used by list/search UIs.
 */
export const profileRegistry: Record<string, Profile> = new Proxy(
  {},
  {
    get: (_t, key: string) => profileCache.get(key),
    has: (_t, key: string) => profileCache.has(key as string),
    ownKeys: () => Array.from(profileCache.keys()),
    getOwnPropertyDescriptor: (_t, key: string) =>
      profileCache.has(key)
        ? { enumerable: true, configurable: true, value: profileCache.get(key) }
        : undefined,
  },
) as Record<string, Profile>;

/**
 * The identity half of a profile we have not read yet. Deliberately empty:
 * `display_name` and `username` are what a screen shows, and inventing them out
 * of the id is the bug this module had — "Guest" for the signed-in user and a
 * UUID for anybody else, both flashing before the fetch landed. A waiting row
 * carries the real `id` (so keys, links and follow checks keep working) and no
 * name at all, which `isProfilePending` turns into a skeleton.
 */
function pendingProfile(idOrUsername: string): Profile {
  return { ...GUEST_PROFILE, id: idOrUsername, username: "", display_name: "" };
}

/** True while a profile is only an id: show a loading state, not a name. */
export function isProfilePending(profile: Profile | null | undefined): boolean {
  if (!profile) return true;
  if (profile.id === "guest") return false;
  return !profile.display_name.trim() && !profile.username.trim();
}

/**
 * The cached row for this id or username, or null. Never fabricates: callers
 * that can render a loading state should use this instead of `getProfile`.
 * A miss starts one read per key per minute; `fetchProfile` dedupes races and
 * `notify()` repaints subscribers when the row lands.
 */
export function findProfile(idOrUsername?: string | null): Profile | null {
  if (!idOrUsername || idOrUsername === "guest") return null;
  const hit = profileCache.get(idOrUsername);
  if (hit) return hit;
  // Only in the browser: this runs during render, and a server render must not
  // open a request for a component that will never repaint.
  if (typeof document === "undefined") return null;
  const last = readAttempts.get(idOrUsername) ?? 0;
  if (Date.now() - last < READ_RETRY_MS) return null;
  readAttempts.set(idOrUsername, Date.now());
  void fetchProfile(idOrUsername).catch(() => null);
  return null;
}

export function getProfile(idOrUsername?: string | null): Profile {
  if (!idOrUsername || idOrUsername === "guest") return GUEST_PROFILE;
  return findProfile(idOrUsername) ?? pendingProfile(idOrUsername);
}

export function rowToProfile(row: Record<string, unknown>): Profile {
  return {
    id: String(row["id"] ?? ""),
    username: String(row["username"] ?? "unknown"),
    display_name: String(row["display_name"] ?? row["username"] ?? "Unknown"),
    bio: String(row["bio"] ?? ""),
    avatar_url: (row["avatar_url"] as string | null) ?? null,
    location: String(row["location"] ?? ""),
    website: String(row["website"] ?? ""),
    followers: Number(row["followers"] ?? 0),
    following: Number(row["following"] ?? 0),
    verified: Boolean(row["verified"]),
    plan: (row["plan"] as Profile["plan"]) ?? "free",
    status: (row["status"] as Profile["status"]) ?? "active",
    warning_count: Number(row["warning_count"] ?? 0),
    joined_at: (row["created_at"] as string | undefined) ?? undefined,
    last_active: (row["last_active"] as string | undefined) ?? undefined,
  };
}

export async function fetchProfile(id: string): Promise<Profile | null> {
  if (!id || id === "guest") return null;
  const cached = profileCache.get(id);
  if (cached) return cached;

  if (inflight.has(id)) return inflight.get(id)!;

  const promise = (async () => {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      // Only UUIDs are valid row ids; anything else is looked up by username.
      const filter = isUuid ? `id.eq.${id},username.eq.${id}` : `username.eq.${id}`;
      const { data: row } = await supabase.from("profiles").select("*").or(filter).maybeSingle();

      if (row) {
        const profile = rowToProfile(row as Record<string, unknown>);
        profileCache.set(profile.id, profile);
        profileCache.set(profile.username, profile);
        notify();
        return profile;
      }
    } catch (err) {
      console.warn("fetchProfile notice:", err);
    }

    return null;
  })().finally(() => {
    inflight.delete(id);
  });

  inflight.set(id, promise);
  return promise;
}

export function useProfile(idOrUsername?: string | null) {
  const [profile, setProfile] = useState<Profile | null>(() =>
    idOrUsername ? (profileCache.get(idOrUsername) ?? null) : null,
  );
  const [loading, setLoading] = useState<boolean>(!profile && !!idOrUsername);

  useEffect(() => {
    if (!idOrUsername || idOrUsername === "guest") {
      setProfile(null);
      setLoading(false);
      return;
    }

    const cached = profileCache.get(idOrUsername);
    if (cached) {
      setProfile(cached);
      setLoading(false);
    }

    let active = true;
    void fetchProfile(idOrUsername).then((p) => {
      if (active) {
        setProfile(p);
        setLoading(false);
      }
    });

    const unsubscribe = subscribeProfiles(() => {
      if (active) {
        const updated = profileCache.get(idOrUsername);
        if (updated) setProfile(updated);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [idOrUsername]);

  return { profile, loading };
}

export function useProfiles(idsOrUsernames: string[]) {
  const [profiles, setProfiles] = useState<Record<string, Profile>>(() => {
    const res: Record<string, Profile> = {};
    for (const id of idsOrUsernames) {
      const p = profileCache.get(id);
      if (p) res[id] = p;
    }
    return res;
  });

  useEffect(() => {
    let active = true;
    for (const id of idsOrUsernames) {
      if (!profileCache.has(id)) {
        void fetchProfile(id);
      }
    }

    const sync = () => {
      if (!active) return;
      const res: Record<string, Profile> = {};
      for (const id of idsOrUsernames) {
        const p = profileCache.get(id);
        if (p) res[id] = p;
      }
      setProfiles(res);
    };

    const unsubscribe = subscribeProfiles(sync);
    sync();

    return () => {
      active = false;
      unsubscribe();
    };
  }, [idsOrUsernames.join(",")]);

  return profiles;
}
