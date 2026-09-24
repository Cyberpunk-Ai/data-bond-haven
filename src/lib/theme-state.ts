import { useState, useEffect, useCallback } from "react";

import {
  getPreferences,
  getPreferencesStatus,
  savePreferences,
  subscribePreferences,
} from "@/lib/preferences-state";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAccent = "violet" | "amber" | "emerald" | "rose" | "indigo";

export interface AccentDefinition {
  id: ThemeAccent;
  name: string;
  gradientClass: string;
  brand: string;
  brandPink: string;
  brandOrange: string;
}

export const ACCENT_PALETTES: Record<ThemeAccent, AccentDefinition> = {
  violet: {
    id: "violet",
    name: "Violet & Magenta",
    gradientClass: "from-violet-500 to-fuchsia-500",
    brand: "oklch(0.541 0.281 293.009)",
    brandPink: "oklch(0.656 0.241 354.308)",
    brandOrange: "oklch(0.705 0.213 47.604)",
  },
  amber: {
    id: "amber",
    name: "Golden Amber",
    gradientClass: "from-amber-500 to-rose-500",
    brand: "oklch(0.66 0.21 55)",
    brandPink: "oklch(0.62 0.22 35)",
    brandOrange: "oklch(0.75 0.18 65)",
  },
  emerald: {
    id: "emerald",
    name: "Emerald & Teal",
    gradientClass: "from-emerald-500 to-teal-500",
    brand: "oklch(0.62 0.19 155)",
    brandPink: "oklch(0.65 0.16 180)",
    brandOrange: "oklch(0.72 0.15 140)",
  },
  rose: {
    id: "rose",
    name: "Neon Rose",
    gradientClass: "from-pink-500 to-rose-600",
    brand: "oklch(0.58 0.24 15)",
    brandPink: "oklch(0.64 0.22 350)",
    brandOrange: "oklch(0.68 0.21 30)",
  },
  indigo: {
    id: "indigo",
    name: "Cosmic Indigo",
    gradientClass: "from-indigo-500 to-cyan-500",
    brand: "oklch(0.52 0.24 265)",
    brandPink: "oklch(0.60 0.22 290)",
    brandOrange: "oklch(0.65 0.18 220)",
  },
};

const THEME_STORAGE_KEY = "spaces_theme_mode";
const ACCENT_STORAGE_KEY = "spaces_accent_theme";
const MOTION_STORAGE_KEY = "spaces_reduce_motion";
const TEXT_STORAGE_KEY = "spaces_larger_text";
const THEME_CHANGE_EVENT = "spaces:theme-change";

export interface ThemeSettings {
  mode: ThemeMode;
  accent: ThemeAccent;
  reduceMotion: boolean;
  largerText: boolean;
}

/** Light is the default look; people can switch and the choice sticks. */
const DEFAULT_THEME: ThemeSettings = {
  mode: "light",
  accent: "violet",
  reduceMotion: false,
  largerText: false,
};

let inMemoryTheme: ThemeSettings = { ...DEFAULT_THEME };

// The signed-in account's preferences (backend) are the source of truth, but we
// also mirror the choice to localStorage so logged-out visitors keep their look
// across reloads and the correct theme applies before hydration.
function readPersistedTheme(): ThemeSettings {
  if (typeof window === "undefined") return { ...inMemoryTheme };
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { ...inMemoryTheme };
    const parsed = JSON.parse(raw) as Partial<ThemeSettings>;
    return {
      mode:
        parsed.mode === "light" || parsed.mode === "dark" || parsed.mode === "system"
          ? parsed.mode
          : inMemoryTheme.mode,
      accent: (parsed.accent && parsed.accent in ACCENT_PALETTES
        ? parsed.accent
        : inMemoryTheme.accent) as ThemeAccent,
      reduceMotion: Boolean(parsed.reduceMotion),
      largerText: Boolean(parsed.largerText),
    };
  } catch {
    return { ...inMemoryTheme };
  }
}

function persistTheme(settings: ThemeSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable (private mode / quota) — in-memory theme still applies */
  }
}

export function getStoredThemeSettings(): ThemeSettings {
  if (typeof window === "undefined") {
    return { ...DEFAULT_THEME };
  }
  inMemoryTheme = readPersistedTheme();
  return { ...inMemoryTheme };
}

