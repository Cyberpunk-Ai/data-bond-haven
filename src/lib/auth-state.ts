import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { ensureMyProfile } from "@/lib/profile.functions";
import {
  currentUser,
  rowToProfile,
  setCurrentUser,
  subscribeProfiles,
} from "@/lib/profile-service";
import type { Profile } from "@/lib/types";

let loadedOnce = false;
// A fresh mount of useAuth (a page navigation is enough) plus every
// onAuthStateChange event used to fire a full getUser()+profiles round-trip —
// a burst of ~20 duplicate requests per session. Serialise through one
// in-flight promise and treat a recent completion as fresh enough.
let lastLoadAt = 0;
let inFlight: Promise<void> | null = null;
const AUTH_LOAD_TTL_MS = 15_000;

function loadSessionProfileOnce(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = loadSessionProfile().finally(() => {
    lastLoadAt = Date.now();
    inFlight = null;
  });
  return inFlight;
}

async function loadSessionProfile() {
  try {
    const { data } = await supabase.auth.getUser();
    const authUser = data.user;
    if (authUser) {
      let { data: row } = await supabase
        .from("profiles")
        .select("*")
        .eq("auth_user_id", authUser.id)
        .maybeSingle();

      if (!row) {
        try {
          await ensureMyProfile({ data: {} });
          const retry = await supabase
            .from("profiles")
            .select("*")
            .eq("auth_user_id", authUser.id)
            .maybeSingle();
          row = retry.data;
        } catch (err) {
          console.error("Could not create profile", err);
        }
      }

      if (row) {
        const profile = rowToProfile(row as Record<string, unknown>);
        profile.email = authUser.email ?? undefined;
        setCurrentUser(profile);
        return;
      }
    }
  } catch (err) {
    console.warn("Supabase auth session check notice:", err);
  }

  // No verified session: sign the visitor out locally too.
  setCurrentUser(null);
}

/** Merge partial changes into the in-memory session profile (and persist them). */
export function updateUserSession(patch: Partial<Profile>) {
  const next = { ...currentUser, ...patch } as Profile;
  setCurrentUser(next);

  if (
    next.id &&
    next.id !== "guest" &&
    !next.id.startsWith("local_") &&
    !next.id.startsWith("google_")
  ) {
    void supabase
      .from("profiles")
      .update({
        display_name: next.display_name,
        bio: next.bio,
        location: next.location,
        website: next.website,
        avatar_url: next.avatar_url,
      })
      .eq("id", next.id);
  }
}

/** Adopt a freshly authenticated profile into the in-memory session. */
export function setLoggedIn(profile: Profile) {
  setCurrentUser(profile);
}

/** Clear the session and reset the in-memory profile to guest. */
export function setLoggedOut() {
  try {
    void supabase.auth.signOut();
  } catch {}
  setCurrentUser(null);
}

export function useAuth() {
  const [user, setUser] = useState<Profile | null>(currentUser.id === "guest" ? null : currentUser);
  const [loading, setLoading] = useState(!loadedOnce);

  useEffect(() => {
    let active = true;

    const sync = () => {
      if (!active) return;
      setUser(currentUser.id === "guest" ? null : currentUser);
    };

    const unsubscribe = subscribeProfiles(sync);

    if (!loadedOnce) {
      loadedOnce = true;
      void loadSessionProfileOnce().finally(() => {
        if (active) setLoading(false);
      });
    } else {
      setLoading(false);
      sync();
      // Cold-start events (INITIAL_SESSION, late USER_UPDATED) can arrive
      // before the first load resolves; refetching here would duplicate it.
      if (Date.now() - lastLoadAt > AUTH_LOAD_TTL_MS) void loadSessionProfileOnce();
    }

    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      // Sign-in/sign-out genuinely change the identity — always reload; the
      // in-flight dedupe keeps N subscribers from firing N parallel fetches.
      void loadSessionProfileOnce();
    });

    return () => {
      active = false;
      unsubscribe();
      sub.subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    setLoggedOut();
  }

  return {
    user,
    loading,
    isAuthenticated: !!user,
    isLoggedIn: !!user,
    signOut,
    logout: signOut,
  };
}
