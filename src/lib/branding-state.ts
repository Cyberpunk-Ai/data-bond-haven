import { useEffect, useState } from "react";

import { attachRemoteRecord } from "@/lib/remote-store";

export type AuraThemeId = "aurora" | "sunset" | "ocean" | "forest" | "royal" | "mono";

export interface AuraTheme {
  id: AuraThemeId;
  name: string;
  gradient: string;
  borderClass: string;
  glowClass: string;
  badgeBg: string;
}

export const BRANDING_THEMES: Record<AuraThemeId, AuraTheme> = {
  aurora: {
    id: "aurora",
    name: "Aurora",
    gradient: "from-violet-500 via-fuchsia-500 to-pink-500",
    borderClass: "border-violet-500/50",
    glowClass: "shadow-[0_0_35px_-12px_rgb(139_92_246/0.7)]",
    badgeBg: "bg-violet-500/20 text-violet-700 dark:text-violet-200",
  },
  sunset: {
    id: "sunset",
    name: "Sunset",
    gradient: "from-amber-500 via-orange-500 to-rose-500",
    borderClass: "border-orange-500/50",
    glowClass: "shadow-[0_0_35px_-12px_rgb(249_115_22/0.7)]",
    badgeBg: "bg-orange-500/20 text-orange-700 dark:text-orange-200",
  },
  ocean: {
    id: "ocean",
    name: "Ocean",
    gradient: "from-sky-500 via-cyan-500 to-blue-600",
    borderClass: "border-cyan-500/50",
    glowClass: "shadow-[0_0_35px_-12px_rgb(6_182_212/0.7)]",
    badgeBg: "bg-cyan-500/20 text-cyan-700 dark:text-cyan-200",
  },
  forest: {
    id: "forest",
    name: "Forest",
    gradient: "from-emerald-500 via-green-500 to-teal-600",
    borderClass: "border-emerald-500/50",
    glowClass: "shadow-[0_0_35px_-12px_rgb(16_185_129/0.7)]",
    badgeBg: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200",
  },
  royal: {
    id: "royal",
    name: "Royal Gold",
    gradient: "from-yellow-400 via-amber-500 to-yellow-600",
    borderClass: "border-amber-500/50",
    glowClass: "shadow-[0_0_35px_-12px_rgb(245_158_11/0.7)]",
    badgeBg: "bg-amber-500/20 text-amber-800 dark:text-amber-200",
  },
  mono: {
    id: "mono",
    name: "Monochrome",
    gradient: "from-zinc-600 via-zinc-500 to-zinc-700",
    borderClass: "border-zinc-500/50",
    glowClass: "shadow-[0_0_35px_-12px_rgb(113_113_122/0.7)]",
    badgeBg: "bg-zinc-500/20 text-zinc-700 dark:text-zinc-200",
  },
};

export interface BrandingState {
  themeId: AuraThemeId;
  tagline: string;
  showAuraOnPosts: boolean;
}

const DEFAULTS: BrandingState = { themeId: "aurora", tagline: "", showAuraOnPosts: true };

// Branding is stored per account in the database; the browser only mirrors it.
let state: BrandingState = DEFAULTS;
const listeners = new Set<() => void>();

const remote = attachRemoteRecord<BrandingState>({
  table: "branding_settings",
  fromRow: (row) => ({
    themeId: (row.theme ?? "aurora") as AuraThemeId,
    tagline: row.tagline ?? "",
    showAuraOnPosts: Boolean(row.post_aura),
  }),
  toRow: (s) => ({ theme: s.themeId, tagline: s.tagline, post_aura: s.showAuraOnPosts }),
  apply: (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  },
});

export function useBranding() {
  const [branding, setBranding] = useState<BrandingState>(state);

  useEffect(() => {
    const sync = () => setBranding(state);
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  function updateBranding(patch: Partial<BrandingState>) {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
    remote.push(state);
  }

  return {
    branding,
    activeTheme: BRANDING_THEMES[branding.themeId] ?? BRANDING_THEMES.aurora,
    updateBranding,
  };
}