export function applyThemeToDOM(settings: ThemeSettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // 1. Dark mode
  const isDark =
    settings.mode === "dark" ||
    (settings.mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (isDark) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }

  // 2. Accent color variables
  const palette = ACCENT_PALETTES[settings.accent] || ACCENT_PALETTES.violet;
  root.style.setProperty("--brand", palette.brand);
  root.style.setProperty("--brand-pink", palette.brandPink);
  root.style.setProperty("--brand-orange", palette.brandOrange);

  // 3. Reduced motion
  if (settings.reduceMotion) {
    root.classList.add("reduce-motion");
  } else {
    root.classList.remove("reduce-motion");
  }

  // 4. Larger text
  if (settings.largerText) {
    root.style.fontSize = "17.5px";
  } else {
    root.style.fontSize = "";
  }
}

export function useTheme() {
  // Start from the shared defaults so the server and first client render match,
  // then adopt the saved choice right after hydration.
  const [settings, setSettings] = useState<ThemeSettings>(() => ({ ...inMemoryTheme }));

  useEffect(() => {
    setSettings(getStoredThemeSettings());
  }, []);

  // The signed-in account's saved look wins over whatever this device cached,
  // so the same person sees their theme on every device.
  useEffect(() => {
    const adopt = () => {
      const { status } = getPreferencesStatus();
      if (status !== "ready") return;
      const prefs = getPreferences();
      const next: ThemeSettings = {
        mode:
          prefs.theme === "light" || prefs.theme === "dark" || prefs.theme === "system"
            ? (prefs.theme as ThemeMode)
            : DEFAULT_THEME.mode,
        accent: (prefs.accent in ACCENT_PALETTES
          ? prefs.accent
          : DEFAULT_THEME.accent) as ThemeAccent,
        reduceMotion: prefs.reduceMotion,
        largerText: prefs.largerText,
      };
      inMemoryTheme = next;
      persistTheme(next);
      applyThemeToDOM(next);
      setSettings(next);
    };
    adopt();
    return subscribePreferences(adopt);
  }, []);

  useEffect(() => {
    applyThemeToDOM(settings);

    const handleSystemChange = () => {
      if (settings.mode === "system") {
        applyThemeToDOM(settings);
      }
    };

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", handleSystemChange);

    const handleStorage = (e: StorageEvent) => {
      if (
        e.key === THEME_STORAGE_KEY ||
        e.key === ACCENT_STORAGE_KEY ||
        e.key === MOTION_STORAGE_KEY ||
        e.key === TEXT_STORAGE_KEY
      ) {
        const fresh = getStoredThemeSettings();
        setSettings(fresh);
        applyThemeToDOM(fresh);
      }
    };

    const handleCustomChange = () => {
      const fresh = getStoredThemeSettings();
      setSettings(fresh);
      applyThemeToDOM(fresh);
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(THEME_CHANGE_EVENT, handleCustomChange);

    return () => {
      mediaQuery.removeEventListener("change", handleSystemChange);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, handleCustomChange);
    };
  }, [settings]);

  const updateSettings = useCallback((partial: Partial<ThemeSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      inMemoryTheme = next;
      persistTheme(next);
      applyThemeToDOM(next);
      void savePreferences({
        theme: next.mode,
        accent: next.accent,
        reduceMotion: next.reduceMotion,
        largerText: next.largerText,
      });
      return next;
    });
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setSettings((prev) => {
      const isCurrentlyDark =
        prev.mode === "dark" ||
        (prev.mode === "system" &&
          typeof window !== "undefined" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);

      const nextMode: ThemeMode = isCurrentlyDark ? "light" : "dark";
      const next = { ...prev, mode: nextMode };
      inMemoryTheme = next;
      persistTheme(next);
      applyThemeToDOM(next);
      void savePreferences({ theme: next.mode });
      return next;
    });
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
    });
  }, []);

  const isDark =
    typeof window !== "undefined" &&
    (settings.mode === "dark" ||
      (settings.mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches));

  return {
    ...settings,
    isDark,
    setMode: (mode: ThemeMode) => updateSettings({ mode }),
    setAccent: (accent: ThemeAccent) => updateSettings({ accent }),
    setReduceMotion: (reduceMotion: boolean) => updateSettings({ reduceMotion }),
    setLargerText: (largerText: boolean) => updateSettings({ largerText }),
    toggleTheme,
  };
}

/**
 * Applied from the root component after hydration — running it at module scope
 * mutates <html> before React hydrates and causes an attribute mismatch.
 */
export function bootstrapTheme() {
  if (typeof window === "undefined") return;
  try {
    applyThemeToDOM(getStoredThemeSettings());
  } catch (e) {
    console.error("Theme initial apply error:", e);
  }
}
