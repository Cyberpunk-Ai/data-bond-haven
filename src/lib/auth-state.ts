import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { appConfig } from "@/lib/config";
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

const RESTRICTION_KEY = "spaces:restricted_reason";

/** Persist a lock-out reason so the auth screen can explain a ban after sign-out. */
function setRestrictedReason(reason: string) {
  try {
    sessionStorage.setItem(RESTRICTION_KEY, reason);
  } catch {
    /* non-browser */
  }
}

/** Read and clear any stored lock-out reason (shown once on the auth screen). */
export function consumeRestrictedReason(): string | null {
  try {
    const value = sessionStorage.getItem(RESTRICTION_KEY);
    if (value) sessionStorage.removeItem(RESTRICTION_KEY);
    return value;
  } catch {
    return null;
  }
}

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

        // An admin ban must actually lock the affected member out, not just flag
        // the row: their next session check signs them straight back out and we
        // stash a reason the auth screen can surface. Suspensions stay signed-in
        // (the in-app notification tells them) but are write-blocked by RLS.
        if (profile.status === "banned") {
          setRestrictedReason(
            `Your account has been banned for violating the ${appConfig.brand.name} Community Guidelines.`,
          );
          // signOut() returns a promise: wrapped in `void`, a rejection sailed past
          // the try/catch as an unhandled error while the token stayed in storage.
          void supabase.auth.signOut().catch((err) => {
            console.warn("sign-out after ban failed:", err);
          });
          setCurrentUser(null);
          return;
        }

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

/** Merge partial changes into the in-memory session profile.
 *
 * Deliberately memory-only. Every field this used to re-write straight to
 * `profiles` was a second, unvalidated copy of what `updateUserProfile` already
 * persisted for the same save — no username checks, no error handling, and it
 * could stamp a stale value over a change the server had just normalized.
 * Persist through `updateUserProfile`, then mirror it here. */
export function updateUserSession(patch: Partial<Profile>) {
  const next = { ...currentUser, ...patch } as Profile;
  setCurrentUser(next);
}

/** Clear the session and reset the in-memory profile to guest. */
export function setLoggedOut() {
  void supabase.auth.signOut().catch((err) => {
    // The local session is dropped either way; a stale token is cleared on the
    // next session check, so log rather than trap.
    console.warn("sign-out request failed:", err);
  });
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
