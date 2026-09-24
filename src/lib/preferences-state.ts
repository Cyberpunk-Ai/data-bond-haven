/**
 * Per-account preferences (appearance, notifications, privacy, accessibility).
 * The signed-in account's row in `user_preferences` is the single source of
 * truth — nothing is kept in the browser as an account-specific copy, so two
 * people using the same device never see each other's choices.
 */
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { subscribeProfiles } from "@/lib/profile-service";
import { signedInProfileId } from "@/lib/remote-store";

const db = supabase as any;

export interface Preferences {
  theme: string;
  accent: string;
  reduceMotion: boolean;
  largerText: boolean;
  toggles: Record<string, boolean>;
}

export type PreferencesStatus = "idle" | "loading" | "ready" | "error";

const DEFAULTS: Preferences = {
  theme: "light",
  accent: "violet",
  reduceMotion: false,
  largerText: false,
  toggles: {},
};

let state: Preferences = { ...DEFAULTS };
let status: PreferencesStatus = "idle";
let errorMessage: string | null = null;
let loadedFor: string | null = null;

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((fn) => fn());
}

export function getPreferences(): Preferences {
  return state;
}

export function getPreferencesStatus() {
  return { status, errorMessage };
}

export function subscribePreferences(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Loads the signed-in account's saved preferences (once per account). */
export async function hydratePreferences(force = false) {
  const userId = signedInProfileId();
  if (!userId) {
    loadedFor = null;
    state = { ...DEFAULTS };
    status = "ready";
    errorMessage = null;
    emit();
    return;
  }
  if (!force && loadedFor === userId) return;
  loadedFor = userId;
  status = "loading";
  errorMessage = null;
  emit();

  const { data, error } = await db
    .from("user_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    status = "error";
    errorMessage = "We couldn't load your saved preferences. Check your connection and try again.";
    emit();
    return;
  }

  state = data
    ? {
        theme: (data.theme as string) || DEFAULTS.theme,
        accent: (data.accent as string) || DEFAULTS.accent,
        reduceMotion: !!data.reduce_motion,
        largerText: !!data.larger_text,
        toggles: ((data.prefs as any)?.toggles ?? {}) as Record<string, boolean>,
      }
    : { ...DEFAULTS };
  status = "ready";
  errorMessage = null;
  emit();
}

/** Applies a change instantly and writes it to the account. */
export async function savePreferences(
  patch: Partial<Preferences>,
): Promise<{ ok: boolean; error?: string }> {
  state = { ...state, ...patch };
  emit();

  const userId = signedInProfileId();
  if (!userId) return { ok: false, error: "Sign in to save this preference to your account." };

  const { error } = await db.from("user_preferences").upsert(
    {
      user_id: userId,
      theme: state.theme,
      accent: state.accent,
      reduce_motion: state.reduceMotion,
      larger_text: state.largerText,
      prefs: { toggles: state.toggles },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { ok: false, error: "That change didn't save. Please try again." };
  return { ok: true };
}

/** Flips a single on/off preference and saves it. */
export function setPreferenceToggle(key: string, value: boolean) {
  return savePreferences({ toggles: { ...state.toggles, [key]: value } });
}

if (typeof window !== "undefined") {
  void hydratePreferences();
  subscribeProfiles(() => void hydratePreferences());
}

/** React binding: re-renders whenever preferences load or change. */
export function usePreferences() {
  const [, force] = useState(0);
  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    listeners.add(rerender);
    void hydratePreferences();
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  return {
    preferences: state,
    status,
    error: errorMessage,
    loading: status === "loading" || status === "idle",
    toggle: (key: string, fallback = false) => state.toggles[key] ?? fallback,
    setToggle: setPreferenceToggle,
    save: savePreferences,
    reload: () => hydratePreferences(true),
  };
}
