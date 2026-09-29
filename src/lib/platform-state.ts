/**
 * Live view of the Core Platform feature toggles, for the UI.
 *
 * Enforcement never depends on this file — the database guards and the server
 * functions refuse a disabled subsystem even if a client claims otherwise. What
 * lives here is the *presentation* half: a banner instead of a mystery error, a
 * greyed-out button instead of a failed request.
 *
 * One read per app (not per component), refreshed by two feeds so a published
 * toggle lands on every open tab immediately: the admin console's
 * `settings:updated` broadcast, and the `system_settings` change feed, which
 * also reaches signed-out visitors.
 */
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_SETTINGS, getPublicSettings } from "@/lib/api-client";
import type { SystemSettings } from "@/lib/types";

interface PlatformState {
  settings: SystemSettings;
  /** Signed-in account holds admin or moderator — exempt from Maintenance Mode. */
  isStaff: boolean;
  loaded: boolean;
}

let state: PlatformState = {
  settings: DEFAULT_SETTINGS,
  isStaff: false,
  loaded: false,
};

const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function patch(next: Partial<PlatformState>) {
  state = { ...state, ...next };
  notify();
}

let inFlight: Promise<void> | null = null;
let lastLoadAt = 0;
let feeding = false;
const LOAD_TTL_MS = 20_000;

async function loadStaffStatus() {
  try {
    const { data } = await supabase.auth.getSession();
    const authUserId = data.session?.user.id;
    if (!authUserId) {
      patch({ isStaff: false });
      return;
    }
    // Staff-ness is the account's real role, read through its own-row policy.
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", authUserId)
      .in("role", ["admin", "moderator"]);
    patch({ isStaff: (roles?.length ?? 0) > 0 });
  } catch {
    patch({ isStaff: false });
  }
}

async function refresh(): Promise<void> {
  try {
    const settings = await getPublicSettings();
    patch({ settings, loaded: true });
  } catch (err) {
    console.warn("[platform] could not read feature toggles:", err);
    patch({ loaded: true });
  }
  await loadStaffStatus();
  lastLoadAt = Date.now();
}

/** Opens the two feeds once, then lets pushes keep the state current. */
function ensureFeeds() {
  if (feeding || typeof window === "undefined") return;
  feeding = true;

  // The console's own broadcast: same-tab and signed-in peers, zero latency.
  window.addEventListener("rt:settings:updated", (e) => {
    const incoming = (e as CustomEvent).detail as Partial<SystemSettings> | undefined;
    if (!incoming) return;
    patch({
      settings: {
        ...state.settings,
        ...incoming,
        announcement_banner: {
          ...state.settings.announcement_banner,
          ...(incoming.announcement_banner ?? {}),
        },
      },
    });
  });

  // The database change feed also reaches guests, who never join the app bus.
  supabase
    .channel("platform-settings")
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "system_settings" }, () => {
      lastLoadAt = 0;
      void refresh();
    })
    .subscribe();

  supabase.auth.onAuthStateChange(() => {
    // Staff-ness is per-account: recheck on sign-in/sign-out.
    void loadStaffStatus();
  });
}

/** Fetch the toggles if they are unknown or stale. Safe to call from anywhere. */
export function ensurePlatformLoaded(force = false): Promise<void> {
  ensureFeeds();
  if (!force && state.loaded && Date.now() - lastLoadAt < LOAD_TTL_MS) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = refresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Reactive view of the toggles; also kicks the first load off. */
export function usePlatform() {
  const [snapshot, setSnapshot] = useState<PlatformState>(state);

  useEffect(() => {
    const sync = () => setSnapshot(state);
    listeners.add(sync);
    sync();
    void ensurePlatformLoaded();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const { settings, isStaff } = snapshot;
  return {
    settings,
    loaded: snapshot.loaded,
    isStaff,
    /** Non-staff visitors may not act while the platform is under maintenance. */
    maintenanceBlocked: settings.maintenance_mode && !isStaff,
    maintenanceActive: settings.maintenance_mode,
    registrationOpen: settings.registration_enabled && !settings.maintenance_mode,
    aiEnabled: settings.ai_generation_enabled,
    spacesEnabled: settings.spaces_audio_enabled,
    storiesEnabled: settings.stories_enabled,
    refresh: () => ensurePlatformLoaded(true),
  };
}

/** Non-hook read for imperative call sites (form submit handlers). */
export function readPlatformState(): PlatformState {
  return state;
}
